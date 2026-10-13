#!/usr/bin/env python3
"""Offline privacy/workflow contracts for legacy Studio browser QA."""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any, Callable, cast
import unittest

ROOT = Path(__file__).resolve().parents[1]
DESIGN_PATH = ROOT / "scripts" / "test_design_browser.py"
DASHBOARD_PATH = ROOT / "scripts" / "test_dashboard_browser.py"
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "studio-browser-qa.yml"


def load_design_privacy_namespace() -> dict[str, Any]:
    tree = ast.parse(DESIGN_PATH.read_text(encoding="utf-8"))
    wanted_assignments = {"REPORT_ALLOWED_KEYS", "URL_MARKERS"}
    wanted_functions = {
        "diagnostic_category",
        "failure_category",
        "privacy_safe_inspection",
        "assert_privacy_safe_report",
        "capture_privacy_safe_screenshot",
    }
    nodes: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in wanted_assignments
            for target in node.targets
        ):
            nodes.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in wanted_functions:
            nodes.append(node)
    namespace: dict[str, Any] = {"Page": object, "Path": Path}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<design privacy helpers>", "exec"), namespace)
    return namespace


PRIVACY = load_design_privacy_namespace()


def privacy_function(name: str) -> Callable[..., Any]:
    return cast(Callable[..., Any], PRIVACY[name])


class FakeMask:
    def __init__(self, *, count: int = 1, visible: bool = True):
        self._count = count
        self._visible = visible

    def count(self) -> int:
        return self._count

    def is_visible(self) -> bool:
        return self._visible


class FakePage:
    def __init__(self, mask: FakeMask):
        self.mask = mask
        self.selector: str | None = None
        self.screenshot_kwargs: dict[str, object] | None = None

    def locator(self, selector: str) -> FakeMask:
        self.selector = selector
        return self.mask

    def screenshot(self, **kwargs: object) -> None:
        self.screenshot_kwargs = kwargs


class PrivacySchemaTests(unittest.TestCase):
    def test_dom_inspection_is_metadata_only(self) -> None:
        sentinel = "LEARNER_SENTINEL_9471"
        raw = {
            "lang": "es",
            "dataTheme": "paper",
            "colorScheme": "light",
            "viewport": {"width": 390, "height": 844},
            "document": {"scrollWidth": 390, "scrollHeight": 1200},
            "horizontalOverflow": True,
            "overflowers": [
                {
                    "tag": "section",
                    "left": -2,
                    "right": 392,
                    "width": 394,
                    "selector": f"#{sentinel}",
                    "text": sentinel,
                    "url": f"https://learner.invalid/{sentinel}",
                }
            ],
            "navigationLinks": {"count": 4, "visibleCount": 3, "currentPageCount": 1},
            "themeToggleCount": 1,
            "bodyTextPreview": sentinel,
            "title": sentinel,
        }
        sanitized = privacy_function("privacy_safe_inspection")(raw)
        serialized = json.dumps(sanitized)
        self.assertNotIn(sentinel, serialized)
        self.assertNotIn("learner.invalid", serialized)
        privacy_function("assert_privacy_safe_report")({"inspection": sanitized})

    def test_diagnostics_are_categorized_without_raw_content(self) -> None:
        sentinel = "LEARNER_SENTINEL_9471 https://learner.invalid/private"
        self.assertEqual(privacy_function("diagnostic_category")(sentinel), "unexpected")
        self.assertEqual(privacy_function("failure_category")(sentinel), "other")
        self.assertNotIn("LEARNER_SENTINEL", privacy_function("diagnostic_category")(sentinel))
        self.assertNotIn("learner.invalid", privacy_function("failure_category")(sentinel))

    def test_schema_rejects_unknown_sensitive_fields_and_url_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "privacy-unsafe report key"):
            privacy_function("assert_privacy_safe_report")({"url": "redacted"})
        with self.assertRaisesRegex(ValueError, "privacy-unsafe URL value"):
            privacy_function("assert_privacy_safe_report")({"target": "https://learner.invalid/private"})

    def test_screenshot_masks_the_unique_visible_main_region(self) -> None:
        page = FakePage(FakeMask())
        result = privacy_function("capture_privacy_safe_screenshot")(page, Path("masked.png"))
        self.assertEqual(page.selector, "main#main-content")
        self.assertEqual(result, {"mask_scope": "main-content", "mask_count": 1})
        screenshot_kwargs = page.screenshot_kwargs
        self.assertIsNotNone(screenshot_kwargs)
        assert screenshot_kwargs is not None
        self.assertEqual(screenshot_kwargs["mask"], [page.mask])
        self.assertEqual(screenshot_kwargs["mask_color"], "#111827")
        self.assertFalse(screenshot_kwargs["full_page"])

    def test_screenshot_fails_closed_without_unique_visible_mask(self) -> None:
        for mask in (FakeMask(count=0), FakeMask(count=2), FakeMask(visible=False)):
            with self.subTest(count=mask.count(), visible=mask.is_visible()):
                page = FakePage(mask)
                with self.assertRaisesRegex(RuntimeError, "privacy mask target"):
                    privacy_function("capture_privacy_safe_screenshot")(page, Path("unsafe.png"))
                self.assertIsNone(page.screenshot_kwargs)

    def test_live_report_is_validated_before_write(self) -> None:
        source = DESIGN_PATH.read_text(encoding="utf-8")
        validation = source.rindex("assert_privacy_safe_report(report)")
        write = source.rindex("report_path.write_text")
        self.assertLess(validation, write)
        inspect_node = next(
            node
            for node in ast.parse(source).body
            if isinstance(node, ast.FunctionDef) and node.name == "inspect_page"
        )
        inspect_source = ast.get_source_segment(source, inspect_node) or ""
        for forbidden in ("bodyTextPreview", "document.title", "textContent", "element.id", "className"):
            self.assertNotIn(forbidden, inspect_source)


class WorkflowArtifactTests(unittest.TestCase):
    ALLOWED_UPLOAD_PATHS = {
        "/tmp/studio-results/verb-selector-${{ matrix.browser }}",
        "/tmp/studio-results/dashboard-light",
        "/tmp/studio-results/dashboard-dark",
        "/tmp/studio-results/topics-${{ matrix.browser }}",
        "/tmp/studio-results/bilingual-${{ matrix.browser }}",
        "/tmp/studio-results/capture",
    }

    def setUp(self) -> None:
        self.workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

    def upload_paths(self) -> list[str]:
        lines = self.workflow.splitlines()
        upload_index = next(
            index for index, line in enumerate(lines) if "uses: actions/upload-artifact@" in line
        )
        path_index = next(
            index
            for index in range(upload_index, len(lines))
            if lines[index].strip() == "path: |"
        )
        path_indent = len(lines[path_index]) - len(lines[path_index].lstrip())
        paths: list[str] = []
        for line in lines[path_index + 1 :]:
            if not line.strip():
                continue
            indent = len(line) - len(line.lstrip())
            if indent <= path_indent:
                break
            value = line.strip()
            if value.startswith("/tmp/"):
                paths.append(value)
        return paths

    def test_upload_is_exact_synthetic_allowlist(self) -> None:
        paths = self.upload_paths()
        self.assertEqual(set(paths), self.ALLOWED_UPLOAD_PATHS)
        self.assertEqual(len(paths), len(self.ALLOWED_UPLOAD_PATHS))
        self.assertNotIn("/tmp/studio-results", paths)
        self.assertFalse(any("studio-private" in path or "live-design" in path for path in paths))
        self.assertIn("if-no-files-found: error", self.workflow)

    def test_live_design_output_is_separate_and_never_public(self) -> None:
        private_output = "--output /tmp/studio-private/live-design-${{ matrix.browser }}"
        self.assertEqual(self.workflow.count(private_output), 2)
        self.assertNotIn("--output /tmp/studio-results/${{ matrix.browser }}", self.workflow)
        self.assertIn("python3 scripts/test_studio_qa_safety.py", self.workflow)

    def test_allowlisted_outputs_have_fixture_isolation_contracts(self) -> None:
        producer_contracts = {
            "test_verb_selector_browser.py": (
                "fixture-only browser regression harness",
                "This is fixture-only preview QA",
                'page.route("**/*", self.handle)',
            ),
            "test_dashboard_browser.py": (
                "intercepted with local fixtures",
                "intentionally restricted to a localhost preview origin",
                "attach_fixture_router(page, scenario, log)",
            ),
            "test_practice_topics_browser.py": (
                "synthetic fixtures",
                "fixture_apis",
                "context.route('**/*',guard)",
            ),
            "test_curation_translation_browser.py": (
                "Every API request is intercepted",
                "attach_fixtures(page, base, evidence)",
                'page.route("**/*", handle)',
            ),
            "test_capture_browser.py": (
                "Synthetic microphone, fixture APIs",
                "is_fixture_api =",
                "context.route('**/*',guard)",
            ),
        }
        for filename, required_tokens in producer_contracts.items():
            with self.subTest(filename=filename):
                source = (ROOT / "scripts" / filename).read_text(encoding="utf-8")
                for token in required_tokens:
                    self.assertIn(token, source)

    def test_keyboard_contract_covers_both_actions_with_a_bound(self) -> None:
        source = DASHBOARD_PATH.read_text(encoding="utf-8")
        self.assertIn('"keyboard.shadowing-focus-visible"', source)
        self.assertIn('focused_control("#today-shadow")', source)
        self.assertIn('focused_control(".daily-primary-action")', source)
        tree = ast.parse(source)
        limit = next(
            ast.literal_eval(node.value)
            for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "PRIMARY_ACTION_TAB_LIMIT" for target in node.targets)
        )
        self.assertGreaterEqual(limit, 2)
        self.assertLessEqual(limit, 6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
