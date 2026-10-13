#!/usr/bin/env python3
"""Focused offline tests for live shadowing harness evidence/privacy."""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HARNESS_PATH = ROOT / "scripts" / "test_shadowing_browser.py"
SPEC = importlib.util.spec_from_file_location("shadowing_browser_harness", HARNESS_PATH)
assert SPEC and SPEC.loader
HARNESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HARNESS)


class LiveEvidenceTests(unittest.TestCase):
    def test_selected_media_get_uses_exact_url_not_resource_type(self) -> None:
        selected = "https://api-spanish.tonymuzo.dev/api/media/private-token.wav?private=1"
        router = HARNESS.LiveRouter("https://spanish-app.tonymuzo.dev")
        router.reads = [
            {
                "method": "GET",
                "_url": selected,
                "resource_type": "other",
                "host": "api-spanish.tonymuzo.dev",
            },
            {
                "method": "GET",
                "_url": "https://spanish-app.tonymuzo.dev/_astro/app.js",
                "resource_type": "script",
                "host": "spanish-app.tonymuzo.dev",
            },
        ]
        evidence = router.selected_media_evidence(
            selected,
            [
                {
                    "method": "GET",
                    "_url": selected,
                    "status": 206,
                    "content_type": "audio/mpeg",
                }
            ],
            [{"initiator_type": "other", "duration_positive": True}],
        )

        self.assertEqual(evidence["exact_selected_get_count"], 1)
        self.assertEqual(evidence["route_resource_types"], ["other"])
        self.assertEqual(evidence["successful_response_count"], 1)
        self.assertEqual(evidence["media_content_type_count"], 1)
        self.assertEqual(evidence["performance_completed_count"], 1)
        serialized = json.dumps(evidence)
        self.assertNotIn("private-token", serialized)
        self.assertNotIn("private=1", serialized)

    def test_live_runtime_diagnostics_never_emit_raw_console_or_media_url(self) -> None:
        selected = "https://api-spanish.tonymuzo.dev/api/media/private-token.wav?private=1"
        secret_console = (
            "Fetch API cannot load https://spanish-app.tonymuzo.dev/cdn-cgi/rum "
            "due to access control checks. PRIVATE_LEARNER_TEXT"
        )
        raw = {
            "console": [
                {
                    "type": "error",
                    "text": secret_console,
                    "location": {
                        "url": "https://static.cloudflareinsights.com/beacon.min.js/version"
                    },
                }
            ],
            "page_errors": [],
            "request_failures": [
                {
                    "page_lifetime": "shadow-playback-exit",
                    "method": "GET",
                    "path": "/api/media/private-token.wav",
                    "host": "api-spanish.tonymuzo.dev",
                    "_url": selected,
                    "resource_type": "other",
                    "is_navigation_request": False,
                    "observed_at": 11.0,
                    "failure": "Load request cancelled",
                }
            ],
            "http_errors": [
                {
                    "page_lifetime": "shadow-playback-exit",
                    "method": "GET",
                    "path": "/api/media/private-token.wav",
                    "host": "api-spanish.tonymuzo.dev",
                    "_url": selected,
                    "resource_type": "other",
                    "is_navigation_request": False,
                    "observed_at": 10.5,
                    "status": 404,
                    "content_type": "text/plain",
                }
            ],
            "responses": [],
        }
        runtime, counts = HARNESS.public_runtime(
            raw,
            "live_read_only",
            live=True,
            live_context={
                "base_netloc": "spanish-app.tonymuzo.dev",
                "selected_media_url": selected,
                "selected_media_proven_success": True,
                "exit_page_lifetime": "shadow-playback-exit",
                "exit_started_at": 10.0,
                "exit_completed_at": 11.2,
            },
        )

        serialized = json.dumps(runtime)
        self.assertEqual(counts["unexpected_console"], 0)
        self.assertEqual(counts["unexpected_request_failures"], 0)
        self.assertEqual(counts["unexpected_http_errors"], 1)
        self.assertNotIn("PRIVATE_LEARNER_TEXT", serialized)
        self.assertNotIn("private-token", serialized)
        self.assertNotIn("private=1", serialized)
        console_diagnostic = runtime["console"][0]["diagnostic"]
        self.assertEqual(
            runtime["console"][0]["classification"],
            "exact blocked Cloudflare RUM URL reported by browser console",
        )
        self.assertEqual(console_diagnostic["location_relation"], "exact-cloudflare-beacon")
        self.assertEqual(console_diagnostic["referenced_url_relations"], ["exact-cloudflare-rum"])
        self.assertIn("fetch-api-cannot-load", console_diagnostic["message_features"])
        request_diagnostic = runtime["request_failures"][0]["diagnostic"]
        self.assertEqual(
            runtime["request_failures"][0]["classification"],
            "exact proven selected-media GET cancelled by explicit exit navigation",
        )
        self.assertEqual(request_diagnostic["url_relation"], "exact-selected-media")
        self.assertEqual(request_diagnostic["failure_kind"], "exact-cancellation")
        self.assertEqual(request_diagnostic["page_lifetime"], "shadow-playback-exit")
        self.assertTrue(request_diagnostic["during_exit_navigation"])

    def test_live_cancellation_allowance_is_relational_and_fail_closed(self) -> None:
        selected = "https://api-spanish.tonymuzo.dev/api/media/private-token.wav?private=1"
        base_item = {
            "page_lifetime": "shadow-playback-exit",
            "method": "GET",
            "path": "/api/media/private-token.wav",
            "host": "api-spanish.tonymuzo.dev",
            "_url": selected,
            "resource_type": "other",
            "is_navigation_request": False,
            "observed_at": 11.0,
            "failure": "net::ERR_ABORTED",
        }
        context = {
            "base_netloc": "spanish-app.tonymuzo.dev",
            "selected_media_url": selected,
            "selected_media_proven_success": True,
            "exit_page_lifetime": "shadow-playback-exit",
            "exit_started_at": 10.0,
            "exit_completed_at": 11.2,
        }
        self.assertIsNotNone(
            HARNESS.request_failure_expected_reason(base_item, "live_read_only", context)
        )
        cases = [
            ({**base_item, "observed_at": 9.0}, context),
            (
                {
                    **base_item,
                    "path": "/shadow/",
                    "_url": "https://spanish-app.tonymuzo.dev/shadow/",
                },
                context,
            ),
            (base_item, {**context, "selected_media_proven_success": False}),
            (base_item, {**context, "selected_media_url": selected + "-different"}),
            ({**base_item, "page_lifetime": "today-entry"}, context),
        ]
        for item, changed_context in cases:
            with self.subTest(item=item, context=changed_context):
                self.assertIsNone(
                    HARNESS.request_failure_expected_reason(
                        item, "live_read_only", changed_context
                    )
                )

    def test_navigation_cancellation_allowances_require_exact_target_success(self) -> None:
        context = {
            "base_netloc": "spanish-app.tonymuzo.dev",
            "today_document_proven_success": True,
            "shadow_document_proven_success": True,
            "shadow_navigation_page_lifetime": "combined-today-shadow",
            "shadow_navigation_started_at": 4.0,
            "shadow_navigation_completed_at": 6.0,
            "exit_page_lifetime": "combined-today-shadow",
            "exit_started_at": 10.0,
            "exit_completed_at": 11.2,
            "exit_target_proven_success": True,
        }
        stats_item = {
            "page_lifetime": "combined-today-shadow",
            "method": "GET",
            "path": "/api/stats",
            "host": "api-spanish.tonymuzo.dev",
            "_url": "https://api-spanish.tonymuzo.dev/api/stats",
            "resource_type": "fetch",
            "is_navigation_request": False,
            "observed_at": 5.0,
            "failure": "Load request cancelled",
        }
        today_item = {
            "page_lifetime": "combined-today-shadow",
            "method": "GET",
            "path": "/",
            "host": "spanish-app.tonymuzo.dev",
            "_url": "https://spanish-app.tonymuzo.dev/",
            "resource_type": "other",
            "is_navigation_request": False,
            "observed_at": 11.0,
            "failure": "net::ERR_ABORTED",
        }
        self.assertIsNotNone(
            HARNESS.request_failure_expected_reason(stats_item, "live_read_only", context)
        )
        self.assertIsNotNone(
            HARNESS.request_failure_expected_reason(today_item, "live_read_only", context)
        )
        rejected = [
            ({**stats_item, "_url": "https://api-spanish.tonymuzo.dev/api/cards"}, context),
            ({**stats_item, "resource_type": "xhr"}, context),
            ({**stats_item, "observed_at": 7.0}, context),
            ({**stats_item, "page_lifetime": "other-page"}, context),
            (stats_item, {**context, "shadow_document_proven_success": False}),
            ({**today_item, "observed_at": 9.0}, context),
            ({**today_item, "resource_type": "document"}, context),
            ({**today_item, "page_lifetime": "other-page"}, context),
            (today_item, {**context, "exit_target_proven_success": False}),
        ]
        for item, changed_context in rejected:
            with self.subTest(item=item, context=changed_context):
                self.assertIsNone(
                    HARNESS.request_failure_expected_reason(
                        item, "live_read_only", changed_context
                    )
                )

    def test_today_entry_cancellation_allowance_requires_exact_proven_click(self) -> None:
        context = {
            "base_netloc": "spanish-app.tonymuzo.dev",
            "today_document_proven_success": True,
            "today_entry_click_proven_success": True,
            "today_entry_page_lifetime": "today-entry",
            "today_entry_started_at": 4.0,
            "today_entry_completed_at": 6.0,
        }
        item = {
            "page_lifetime": "today-entry",
            "method": "GET",
            "path": "/shadow/",
            "host": "spanish-app.tonymuzo.dev",
            "_url": "https://spanish-app.tonymuzo.dev/shadow/",
            "resource_type": "other",
            "is_navigation_request": False,
            "observed_at": 5.0,
            "failure": "Load request cancelled",
        }
        self.assertEqual(
            HARNESS.request_failure_expected_reason(item, "live_read_only", context),
            "exact Shadow document GET cancelled during proven Today entry click",
        )
        rejected = [
            ({**item, "observed_at": 7.0}, context),
            ({**item, "resource_type": "document"}, context),
            ({**item, "is_navigation_request": True}, context),
            ({**item, "page_lifetime": "other-page"}, context),
            ({**item, "_url": "https://spanish-app.tonymuzo.dev/_astro/app.js"}, context),
            (item, {**context, "today_document_proven_success": False}),
            (item, {**context, "today_entry_click_proven_success": False}),
        ]
        for changed_item, changed_context in rejected:
            with self.subTest(item=changed_item, context=changed_context):
                self.assertIsNone(
                    HARNESS.request_failure_expected_reason(
                        changed_item, "live_read_only", changed_context
                    )
                )

    def test_runtime_clean_requires_observations_from_both_page_lifetimes(self) -> None:
        class StubRouter:
            mutation_attempts: list[dict[str, str]] = []
            api_get_count = 1
            media_get_count = 1

            @staticmethod
            def evidence() -> dict[str, int]:
                return {"mutation_attempt_count": 0}

        selected = {
            "exact_selected_get_count": 1,
            "successful_response_count": 1,
            "media_content_type_count": 1,
            "performance_entry_count": 1,
            "performance_completed_count": 1,
        }
        for labels, expected_pass in (
            (("today-entry", "shadow-playback-exit"), True),
            (("today-entry",), False),
        ):
            with self.subTest(labels=labels):
                run = {
                    "scenario": "live_read_only",
                    "selected_media_evidence": dict(selected),
                    "checks": [],
                }
                raw = {
                    "console": [],
                    "page_errors": [],
                    "request_failures": [],
                    "http_errors": [],
                    "responses": [{"page_lifetime": label} for label in labels],
                }
                HARNESS.finish_live_run(
                    run,
                    StubRouter(),
                    raw,
                    {"base_netloc": "spanish-app.tonymuzo.dev"},
                )
                runtime_check = next(
                    check for check in run["checks"] if check["id"] == "live.runtime-clean"
                )
                self.assertEqual(runtime_check["passed"], expected_pass)
                self.assertEqual(
                    runtime_check["actual"]["both_page_lifetimes_observed"],
                    expected_pass,
                )

    def test_live_entry_click_and_playback_use_separate_observed_pages(self) -> None:
        source = HARNESS_PATH.read_text(encoding="utf-8")
        live_run_source = source[
            source.index("def live_run(") : source.index("\ndef deadline_run(")
        ]

        self.assertIn('page_lifetime="today-entry"', source)
        self.assertIn('page_lifetime="shadow-playback-exit"', live_run_source)
        self.assertIn("document.readyState === 'complete'", live_run_source)
        self.assertIn("today_page.wait_for_timeout(750)", live_run_source)
        self.assertNotIn('today_page.wait_for_load_state("networkidle"', live_run_source)
        self.assertIn('live_context["today_entry_started_at"] = time.monotonic()', live_run_source)
        self.assertIn("today_entry.click()", live_run_source)
        self.assertIn(
            'today_page.get_by_role(\n            "region", name="Shadowing player", exact=True',
            live_run_source,
        )
        self.assertIn("wait_ready(today_page, timeout)", live_run_source)
        self.assertIn("shadow_response = page.goto(", live_run_source)
        self.assertNotIn("shadow_response = today_page.goto(", live_run_source)
        self.assertIn("both_page_lifetimes_observed", source)

    def test_workflow_live_artifact_allowlist_is_report_only(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "shadowing-qa.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("Live evidence must contain exactly report.json and report.md", workflow)
        self.assertIn("/tmp/shadow-results/report.json", workflow)
        self.assertIn("/tmp/shadow-results/report.md", workflow)
        self.assertIn("if: ${{ always() && inputs.live }}", workflow)
        self.assertNotIn("Live screenshots are explicitly private", HARNESS_PATH.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
