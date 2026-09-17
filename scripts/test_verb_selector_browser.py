#!/usr/bin/env python3
"""Bounded fixture-only browser regression harness for the grouped /verbs selector.

Run this on the Alienware browser worker or CI, never on the VPS. The harness
accepts only a loopback preview origin, fulfills every ``/api/**`` request from
in-process fixtures, blocks service workers and cross-origin subresources, and
aborts every non-safe HTTP method. It is fixture QA, not live validation.

Examples (from ``frontend/``)::

    python3 scripts/test_verb_selector_browser.py \
      --base http://127.0.0.1:4321 \
      --output /tmp/verb-selector-qa

    python3 scripts/test_verb_selector_browser.py \
      --browser chromium --browser webkit \
      --base http://127.0.0.1:4321 \
      --output /tmp/verb-selector-qa

Omitting ``--browser`` runs both Chromium and WebKit. The preview server must
already be running; this script never starts an application or browser server.
"""

from __future__ import annotations

import argparse
import json
import re
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    from playwright.sync_api import Browser, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright
except ImportError as exc:  # pragma: no cover - exercised on the browser worker
    raise SystemExit(
        "Playwright for Python is required. Install it in the browser-worker environment "
        "and install the requested Chromium/WebKit browser binaries."
    ) from exc


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "src" / "data" / "generated" / "verbs.json"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
CORE_SPANISH_VERBS = tuple(
    "ser haber estar tener hacer poder decir ir ver dar saber querer llegar pasar "
    "deber poner parecer quedar creer hablar llevar dejar seguir encontrar llamar "
    "venir pensar salir volver tomar conocer vivir sentir tratar mirar contar empezar "
    "esperar buscar existir entrar trabajar escribir perder producir ocurrir entender "
    "pedir recibir recordar terminar permitir aparecer conseguir comenzar servir sacar "
    "necesitar mantener resultar".split()
)
COMPLETED_VERBS = frozenset({"ser", "volar"})

PROGRESS_FIXTURE: dict[str, Any] = {
    "items": [
        {
            "verb": "ser",
            "completed": 1,
            "full_pass_count": 7,
            "required_full_passes": 7,
            "total_assignments": 50,
        },
        {
            "verb": "volar",
            "completed": 1,
            "full_pass_count": 7,
            "required_full_passes": 7,
            "total_assignments": 50,
        },
        {
            "verb": "pagar",
            "completed": 0,
            "full_pass_count": 1,
            "required_full_passes": 7,
            "total_assignments": 50,
        },
    ]
}

DEVICES: dict[str, dict[str, Any]] = {
    "desktop": {
        "viewport": {"width": 1440, "height": 1000},
        "screen": {"width": 1440, "height": 1000},
        "device_scale_factor": 1,
        "has_touch": False,
        "is_mobile": False,
    },
    "mobile": {
        "viewport": {"width": 390, "height": 844},
        "screen": {"width": 390, "height": 844},
        "device_scale_factor": 1,
        "has_touch": True,
        "is_mobile": True,
        "user_agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
            "Mobile/15E148 Safari/604.1"
        ),
    },
}
THEMES = {"light": "paper", "dark": "dark"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fixture-only Chromium/WebKit regression tests for the grouped /verbs selector"
    )
    parser.add_argument(
        "--browser",
        dest="browsers",
        choices=("chromium", "webkit"),
        action="append",
        help="Browser engine; repeat to run both (default: chromium and webkit)",
    )
    parser.add_argument("--base", required=True, help="Loopback preview origin, e.g. http://127.0.0.1:4321")
    parser.add_argument("--output", required=True, type=Path, help="Directory for screenshots and report.json")
    parser.add_argument("--timeout", type=int, default=10_000, help="Per-operation timeout in milliseconds")
    parser.add_argument(
        "--max-seconds",
        type=int,
        default=270,
        help="Stop scheduling scenarios after this many seconds (default: 270; maximum: 295)",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> tuple[str, list[str]]:
    parsed = urlparse(args.base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit("--base must be an absolute HTTP(S) origin")
    if parsed.hostname not in LOOPBACK_HOSTS:
        raise SystemExit(
            "This is fixture-only preview QA: --base must use localhost, 127.0.0.1, or ::1. "
            "It must not be described or used as live validation."
        )
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise SystemExit("--base must be a bare loopback origin with no credentials, path, query, or fragment")
    if args.timeout < 1_000 or args.timeout > 30_000:
        raise SystemExit("--timeout must be between 1000 and 30000 milliseconds")
    if args.max_seconds < 30 or args.max_seconds > 295:
        raise SystemExit("--max-seconds must be between 30 and 295")
    browsers = list(dict.fromkeys(args.browsers or ["chromium", "webkit"]))
    return args.base.rstrip("/"), browsers


def refuse_vps_browser_launch() -> str:
    host = socket.gethostname()
    normalized = host.casefold()
    if "vps" in normalized or normalized == "hermes-vps":
        raise SystemExit(
            f"Refusing to launch Playwright on VPS host {host!r}. "
            "Run this harness on the Alienware browser worker or CI."
        )
    return host


def load_catalog() -> dict[str, Any]:
    if not CATALOG_PATH.is_file():
        raise SystemExit(f"Catalog fixture does not exist: {CATALOG_PATH}")
    try:
        catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Could not load catalog fixture {CATALOG_PATH}: {exc}") from exc
    entries = catalog.get("verbs")
    if not isinstance(entries, list):
        raise SystemExit(f"Catalog fixture has no verbs array: {CATALOG_PATH}")
    names = [entry.get("verb") for entry in entries if isinstance(entry, dict)]
    problems: list[str] = []
    if len(entries) != 224 or catalog.get("count") != 224:
        problems.append(f"expected 224 catalog verbs, got len={len(entries)}, count={catalog.get('count')!r}")
    if len(names) != len(entries) or any(not isinstance(name, str) or not name for name in names):
        problems.append("every catalog entry must have a non-empty string verb")
    if len(set(names)) != len(names):
        problems.append("catalog verb infinitives are not unique")
    missing_core = [verb for verb in CORE_SPANISH_VERBS if verb not in names]
    if len(CORE_SPANISH_VERBS) != 60 or missing_core:
        problems.append(f"Core 60 fixture mismatch; missing={missing_core!r}")
    missing_special = [verb for verb in ("volar", "pagar") if verb not in names]
    if missing_special:
        problems.append(f"required non-core fixture verbs missing: {missing_special!r}")
    if problems:
        raise SystemExit("Invalid catalog fixture: " + "; ".join(problems))
    return catalog


def json_response(route: Any, status: int, payload: Any) -> None:
    route.fulfill(
        status=status,
        content_type="application/json",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Cache-Control": "no-store",
        },
        body=json.dumps(payload, ensure_ascii=False),
    )


class FixtureRouter:
    """Page-local deterministic API router with a fail-closed mutation guard."""

    def __init__(self, scenario: str, catalog: dict[str, Any], base: str) -> None:
        self.scenario = scenario
        self.catalog = catalog
        self.base_netloc = urlparse(base).netloc
        self.requests: list[dict[str, Any]] = []
        self.api_requests: list[dict[str, Any]] = []
        self.unexpected_api_gets: list[dict[str, Any]] = []
        self.mutation_attempts: list[dict[str, Any]] = []
        self.blocked_external: list[dict[str, Any]] = []
        self.catalog_attempts = 0
        self.progress_attempts = 0
        self.held_progress_routes: list[Any] = []

    def install(self, page: Page) -> None:
        page.route("**/*", self.handle)

    def handle(self, route: Any) -> None:
        request = route.request
        method = request.method.upper()
        parsed = urlparse(request.url)
        record = {"method": method, "url": request.url, "path": parsed.path}
        self.requests.append(record)

        # This guard runs before every other routing decision. Any application
        # mutation is aborted and later makes the suite fail.
        if method not in SAFE_METHODS:
            self.mutation_attempts.append(record)
            route.abort("blockedbyclient")
            return

        if parsed.path == "/api" or parsed.path.startswith("/api/"):
            self.api_requests.append(record)
            if method == "OPTIONS":
                route.fulfill(
                    status=204,
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Headers": "*",
                        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                        "Cache-Control": "no-store",
                    },
                    body="",
                )
                return

            path = parsed.path.rstrip("/") or "/"
            query = parse_qs(parsed.query)
            if path == "/api/study/verbs":
                self.catalog_attempts += 1
                if self.scenario == "catalog_fallback":
                    json_response(route, 503, {"detail": "Fixture catalog unavailable"})
                else:
                    json_response(route, 200, self.catalog)
                return
            if path == "/api/study/verb-progress":
                self.progress_attempts += 1
                if self.scenario == "progress_retry" and self.progress_attempts == 1:
                    self.held_progress_routes.append(route)
                    return
                json_response(route, 200, PROGRESS_FIXTURE)
                return
            if path == "/api/study/verb-prompt-progress":
                json_response(route, 200, {"items": []})
                return
            if path == "/api/study/lesson-prompt-progress":
                json_response(route, 200, {"items": []})
                return
            if path == "/api/study/verb-usage-bank":
                verb = (query.get("verb") or [""])[0]
                batch_text = (query.get("batch") or ["1"])[0]
                try:
                    batch = int(batch_text)
                except ValueError:
                    batch = 1
                json_response(
                    route,
                    200,
                    {
                        "verb": verb,
                        "batch": batch,
                        "batch_size": 0,
                        "total_batches": 10,
                        "total_prompts": 0,
                        "status": "fixture-empty",
                        "prompts": [],
                    },
                )
                return
            if path == "/api/study/sentence-packs":
                json_response(route, 200, {"packs": []})
                return

            # Keep future read-only child components deterministic without
            # inventing records. Unknown API reads are visible in report.json.
            self.unexpected_api_gets.append(record)
            json_response(route, 200, {"items": [], "prompts": [], "packs": []})
            return

        # Disable Cloudflare analytics without contacting it. Other external
        # subresources are blocked so fixture runs do not depend on the network.
        if parsed.hostname == "static.cloudflareinsights.com" and parsed.path.startswith("/beacon.min.js"):
            route.fulfill(
                status=200,
                content_type="application/javascript",
                body="/* analytics disabled by fixture-only browser QA */",
            )
            return
        if parsed.netloc != self.base_netloc:
            self.blocked_external.append(record)
            route.abort("blockedbyclient")
            return
        route.continue_()

    def wait_for_held_progress(self, page: Page, timeout_ms: int) -> Any:
        deadline = time.monotonic() + timeout_ms / 1000
        while time.monotonic() < deadline:
            if self.held_progress_routes:
                return self.held_progress_routes.pop(0)
            page.wait_for_timeout(25)
        raise PlaywrightTimeoutError("The first /api/study/verb-progress fixture request was not observed")

    def network_evidence(self) -> dict[str, Any]:
        return {
            "api_requests": self.api_requests,
            "unexpected_api_gets": self.unexpected_api_gets,
            "mutation_attempts": self.mutation_attempts,
            "blocked_external": self.blocked_external,
            "catalog_attempts": self.catalog_attempts,
            "progress_attempts": self.progress_attempts,
        }


def new_run(browser_name: str, scenario: str, device: str, theme: str) -> dict[str, Any]:
    return {
        "browser": browser_name,
        "scenario": scenario,
        "device": device,
        "theme": theme,
        "checks": [],
    }


def add_check(
    run: dict[str, Any],
    check_id: str,
    passed: bool,
    *,
    expected: Any,
    actual: Any,
    detail: str = "",
) -> None:
    run["checks"].append(
        {
            "id": check_id,
            "passed": bool(passed),
            "expected": expected,
            "actual": actual,
            "detail": detail,
        }
    )


def attach_observers(page: Page, log: dict[str, list[Any]]) -> None:
    page.on(
        "console",
        lambda message: log["console"].append({"type": message.type, "text": message.text})
        if message.type in {"warning", "error"}
        else None,
    )
    page.on("pageerror", lambda error: log["page_errors"].append(str(error)))
    page.on(
        "requestfailed",
        lambda request: log["request_failures"].append(
            {"method": request.method, "url": request.url, "failure": request.failure}
        ),
    )


def create_page(
    browser: Browser,
    base: str,
    catalog: dict[str, Any],
    scenario: str,
    device: str,
    theme: str,
    timeout: int,
) -> tuple[Any, Page, FixtureRouter, dict[str, list[Any]]]:
    context = browser.new_context(**DEVICES[device], service_workers="block")
    context.add_init_script(
        """(() => {
          if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
          localStorage.setItem('atr-theme', THEME_VALUE);
          localStorage.setItem('atr.apiBaseUrl', location.origin);
          localStorage.removeItem('atr.activeApiBase');
          sessionStorage.clear();
        })();""".replace("THEME_VALUE", json.dumps(THEMES[theme])),
    )
    page = context.new_page()
    page.set_default_timeout(timeout)
    runtime_log: dict[str, list[Any]] = {"console": [], "page_errors": [], "request_failures": []}
    attach_observers(page, runtime_log)
    router = FixtureRouter(scenario, catalog, base)
    router.install(page)
    return context, page, router, runtime_log


def navigate_to_verbs(page: Page, base: str, timeout: int, run: dict[str, Any]) -> None:
    response = page.goto(base + "/verbs", wait_until="domcontentloaded", timeout=timeout)
    navigation = {"status": response.status if response else None, "url": page.url}
    run["navigation"] = navigation
    add_check(
        run,
        "navigation.verbs-preview-loaded",
        response is not None and response.ok,
        expected="2xx response from loopback /verbs preview",
        actual=navigation,
    )


def selector_for(page: Page) -> Any:
    return page.get_by_role("combobox", name="Choose verb", exact=True)


def extract_group_state(selector: Any) -> list[dict[str, Any]]:
    return selector.evaluate(
        """(select) => Array.from(select.children)
          .filter((node) => node.tagName === 'OPTGROUP')
          .map((group) => ({
            label: group.label,
            values: Array.from(group.querySelectorAll('option')).map((option) => option.value),
            texts: Array.from(group.querySelectorAll('option')).map((option) => (option.textContent || '').trim()),
          }))"""
    )


def assert_group_contract(
    page: Page,
    run: dict[str, Any],
    catalog: dict[str, Any],
    *,
    expect_enabled: bool,
) -> None:
    heading = page.get_by_role("heading", name="Your Core 60", exact=True)
    curriculum = page.locator(".verb-curriculum")
    selector = selector_for(page)
    heading.wait_for(state="visible")
    selector.wait_for(state="visible")

    add_check(
        run,
        "contract.curriculum-wrapper",
        curriculum.count() == 1 and curriculum.is_visible(),
        expected="one visible .verb-curriculum",
        actual={"count": curriculum.count(), "visible": curriculum.is_visible() if curriculum.count() else False},
    )
    add_check(
        run,
        "contract.selector-ready-state",
        selector.is_enabled() is expect_enabled,
        expected="enabled" if expect_enabled else "disabled",
        actual="enabled" if selector.is_enabled() else "disabled",
        detail="Choose verb must not be enabled until saved progress is ready.",
    )

    groups = extract_group_state(selector)
    run["groups"] = groups
    catalog_names = [entry["verb"] for entry in catalog["verbs"]]
    expected_core = [verb for verb in CORE_SPANISH_VERBS if verb not in COMPLETED_VERBS]
    expected_other = [
        verb for verb in catalog_names if verb not in COMPLETED_VERBS and verb not in CORE_SPANISH_VERBS
    ]
    expected_labels = [
        f"Completed / mastered ({len(COMPLETED_VERBS)})",
        f"Core 60 — still to master ({len(expected_core)})",
        f"Other verbs — later ({len(expected_other)})",
    ]
    actual_labels = [group["label"] for group in groups]
    add_check(
        run,
        "groups.labels-and-order",
        actual_labels == expected_labels,
        expected=expected_labels,
        actual=actual_labels,
    )

    completed_values = groups[0]["values"] if len(groups) > 0 else []
    core_values = groups[1]["values"] if len(groups) > 1 else []
    other_values = groups[2]["values"] if len(groups) > 2 else []
    add_check(
        run,
        "groups.completed-exclusive",
        len(completed_values) == 2 and set(completed_values) == COMPLETED_VERBS,
        expected="ser and volar exclusively",
        actual=completed_values,
    )
    add_check(
        run,
        "groups.remaining-core-exact-rank",
        core_values == expected_core,
        expected=expected_core,
        actual=core_values,
    )
    add_check(
        run,
        "groups.other-membership",
        other_values == expected_other and "pagar" in other_values,
        expected={"catalog_order": expected_other, "must_include": "pagar"},
        actual=other_values,
    )

    all_values = completed_values + core_values + other_values
    duplicates = sorted({value for value in all_values if all_values.count(value) > 1})
    add_check(
        run,
        "options.unique-complete-native-values",
        len(all_values) == 224 and len(set(all_values)) == 224 and set(all_values) == set(catalog_names),
        expected="224 unique native option values matching all fixture infinitives",
        actual={
            "count": len(all_values),
            "unique": len(set(all_values)),
            "duplicates": duplicates,
            "missing": sorted(set(catalog_names) - set(all_values)),
            "extra": sorted(set(all_values) - set(catalog_names)),
        },
    )
    summary_text = " ".join((curriculum.inner_text() or "").split()) if curriculum.count() else ""
    summary_ok = bool(re.search(r"\b1\s*(?:of|/)\s*60\b", summary_text, flags=re.IGNORECASE)) and bool(
        re.search(r"complet|master", summary_text, flags=re.IGNORECASE)
    )
    add_check(
        run,
        "summary.core60-progress",
        summary_ok,
        expected="visible Core 60 summary reporting 1 completed/mastered out of 60",
        actual=summary_text[:500],
    )


def inspect_layout(page: Page, selector: Any) -> dict[str, Any]:
    return page.evaluate(
        """(select) => {
          const root = document.documentElement;
          const body = document.body;
          const viewportWidth = root.clientWidth;
          const documentWidth = Math.max(root.scrollWidth, body?.scrollWidth || 0);
          const selectRect = select.getBoundingClientRect();
          const overflowers = Array.from(document.querySelectorAll('body *')).map((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return null;
            if (rect.left >= -1 && rect.right <= viewportWidth + 1) return null;
            return {
              tag: element.tagName.toLowerCase(),
              className: typeof element.className === 'string' ? element.className.split(/\\s+/).slice(0, 3).join('.') : '',
              text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
              left: Math.round(rect.left * 10) / 10,
              right: Math.round(rect.right * 10) / 10,
              width: Math.round(rect.width * 10) / 10,
            };
          }).filter(Boolean).slice(0, 15);
          return {
            viewport: {width: viewportWidth, height: root.clientHeight},
            document: {width: documentWidth, height: Math.max(root.scrollHeight, body?.scrollHeight || 0)},
            horizontalOverflow: documentWidth > viewportWidth + 1,
            overflowers,
            selectorTarget: {
              width: Math.round(selectRect.width * 10) / 10,
              height: Math.round(selectRect.height * 10) / 10,
            },
            dataTheme: root.dataset.theme || null,
          };
        }""",
        selector.element_handle(),
    )


def add_visual_checks(page: Page, run: dict[str, Any], theme: str) -> None:
    selector = selector_for(page)
    layout = inspect_layout(page, selector)
    run["layout"] = layout
    add_check(
        run,
        "layout.no-horizontal-overflow",
        not layout["horizontalOverflow"],
        expected="document width <= viewport width",
        actual={
            "viewport": layout["viewport"],
            "document": layout["document"],
            "overflowers": layout["overflowers"],
        },
    )
    target = layout["selectorTarget"]
    add_check(
        run,
        "a11y.selector-target-44px",
        target["width"] >= 44 and target["height"] >= 44,
        expected="Choose verb target at least 44x44 CSS px",
        actual=target,
    )
    add_check(
        run,
        "theme.requested-theme-applied",
        layout["dataTheme"] == THEMES[theme],
        expected=THEMES[theme],
        actual=layout["dataTheme"],
    )


def save_screenshot(page: Page, output: Path, run: dict[str, Any], suffix: str = "") -> None:
    stem = f"{run['browser']}--{run['scenario']}--{run['device']}--{run['theme']}"
    filename = f"{stem}{suffix}.png"
    page.screenshot(path=str(output / filename), full_page=False, animations="disabled")
    run.setdefault("screenshots", []).append(filename)


def exercise_selection_without_grading(
    page: Page,
    run: dict[str, Any],
    router: FixtureRouter,
    timeout: int,
) -> None:
    selector = selector_for(page)
    mutation_count_before = len(router.mutation_attempts)
    selector.select_option("haber")
    page.wait_for_function(
        "document.querySelector('select[aria-label=\"Choose verb\"]')?.value === 'haber' || "
        "Array.from(document.querySelectorAll('select')).some((s) => s.value === 'haber')",
        timeout=timeout,
    )
    heading = page.get_by_role("heading", name="Conjugation prompts", exact=True)
    heading.wait_for(state="visible", timeout=timeout)
    card = heading.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' card ')][1]")
    answer = card.locator("input:not([type='hidden'])").first
    answer.wait_for(state="visible", timeout=timeout)
    answer.fill("fixture answer only")
    page.wait_for_timeout(350)
    selected = selector.input_value()
    value = answer.input_value()
    haber_progress_reads = [
        item
        for item in router.api_requests
        if item["path"] == "/api/study/verb-prompt-progress"
        and (parse_qs(urlparse(item["url"]).query).get("verb") or [None])[0] == "haber"
    ]
    grade_reads_or_writes = [
        item
        for item in router.api_requests
        if item["path"] == "/api/study/grade" or item["path"].endswith("/grade")
    ]
    add_check(
        run,
        "selection.haber-preserved",
        selected == "haber" and bool(haber_progress_reads),
        expected="haber remains selected after its dependent prompt-progress GET completes",
        actual={"selected": selected, "haber_progress_reads": haber_progress_reads},
    )
    add_check(
        run,
        "typing.no-auto-grade",
        value == "fixture answer only"
        and len(router.mutation_attempts) == mutation_count_before
        and not grade_reads_or_writes,
        expected="typing changes only local input state; no grading request or mutation",
        actual={
            "input_value": value,
            "new_mutation_attempts": router.mutation_attempts[mutation_count_before:],
            "grade_requests": grade_reads_or_writes,
        },
    )


def expected_console_messages(scenario: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    expected_503 = scenario in {"catalog_fallback", "progress_retry"}
    return [
        message
        for message in messages
        if "Service Worker registration blocked by Playwright" not in message["text"]
        and "ERR_BLOCKED_BY_CLIENT" not in message["text"]
        and not (expected_503 and "503" in message["text"])
    ]


def finish_run(
    run: dict[str, Any],
    router: FixtureRouter,
    runtime_log: dict[str, list[Any]],
) -> None:
    run["network"] = router.network_evidence()
    run["runtime"] = runtime_log
    add_check(
        run,
        "safety.no-application-mutations",
        not router.mutation_attempts,
        expected="zero non-GET/HEAD/OPTIONS application requests",
        actual=router.mutation_attempts,
        detail="Every attempted mutation was aborted before dispatch; any attempt still fails the suite.",
    )
    add_check(
        run,
        "safety.no-external-dependencies",
        not router.blocked_external,
        expected="no external subresource requests (Cloudflare analytics is locally neutralized)",
        actual=router.blocked_external,
    )
    add_check(
        run,
        "runtime.no-page-errors",
        not runtime_log["page_errors"],
        expected=[],
        actual=runtime_log["page_errors"],
    )
    unexpected_console = expected_console_messages(run["scenario"], runtime_log["console"])
    add_check(
        run,
        "runtime.no-unexpected-console-errors",
        not unexpected_console,
        expected=[],
        actual=unexpected_console,
    )


def visual_ready_run(
    browser: Browser,
    browser_name: str,
    base: str,
    output: Path,
    catalog: dict[str, Any],
    device: str,
    theme: str,
    timeout: int,
    interaction_check: bool,
) -> dict[str, Any]:
    run = new_run(browser_name, "ready", device, theme)
    context, page, router, runtime_log = create_page(
        browser, base, catalog, "ready", device, theme, timeout
    )
    try:
        navigate_to_verbs(page, base, timeout, run)
        selector = selector_for(page)
        selector.wait_for(state="visible", timeout=timeout)
        page.wait_for_function(
            "Array.from(document.querySelectorAll('select')).some((s) => s.value && !s.disabled && s.options.length === 224)",
            timeout=timeout,
        )
        assert_group_contract(page, run, catalog, expect_enabled=True)
        add_visual_checks(page, run, theme)
        if interaction_check:
            exercise_selection_without_grading(page, run, router, timeout)
        save_screenshot(page, output, run)
    except Exception as exc:
        run["execution_error"] = f"{type(exc).__name__}: {exc}"
        add_check(
            run,
            "runner.scenario-completed",
            False,
            expected="ready scenario completed",
            actual=run["execution_error"],
        )
        try:
            save_screenshot(page, output, run, "--failure")
        except Exception as screenshot_exc:
            run["screenshot_error"] = f"{type(screenshot_exc).__name__}: {screenshot_exc}"
    finally:
        finish_run(run, router, runtime_log)
        context.close()
    return run


def catalog_fallback_run(
    browser: Browser,
    browser_name: str,
    base: str,
    output: Path,
    catalog: dict[str, Any],
    timeout: int,
) -> dict[str, Any]:
    run = new_run(browser_name, "catalog_fallback", "desktop", "light")
    context, page, router, runtime_log = create_page(
        browser, base, catalog, "catalog_fallback", "desktop", "light", timeout
    )
    try:
        navigate_to_verbs(page, base, timeout, run)
        selector = selector_for(page)
        selector.wait_for(state="visible", timeout=timeout)
        page.wait_for_function(
            "Array.from(document.querySelectorAll('select')).some((s) => !s.disabled && s.options.length === 224)",
            timeout=timeout,
        )
        assert_group_contract(page, run, catalog, expect_enabled=True)
        add_check(
            run,
            "fallback.bundled-catalog-used",
            router.catalog_attempts >= 1 and len(extract_group_state(selector)) == 3,
            expected="fixture catalog GET returns 503, then bundled 224-verb catalog renders three groups",
            actual={"catalog_attempts": router.catalog_attempts, "option_count": selector.locator("option").count()},
        )
        add_check(
            run,
            "fallback.progress-still-succeeded",
            router.progress_attempts >= 1 and selector.is_enabled(),
            expected="saved progress fixture succeeds and selector becomes enabled",
            actual={"progress_attempts": router.progress_attempts, "enabled": selector.is_enabled()},
        )
        add_visual_checks(page, run, "light")
        save_screenshot(page, output, run)
    except Exception as exc:
        run["execution_error"] = f"{type(exc).__name__}: {exc}"
        add_check(
            run,
            "runner.scenario-completed",
            False,
            expected="catalog fallback scenario completed",
            actual=run["execution_error"],
        )
        try:
            save_screenshot(page, output, run, "--failure")
        except Exception as screenshot_exc:
            run["screenshot_error"] = f"{type(screenshot_exc).__name__}: {screenshot_exc}"
    finally:
        finish_run(run, router, runtime_log)
        context.close()
    return run


def progress_retry_run(
    browser: Browser,
    browser_name: str,
    base: str,
    output: Path,
    catalog: dict[str, Any],
    timeout: int,
) -> dict[str, Any]:
    run = new_run(browser_name, "progress_retry", "mobile", "light")
    context, page, router, runtime_log = create_page(
        browser, base, catalog, "progress_retry", "mobile", "light", timeout
    )
    try:
        navigate_to_verbs(page, base, timeout, run)
        selector = selector_for(page)
        selector.wait_for(state="visible", timeout=timeout)
        held_route = router.wait_for_held_progress(page, timeout)
        curriculum = page.locator(".verb-curriculum")
        loading_status = curriculum.locator('[role="status"]')
        loading_text = " ".join((loading_status.first.text_content() or "").split()) if loading_status.count() else ""
        add_check(
            run,
            "progress.loading-disabled-with-status",
            selector.is_disabled() and loading_status.count() >= 1 and bool(loading_text),
            expected="disabled Choose verb selector plus a non-empty role=status while progress is pending",
            actual={
                "disabled": selector.is_disabled(),
                "status_count": loading_status.count(),
                "status_text": loading_text,
            },
        )

        json_response(held_route, 503, {"detail": "Fixture progress unavailable"})
        alert = curriculum.locator('[role="alert"]')
        alert.wait_for(state="visible", timeout=timeout)
        retry = alert.get_by_role("button", name="Retry progress", exact=True)
        retry.wait_for(state="visible", timeout=timeout)
        error_text = " ".join((alert.text_content() or "").split())
        retry_box = retry.bounding_box()
        add_check(
            run,
            "progress.error-disabled-alert-retry",
            selector.is_disabled() and bool(error_text) and retry.is_enabled(),
            expected="disabled selector and non-empty role=alert with enabled Retry progress button after fixture 503",
            actual={"selector_disabled": selector.is_disabled(), "alert": error_text, "retry_enabled": retry.is_enabled()},
        )
        add_check(
            run,
            "a11y.retry-target-44px",
            bool(retry_box) and retry_box["width"] >= 44 and retry_box["height"] >= 44,
            expected="Retry progress target at least 44x44 CSS px at 390px viewport",
            actual=retry_box,
        )
        save_screenshot(page, output, run, "--error")

        retry.click()
        page.wait_for_function(
            "Array.from(document.querySelectorAll('select')).some((s) => s.value && !s.disabled && s.options.length === 224)",
            timeout=timeout,
        )
        assert_group_contract(page, run, catalog, expect_enabled=True)
        add_check(
            run,
            "a11y.retry-restores-selector-focus",
            selector.evaluate("el => document.activeElement === el"),
            expected="successful retry restores keyboard focus to Choose verb",
            actual=page.evaluate("document.activeElement?.tagName"),
        )
        add_check(
            run,
            "progress.retry-read-only-success",
            router.progress_attempts == 2 and not router.mutation_attempts,
            expected="exactly two GET progress attempts (503 then 200) and zero mutations",
            actual={
                "progress_attempts": router.progress_attempts,
                "mutation_attempts": router.mutation_attempts,
            },
        )
        add_visual_checks(page, run, "light")
        save_screenshot(page, output, run, "--recovered")
    except Exception as exc:
        run["execution_error"] = f"{type(exc).__name__}: {exc}"
        add_check(
            run,
            "runner.scenario-completed",
            False,
            expected="progress loading/error/retry scenario completed",
            actual=run["execution_error"],
        )
        try:
            save_screenshot(page, output, run, "--failure")
        except Exception as screenshot_exc:
            run["screenshot_error"] = f"{type(screenshot_exc).__name__}: {screenshot_exc}"
    finally:
        # If setup failed before the held route was answered, resolve it before
        # context shutdown so Playwright does not leave a pending route task.
        for held_route in router.held_progress_routes:
            try:
                held_route.abort("blockedbyclient")
            except Exception:
                pass
        finish_run(run, router, runtime_log)
        context.close()
    return run


def deadline_run(report: dict[str, Any], browser_name: str, deadline: float) -> None:
    report["runs"].append(
        {
            "browser": browser_name,
            "scenario": "suite_deadline",
            "device": "n/a",
            "theme": "n/a",
            "checks": [
                {
                    "id": "runner.bounded-deadline",
                    "passed": False,
                    "expected": "all scenarios scheduled before the bounded suite deadline",
                    "actual": f"deadline reached at monotonic={deadline}",
                    "detail": "Raise --max-seconds only within its 295-second safety cap or investigate the stalled preview.",
                }
            ],
        }
    )


def main() -> int:
    args = parse_args()
    base, browsers = validate_args(args)
    catalog = load_catalog()
    # This check intentionally occurs immediately before sync_playwright() so
    # argument/catalog validation remains usable on the VPS without launching a browser.
    execution_host = refuse_vps_browser_launch()
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    deadline = started + args.max_seconds

    report: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "fixture-only (not live validation)",
        "base": base,
        "output": str(args.output.resolve()),
        "browser_execution_host": execution_host,
        "browsers_requested": browsers,
        "browser_versions": {},
        "fixture": {
            "catalog_path": str(CATALOG_PATH),
            "catalog_count": len(catalog["verbs"]),
            "progress": PROGRESS_FIXTURE,
            "core_spanish_verbs": list(CORE_SPANISH_VERBS),
        },
        "safety": {
            "base_restricted_to_loopback": True,
            "api_mode": "all /api/** fulfilled in-process",
            "allowed_methods": sorted(SAFE_METHODS),
            "mutations": "aborted before dispatch and treated as suite failures",
            "service_workers": "blocked",
            "external_subresources": "blocked except locally fulfilled analytics stub",
            "production_writes": 0,
        },
        "matrix": {
            "ready": "1440x1000 and 390x844, light and dark",
            "catalog_fallback": "1440x1000 light",
            "progress_retry": "390x844 light, captures error and recovery",
        },
        "runs": [],
        "browser_launch_failures": [],
    }

    with sync_playwright() as playwright:
        for browser_name in browsers:
            if time.monotonic() >= deadline:
                deadline_run(report, browser_name, deadline)
                break
            browser: Browser | None = None
            try:
                browser_type = getattr(playwright, browser_name)
                browser = browser_type.launch(headless=True)
                assert browser is not None
                report["browser_versions"][browser_name] = browser.version
                for device in DEVICES:
                    for theme in THEMES:
                        if time.monotonic() >= deadline:
                            deadline_run(report, browser_name, deadline)
                            raise TimeoutError("bounded suite deadline reached")
                        report["runs"].append(
                            visual_ready_run(
                                browser,
                                browser_name,
                                base,
                                args.output,
                                catalog,
                                device,
                                theme,
                                args.timeout,
                                interaction_check=device == "desktop" and theme == "light",
                            )
                        )
                if time.monotonic() >= deadline:
                    deadline_run(report, browser_name, deadline)
                    raise TimeoutError("bounded suite deadline reached")
                report["runs"].append(
                    catalog_fallback_run(
                        browser, browser_name, base, args.output, catalog, args.timeout
                    )
                )
                if time.monotonic() >= deadline:
                    deadline_run(report, browser_name, deadline)
                    raise TimeoutError("bounded suite deadline reached")
                report["runs"].append(
                    progress_retry_run(
                        browser, browser_name, base, args.output, catalog, args.timeout
                    )
                )
            except TimeoutError as exc:
                report["browser_launch_failures"].append(
                    {"browser": browser_name, "error": f"{type(exc).__name__}: {exc}"}
                )
                break
            except Exception as exc:
                report["browser_launch_failures"].append(
                    {"browser": browser_name, "error": f"{type(exc).__name__}: {exc}"}
                )
            finally:
                if browser is not None:
                    browser.close()

    checks = [check for run in report["runs"] for check in run.get("checks", [])]
    failed_checks = [
        {
            "browser": run.get("browser"),
            "scenario": run.get("scenario"),
            "device": run.get("device"),
            "theme": run.get("theme"),
            **check,
        }
        for run in report["runs"]
        for check in run.get("checks", [])
        if not check.get("passed")
    ]
    mutation_attempts = sum(
        len(run.get("network", {}).get("mutation_attempts", [])) for run in report["runs"]
    )
    screenshots = sorted({name for run in report["runs"] for name in run.get("screenshots", [])})
    elapsed = time.monotonic() - started
    report["summary"] = {
        "status": "passed" if not failed_checks and not report["browser_launch_failures"] else "failed",
        "run_count": len(report["runs"]),
        "check_count": len(checks),
        "passed_checks": sum(bool(check.get("passed")) for check in checks),
        "failed_checks": len(failed_checks),
        "mutation_attempts": mutation_attempts,
        "production_writes": 0,
        "screenshot_count": len(screenshots),
        "screenshots": screenshots,
        "elapsed_seconds": round(elapsed, 3),
        "bounded_under_seconds": args.max_seconds,
    }
    report["status"] = report["summary"]["status"]
    report["actionable_failures"] = failed_checks

    report_path = args.output / "report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": report["status"],
                "mode": report["mode"],
                "report": str(report_path.resolve()),
                **report["summary"],
                "browser_launch_failures": report["browser_launch_failures"],
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
