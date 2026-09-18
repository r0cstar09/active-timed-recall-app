#!/usr/bin/env python3
"""Deterministic, read-only browser regression tests for the redesigned dashboard.

The dashboard's two API reads are intercepted with local fixtures. Every
non-GET/HEAD/OPTIONS request is aborted before it can reach the network. Run
the selected Playwright browser on the Alienware browser worker, never on the
VPS.

Example (on the browser worker):
  /home/rootadmin/.venvs/recall-design-qa/bin/python scripts/test_dashboard_browser.py \
    --base http://127.0.0.1:18764 \
    --output /tmp/dashboard-browser-evidence \
    --axe-script /tmp/axe-4.10.3.min.js
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
DOCUMENT_THEMES = {"light": "paper", "dark": "dark"}
DEVICES: dict[str, dict[str, Any]] = {
    "desktop": {
        "viewport": {"width": 1440, "height": 1000},
        "screen": {"width": 1440, "height": 1000},
        "is_mobile": False,
        "has_touch": False,
        "device_scale_factor": 1,
    },
    "iphone": {
        "viewport": {"width": 390, "height": 844},
        "screen": {"width": 390, "height": 844},
        "is_mobile": True,
        "has_touch": True,
        "device_scale_factor": 1,
        "user_agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
            "Mobile/15E148 Safari/604.1"
        ),
    },
    "narrow": {
        "viewport": {"width": 320, "height": 700},
        "screen": {"width": 320, "height": 700},
        "is_mobile": True,
        "has_touch": True,
        "device_scale_factor": 1,
        "user_agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
            "Mobile/15E148 Safari/604.1"
        ),
    },
}
CORE_SCENARIOS = frozenset({"due", "new", "free_practice", "completed"})


def habit(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "available": True,
        "timezone": "America/New_York",
        "local_date": "2026-09-17",
        "daily_target": 10,
        "today_reps": 4,
        "remaining_reps": 6,
        "target_met": False,
        "current_streak": 8,
        "practiced_today": True,
        "recent_days": [
            {"date": "2026-09-11", "reps": 0, "target_met": False},
            {"date": "2026-09-12", "reps": 3, "target_met": False},
            {"date": "2026-09-13", "reps": 10, "target_met": True},
            {"date": "2026-09-14", "reps": 1, "target_met": False},
            {"date": "2026-09-15", "reps": 11, "target_met": True},
            {"date": "2026-09-16", "reps": 2, "target_met": False},
            {"date": "2026-09-17", "reps": 4, "target_met": False},
        ],
    }
    value.update(overrides)
    return value


def stats(due: int, new: int, habit_value: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "due_count": due,
        "new_count": new,
        "review_count": 72,
        "learning_count": 3,
        "suspended_count": 2,
        "habit": habit_value,
    }
    value.update(overrides)
    return value


def source(source_id: int) -> dict[str, Any]:
    return {
        "id": source_id,
        "source_type": "fixture",
        "source_url": f"https://fixture.invalid/{source_id}",
        "source_video_id": None,
        "title": f"Fixture source {source_id}",
        "channel": "Browser QA",
        "language": "es",
        "transcript_status": "ready",
        "audio_status": "ready",
        "created_at": "2026-09-17T12:00:00Z",
        "phrase_count": source_id,
        "active_count": source_id,
    }


SCENARIOS: dict[str, dict[str, Any]] = {
    "loading": {
        "kind": "loading",
        "description": "Both fixture reads remain pending so the skeleton is stable.",
    },
    "error_retry": {
        "kind": "error_retry",
        "description": "Stats fails once with 503; keyboard retry returns the due fixture.",
        "stats": stats(14, 6, habit()),
        "sources": {"total": 4, "sources": []},
        "primary": {"label": "Review 10 due cards", "href": "/session?mode=review"},
        "source_label": "4 sources",
    },
    "due": {
        "kind": "ready",
        "description": "More than ten due cards caps only the primary label, not the queue count.",
        "stats": stats(27, 14, habit()),
        "sources": {"total": 123456, "sources": []},
        "primary": {"label": "Review 10 due cards", "href": "/session?mode=review"},
        "source_label": "123456 sources",
        "mode_value": "27",
    },
    "new": {
        "kind": "ready",
        "description": "No due cards promotes capped Learn as the primary action.",
        "stats": stats(0, 19, habit(today_reps=1, remaining_reps=9, current_streak=1)),
        # Bare-array contract exercises countSources()'s first fallback.
        "sources": [source(1), source(2), source(3)],
        "primary": {"label": "Learn 10 new cards", "href": "/session?mode=learn"},
        "source_label": "3 sources",
        "mode_value": "19",
    },
    "free_practice": {
        "kind": "ready",
        "description": "Empty due/new queues with an unfinished goal promote free practice.",
        "stats": stats(0, 0, habit(today_reps=0, remaining_reps=10, current_streak=0, practiced_today=False)),
        # Named wrapper contract exercises toArray(..., ['sources', ...]).
        "sources": {"sources": [source(1), source(2)]},
        "primary": {"label": "Start free practice", "href": "/session?mode=practice"},
        "source_label": "2 sources",
        "mode_value": "Open",
    },
    "completed": {
        "kind": "ready",
        "description": "A completed goal with empty queues promotes Lessons.",
        "stats": stats(
            0,
            0,
            habit(today_reps=12, remaining_reps=0, target_met=True, current_streak=9, practiced_today=True),
        ),
        # Secondary recognized wrapper catches accidental source-normalizer changes.
        "sources": {"items": [source(1)]},
        "primary": {"label": "Choose a lesson", "href": "/lessons"},
        "source_label": "1 source",
        "mode_value": "Open",
    },
    "habit_unavailable": {
        "kind": "ready",
        "description": "Offline habit data must not present a misleading zero-progress goal.",
        "stats": stats(
            8,
            2,
            habit(
                available=False,
                today_reps=0,
                remaining_reps=10,
                target_met=False,
                current_streak=0,
                practiced_today=False,
                recent_days=[],
            ),
        ),
        # Generic result wrapper exercises the last explicit source fallback key.
        "sources": {"results": [source(1), source(2), source(3), source(4), source(5)]},
        "primary": {"label": "Review 8 due cards", "href": "/session?mode=review"},
        "source_label": "5 sources",
        "mode_value": "8",
    },
    "sources_failure": {
        "kind": "sources_failure",
        "description": "A sources 503 must degrade only the source count, not hide the dashboard.",
        "stats": stats(3, 5, habit()),
        "primary": {"label": "Review 3 due cards", "href": "/session?mode=review"},
        "source_label": "Source count unavailable",
        "mode_value": "3",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Deterministic dashboard browser-state regression tests")
    parser.add_argument("--base", default="http://127.0.0.1:18764", help="Alienware preview origin")
    parser.add_argument("--output", required=True, type=Path, help="Evidence directory")
    parser.add_argument("--axe-script", type=Path, help="Pinned local axe.min.js (optional)")
    parser.add_argument("--theme", choices=("light", "dark"), default="light", help="Requested color scheme")
    parser.add_argument("--browser", choices=("chromium", "webkit"), default="chromium", help="Playwright browser")
    parser.add_argument("--timeout", type=int, default=12_000, help="Per-operation timeout in milliseconds")
    return parser.parse_args()


def add_check(
    run: dict[str, Any],
    check_id: str,
    passed: bool,
    *,
    category: str,
    severity: str,
    expected: Any = None,
    actual: Any = None,
    detail: str = "",
) -> None:
    run["checks"].append(
        {
            "id": check_id,
            "passed": bool(passed),
            "category": category,
            "severity": severity,
            "expected": expected,
            "actual": actual,
            "detail": detail,
        }
    )


def text(page: Page, selector: str) -> str:
    return " ".join((page.locator(selector).first.text_content() or "").split())


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


def attach_fixture_router(page: Page, scenario: dict[str, Any], log: dict[str, list[Any]]) -> list[Any]:
    held_routes: list[Any] = []

    def fulfill_json(route: Any, status: int, payload: Any) -> None:
        route.fulfill(
            status=status,
            content_type="application/json",
            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"},
            body=json.dumps(payload),
        )

    def route_request(route: Any) -> None:
        request = route.request
        method = request.method.upper()
        parsed = urlparse(request.url)
        if method not in SAFE_METHODS:
            log["blocked_mutations"].append({"method": method, "url": request.url})
            route.abort("blockedbyclient")
            return

        if parsed.path == "/api/stats":
            log["api_requests"].append({"method": method, "path": parsed.path, "url": request.url})
            attempt = sum(item["path"] == "/api/stats" for item in log["api_requests"])
            if scenario["kind"] == "loading":
                log["pending_fixture_requests"].append({"method": method, "path": parsed.path})
                held_routes.append(route)
                return
            if scenario["kind"] == "error_retry" and attempt == 1:
                fulfill_json(route, 503, {"detail": "Fixture stats offline"})
                return
            fulfill_json(route, 200, deepcopy(scenario["stats"]))
            return

        if parsed.path == "/api/sources":
            log["api_requests"].append({"method": method, "path": parsed.path, "url": request.url})
            if scenario["kind"] == "loading":
                log["pending_fixture_requests"].append({"method": method, "path": parsed.path})
                held_routes.append(route)
                return
            if scenario["kind"] == "sources_failure":
                fulfill_json(route, 503, {"detail": "Fixture sources offline"})
                return
            fulfill_json(route, 200, deepcopy(scenario["sources"]))
            return

        if parsed.path.startswith("/api/"):
            log["unexpected_api_requests"].append({"method": method, "path": parsed.path, "url": request.url})
            fulfill_json(route, 418, {"detail": "Unexpected API request blocked by dashboard QA"})
            return
        route.continue_()

    page.route("**/*", route_request)
    return held_routes


def inspect_layout(page: Page) -> dict[str, Any]:
    return page.evaluate(
        """() => {
          const root = document.documentElement;
          const body = document.body;
          const vw = root.clientWidth;
          const visible = (el) => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const out = [...document.querySelectorAll('body *')]
            .filter(visible)
            .map((el) => {
              const rect = el.getBoundingClientRect();
              if (rect.left >= -1 && rect.right <= vw + 1) return null;
              return {
                tag: el.tagName.toLowerCase(),
                className: typeof el.className === 'string' ? el.className.split(/\\s+/).slice(0, 3).join('.') : '',
                text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
                left: Math.round(rect.left * 10) / 10,
                right: Math.round(rect.right * 10) / 10,
                width: Math.round(rect.width * 10) / 10,
              };
            })
            .filter(Boolean)
            .slice(0, 15);
          const named = (selector) => [...document.querySelectorAll(selector)].filter(visible).map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              selector,
              text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
            };
          });
          const controls = [...document.querySelectorAll('a, button, summary')].filter(visible).map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              className: typeof el.className === 'string' ? el.className.split(/\\s+/).slice(0, 3).join('.') : '',
              name: (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
            };
          });
          const unnamed = [...document.querySelectorAll('a, button, summary')]
            .filter(visible)
            .filter((el) => !(el.getAttribute('aria-label') || el.textContent || '').trim())
            .map((el) => el.outerHTML.slice(0, 180));
          return {
            viewport: {width: vw, height: root.clientHeight},
            document: {
              scrollWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0),
              scrollHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0),
            },
            horizontalOverflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > vw + 1,
            overflowers: out,
            textMetrics: [
              ...named('.daily-primary-action strong'),
              ...named('.daily-primary-action small'),
              ...named('.daily-source-count'),
            ],
            controls,
            unnamedControls: unnamed,
            visibleH1Count: [...document.querySelectorAll('h1')].filter(visible).length,
            activePageCount: [...document.querySelectorAll('[aria-current="page"]')].filter(visible).length,
          };
        }"""
    )


def add_layout_checks(page: Page, run: dict[str, Any], device_name: str) -> None:
    layout = inspect_layout(page)
    run["layout"] = layout
    add_check(
        run,
        "layout.no-horizontal-overflow",
        not layout["horizontalOverflow"],
        category="Visual",
        severity="high",
        expected="document width <= viewport width",
        actual={"viewport": layout["viewport"], "document": layout["document"], "overflowers": layout["overflowers"]},
    )
    clipped = [
        item
        for item in layout["textMetrics"]
        if item["scrollWidth"] > item["clientWidth"] + 1 or item["scrollHeight"] > item["clientHeight"] + 1
    ]
    add_check(
        run,
        "layout.long-labels-not-clipped",
        not clipped,
        category="Visual",
        severity="medium",
        expected="primary/source labels fit or wrap without clipping",
        actual=clipped,
    )
    add_check(
        run,
        "a11y.one-visible-h1",
        layout["visibleH1Count"] == 1,
        category="Accessibility",
        severity="medium",
        expected=1,
        actual=layout["visibleH1Count"],
    )
    add_check(
        run,
        "a11y.controls-have-names",
        not layout["unnamedControls"],
        category="Accessibility",
        severity="high",
        expected="all visible links/buttons/summaries have accessible text",
        actual=layout["unnamedControls"],
    )
    add_check(
        run,
        "navigation.one-visible-current-page",
        layout["activePageCount"] == 1,
        category="Accessibility",
        severity="medium",
        expected=1,
        actual=layout["activePageCount"],
    )
    if device_name != "desktop":
        key_classes = ("theme-toggle", "daily-primary-action", "tab ", "tab.", "tab-more-trigger")
        undersized = [
            control
            for control in layout["controls"]
            if any(token in f" {control['className']} " for token in key_classes)
            and (control["width"] < 44 or control["height"] < 44)
        ]
        add_check(
            run,
            "a11y.mobile-key-targets-44px",
            not undersized,
            category="Accessibility",
            severity="medium",
            expected="theme, primary action, and bottom navigation targets >= 44x44 CSS px",
            actual=undersized,
        )


def add_theme_checks(page: Page, run: dict[str, Any], requested_theme: str, device_name: str) -> None:
    expected_document_theme = DOCUMENT_THEMES[requested_theme]
    actual = page.evaluate(
        """() => {
          const preferredColorScheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
          const matchingMeta = [...document.querySelectorAll('meta[name="theme-color"]')]
            .find((meta) => {
              const media = meta.getAttribute('media');
              return !media || matchMedia(media).matches;
            });
          const colorProbe = document.createElement('span');
          colorProbe.style.color = matchingMeta?.content || '';
          document.body.append(colorProbe);
          const normalizedMetaThemeColor = matchingMeta ? getComputedStyle(colorProbe).color : null;
          colorProbe.remove();
          return {
            documentTheme: document.documentElement.dataset.theme || null,
            storageTheme: localStorage.getItem('atr-theme'),
            preferredColorScheme,
            metaThemeColor: matchingMeta?.content || null,
            normalizedMetaThemeColor,
            bodyBackgroundColor: getComputedStyle(document.body).backgroundColor,
          };
        }"""
    )
    expected = {
        "documentTheme": expected_document_theme,
        "storageTheme": expected_document_theme,
        "preferredColorScheme": requested_theme,
    }
    add_check(
        run,
        "theme.requested-scheme-applied",
        all(actual[key] == value for key, value in expected.items()),
        category="Visual",
        severity="high",
        expected=expected,
        actual=actual,
    )
    if device_name != "desktop":
        add_check(
            run,
            "theme.mobile-meta-background-aligned",
            actual["normalizedMetaThemeColor"] is not None
            and actual["normalizedMetaThemeColor"] == actual["bodyBackgroundColor"],
            category="Visual",
            severity="high",
            expected="the active color-scheme theme-color meta value matches the computed body background",
            actual={
                "meta_theme_color": actual["metaThemeColor"],
                "normalized_meta_theme_color": actual["normalizedMetaThemeColor"],
                "body_background_color": actual["bodyBackgroundColor"],
            },
        )


def assert_ready_contract(page: Page, run: dict[str, Any], scenario: dict[str, Any]) -> None:
    primary = page.locator(".daily-primary-action")
    actual_label = text(page, ".daily-primary-action strong")
    actual_href = primary.get_attribute("href")
    add_check(
        run,
        "contract.primary-label",
        actual_label == scenario["primary"]["label"],
        category="Functional",
        severity="high",
        expected=scenario["primary"]["label"],
        actual=actual_label,
    )
    add_check(
        run,
        "contract.primary-href",
        actual_href == scenario["primary"]["href"],
        category="Functional",
        severity="high",
        expected=scenario["primary"]["href"],
        actual=actual_href,
    )
    source_label = text(page, ".daily-source-count")
    add_check(
        run,
        "contract.source-count-normalization",
        source_label == scenario["source_label"],
        category="Functional",
        severity="high",
        expected=scenario["source_label"],
        actual=source_label,
    )
    add_check(
        run,
        "contract.dashboard-visible",
        page.locator(".daily-hero").is_visible() and page.locator(".daily-mode-grid").is_visible(),
        category="Functional",
        severity="high",
        expected="hero and mode grid visible",
        actual={
            "hero": page.locator(".daily-hero").is_visible(),
            "mode_grid": page.locator(".daily-mode-grid").is_visible(),
        },
    )
    if "mode_value" in scenario:
        values = [" ".join(value.split()) for value in page.locator(".daily-mode-value").all_text_contents()]
        add_check(
            run,
            "contract.queue-value",
            scenario["mode_value"] in values,
            category="Functional",
            severity="high",
            expected=scenario["mode_value"],
            actual=values,
        )


def assert_goal_contract(page: Page, run: dict[str, Any], scenario_name: str, scenario: dict[str, Any]) -> None:
    ring = page.locator(".daily-goal-ring")
    habit_value = scenario["stats"]["habit"]
    role = ring.get_attribute("role")
    ring_text = " ".join((ring.text_content() or "").split())
    if scenario_name == "habit_unavailable":
        page_copy = text(page, ".daily-home")
        add_check(
            run,
            "contract.offline-habit-not-zero",
            role is None and "—" in ring_text and "offline" in ring_text.lower() and "0 of" not in ring_text.lower(),
            category="Functional",
            severity="high",
            expected="no progressbar role; em dash/offline; no misleading '0 of'",
            actual={"role": role, "ring_text": ring_text},
        )
        add_check(
            run,
            "contract.offline-habit-explained",
            "Tracking unavailable" in page_copy and "Recent activity could not be loaded" in page_copy,
            category="Accessibility",
            severity="medium",
            expected="explicit unavailable goal and recent-activity status",
            actual=page_copy[:700],
        )
    else:
        expected_now = str(min(habit_value["today_reps"], habit_value["daily_target"]))
        add_check(
            run,
            "a11y.goal-progressbar-contract",
            role == "progressbar"
            and ring.get_attribute("aria-label") == "Daily practice target"
            and ring.get_attribute("aria-valuemin") == "0"
            and ring.get_attribute("aria-valuemax") == str(habit_value["daily_target"])
            and ring.get_attribute("aria-valuenow") == expected_now,
            category="Accessibility",
            severity="high",
            expected={"role": "progressbar", "min": "0", "max": str(habit_value["daily_target"]), "now": expected_now},
            actual={
                "role": role,
                "label": ring.get_attribute("aria-label"),
                "min": ring.get_attribute("aria-valuemin"),
                "max": ring.get_attribute("aria-valuemax"),
                "now": ring.get_attribute("aria-valuenow"),
            },
        )


def run_keyboard_checks(
    page: Page,
    run: dict[str, Any],
    device_name: str,
    output: Path,
    requested_theme: str,
) -> None:
    page.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()")
    page.keyboard.press("Tab")
    focused = page.evaluate("document.activeElement?.className || document.activeElement?.tagName")
    skip_visible = page.locator(".skip-link").is_visible()
    add_check(
        run,
        "keyboard.skip-link-first",
        "skip-link" in str(focused) and skip_visible,
        category="Accessibility",
        severity="high",
        expected="first Tab visibly focuses .skip-link",
        actual={"focused": focused, "visible": skip_visible},
    )
    page.keyboard.press("Enter")
    main_focused = page.evaluate("document.activeElement?.id")
    add_check(
        run,
        "keyboard.skip-link-target",
        main_focused == "main-content",
        category="Accessibility",
        severity="high",
        expected="main-content",
        actual=main_focused,
    )
    page.keyboard.press("Tab")
    primary_focused = page.evaluate("document.activeElement?.classList?.contains('daily-primary-action') || false")
    outline = page.evaluate(
        """() => {
          const el = document.activeElement;
          if (!(el instanceof HTMLElement)) return null;
          const s = getComputedStyle(el);
          return {style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor};
        }"""
    )
    add_check(
        run,
        "keyboard.primary-focus-visible",
        bool(primary_focused) and outline is not None and outline["style"] != "none" and outline["width"] != "0px",
        category="Accessibility",
        severity="high",
        expected="primary action follows main and has a visible outline",
        actual={"primary_focused": primary_focused, "outline": outline},
    )

    toggle = page.locator("[data-theme-toggle]").first
    toggle.focus()
    expected_before = DOCUMENT_THEMES[requested_theme]
    toggled_theme = "dark" if requested_theme == "light" else "light"
    expected_after = DOCUMENT_THEMES[toggled_theme]
    before = page.locator("html").get_attribute("data-theme")
    before_overflow = inspect_layout(page)["horizontalOverflow"]
    page.keyboard.press("Enter")
    page.wait_for_timeout(100)
    after = page.locator("html").get_attribute("data-theme")
    pressed = toggle.get_attribute("aria-pressed")
    label = toggle.get_attribute("aria-label")
    stored = page.evaluate("localStorage.getItem('atr-theme')")
    expected_pressed = str(toggled_theme == "dark").lower()
    expected_label = "Switch to light theme" if toggled_theme == "dark" else "Switch to dark theme"
    add_check(
        run,
        "keyboard.theme-toggle",
        before == expected_before
        and after == expected_after
        and stored == expected_after
        and pressed == expected_pressed
        and label == expected_label,
        category="Functional",
        severity="high",
        expected={
            "before": expected_before,
            "after": expected_after,
            "stored": expected_after,
            "aria-pressed": expected_pressed,
            "aria-label": expected_label,
        },
        actual={"before": before, "after": after, "stored": stored, "aria-pressed": pressed, "aria-label": label},
    )
    toggled_name = f"{run['scenario']}--{device_name}--{toggled_theme}.png"
    page.screenshot(path=str(output / toggled_name), full_page=True)
    run[f"{toggled_theme}_screenshot"] = toggled_name
    after_overflow = inspect_layout(page)["horizontalOverflow"]
    dark_overflow = after_overflow if toggled_theme == "dark" else before_overflow
    add_check(
        run,
        "layout.dark-theme-no-horizontal-overflow",
        not dark_overflow,
        category="Visual",
        severity="high",
        expected=False,
        actual=dark_overflow,
    )
    page.keyboard.press("Enter")
    page.wait_for_timeout(100)
    restored = {
        "document_theme": page.locator("html").get_attribute("data-theme"),
        "storage_theme": page.evaluate("localStorage.getItem('atr-theme')"),
    }
    add_check(
        run,
        "keyboard.theme-toggle-restores-requested",
        restored["document_theme"] == expected_before and restored["storage_theme"] == expected_before,
        category="Functional",
        severity="high",
        expected={"document_theme": expected_before, "storage_theme": expected_before},
        actual=restored,
    )

    if device_name != "desktop":
        menu = page.locator("[data-nav-more]")
        summary = menu.locator("summary")
        summary.focus()
        page.keyboard.press("Enter")
        settings_visible = menu.get_by_role("link", name="Settings", exact=True).is_visible()
        opened = menu.get_attribute("open") is not None
        page.keyboard.press("Escape")
        closed = menu.get_attribute("open") is None
        refocused = page.evaluate("document.activeElement === document.querySelector('[data-nav-more] summary')")
        add_check(
            run,
            "keyboard.mobile-more-menu",
            opened and settings_visible and closed and refocused,
            category="Accessibility",
            severity="high",
            expected="Enter opens, Settings is visible, Escape closes and restores summary focus",
            actual={"opened": opened, "settings_visible": settings_visible, "closed": closed, "refocused": refocused},
        )


def run_axe(page: Page, run: dict[str, Any], axe_script: Path | None) -> None:
    if run["scenario"] not in CORE_SCENARIOS:
        run["axe"] = {"status": "not_applicable", "reason": "Axe is scoped to the four core ready states."}
        return
    if not axe_script:
        run["axe"] = {"status": "skipped", "reason": "No --axe-script supplied."}
        return
    try:
        page.add_script_tag(path=str(axe_script))
        result = page.evaluate(
            """async () => {
              const result = await axe.run(document, {
                resultTypes: ['violations'],
                runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']},
              });
              return {
                testEngine: result.testEngine,
                testEnvironment: result.testEnvironment,
                violations: result.violations.map(v => ({
                  id: v.id,
                  impact: v.impact,
                  help: v.help,
                  helpUrl: v.helpUrl,
                  tags: v.tags,
                  nodes: v.nodes.map(n => ({target: n.target, html: n.html, failureSummary: n.failureSummary})),
                })),
              };
            }"""
        )
        run["axe"] = {"status": "completed", **result}
        severe = [v for v in result["violations"] if v["impact"] in {"critical", "serious"}]
        add_check(
            run,
            "axe.no-critical-or-serious",
            not severe,
            category="Accessibility",
            severity="high",
            expected="zero critical/serious axe violations",
            actual=severe,
        )
    except Exception as exc:
        run["axe"] = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
        add_check(
            run,
            "axe.executed",
            False,
            category="Accessibility",
            severity="medium",
            expected="axe completed",
            actual=run["axe"],
        )


def exercise_scenario(
    browser: Any,
    base: str,
    output: Path,
    device_name: str,
    scenario_name: str,
    scenario: dict[str, Any],
    timeout: int,
    axe_script: Path | None,
    requested_theme: str,
) -> dict[str, Any]:
    run: dict[str, Any] = {
        "scenario": scenario_name,
        "description": scenario["description"],
        "device": device_name,
        "theme": requested_theme,
        "viewport": DEVICES[device_name]["viewport"],
        "checks": [],
    }
    log: dict[str, list[Any]] = {
        "api_requests": [],
        "unexpected_api_requests": [],
        "pending_fixture_requests": [],
        "blocked_mutations": [],
        "console": [],
        "page_errors": [],
        "request_failures": [],
    }
    context = browser.new_context(
        **DEVICES[device_name],
        service_workers="block",
        color_scheme=requested_theme,
    )
    document_theme = json.dumps(DOCUMENT_THEMES[requested_theme])
    context.add_init_script(
        f"""(() => {{
          localStorage.setItem('atr-theme', {document_theme});
          localStorage.setItem('atr.apiBaseUrl', location.origin);
          localStorage.removeItem('atr.activeApiBase');
        }})()"""
    )
    page = context.new_page()
    attach_observers(page, log)
    held_routes = attach_fixture_router(page, scenario, log)
    try:
        response = page.goto(base + "/", wait_until="domcontentloaded", timeout=timeout)
        run["navigation"] = {"status": response.status if response else None, "final_url": page.url}
        add_check(
            run,
            "navigation.preview-loaded",
            response is not None and response.ok,
            category="Functional",
            severity="critical",
            expected="2xx preview response",
            actual=run["navigation"],
        )
        add_theme_checks(page, run, requested_theme, device_name)

        if scenario["kind"] == "loading":
            page.locator('[aria-busy="true"]').wait_for(state="visible", timeout=timeout)
            page.wait_for_timeout(250)
            loading = page.locator('[aria-busy="true"][aria-label="Loading today’s Spanish plan"]')
            add_check(
                run,
                "state.loading-accessible",
                loading.count() == 1 and loading.is_visible() and page.locator(".daily-primary-action").count() == 0,
                category="Accessibility",
                severity="high",
                expected="one labelled busy region and no premature primary action",
                actual={"busy_count": loading.count(), "primary_count": page.locator(".daily-primary-action").count()},
            )
            add_check(
                run,
                "fixture.loading-both-requests-pending",
                sorted(item["path"] for item in log["pending_fixture_requests"]) == ["/api/sources", "/api/stats"],
                category="Functional",
                severity="high",
                expected=["/api/sources", "/api/stats"],
                actual=sorted(item["path"] for item in log["pending_fixture_requests"]),
            )
        elif scenario["kind"] == "error_retry":
            alert = page.locator('[role="alert"]')
            alert.wait_for(state="visible", timeout=timeout)
            error_copy = " ".join((alert.text_content() or "").split())
            add_check(
                run,
                "state.error-alert-and-retry",
                "Today’s plan could not load." in error_copy
                and "Request failed (503): Fixture stats offline" in error_copy
                and alert.get_by_role("button", name="Try again").is_visible(),
                category="Functional",
                severity="high",
                expected="specific stats error in role=alert plus Try again button",
                actual=error_copy,
            )
            error_name = f"{scenario_name}--{device_name}--error.png"
            page.screenshot(path=str(output / error_name), full_page=True)
            run["error_screenshot"] = error_name
            retry = alert.get_by_role("button", name="Try again")
            retry.focus()
            page.keyboard.press("Enter")
            page.locator(".daily-primary-action").wait_for(state="visible", timeout=timeout)
            page.wait_for_timeout(100)
            active_after_retry = page.evaluate(
                """() => ({
                  tag: document.activeElement?.tagName || null,
                  id: document.activeElement?.id || null,
                  className: typeof document.activeElement?.className === 'string' ? document.activeElement.className : null,
                  text: (document.activeElement?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
                })"""
            )
            focus_preserved = active_after_retry["tag"] not in {None, "BODY"}
            add_check(
                run,
                "keyboard.retry-focus-preserved",
                focus_preserved,
                category="Accessibility",
                severity="medium",
                expected="focus moves to meaningful recovered content instead of BODY",
                actual=active_after_retry,
                detail="The retry button is removed when recovery succeeds; focus should be deliberately restored.",
            )
            assert_ready_contract(page, run, scenario)
            assert_goal_contract(page, run, scenario_name, scenario)
            add_layout_checks(page, run, device_name)
        else:
            page.locator(".daily-primary-action").wait_for(state="visible", timeout=timeout)
            page.wait_for_timeout(100)
            assert_ready_contract(page, run, scenario)
            assert_goal_contract(page, run, scenario_name, scenario)
            add_layout_checks(page, run, device_name)

        screenshot_name = f"{scenario_name}--{device_name}.png"
        page.screenshot(path=str(output / screenshot_name), full_page=True)
        run["screenshot"] = screenshot_name

        if scenario_name == "due":
            run_keyboard_checks(page, run, device_name, output, requested_theme)
        run_axe(page, run, axe_script)
    except Exception as exc:
        run["execution_error"] = f"{type(exc).__name__}: {exc}"
        add_check(
            run,
            "runner.scenario-completed",
            False,
            category="Functional",
            severity="critical",
            expected="scenario completed",
            actual=run["execution_error"],
        )
        failure_name = f"{scenario_name}--{device_name}--runner-failure.png"
        try:
            page.screenshot(path=str(output / failure_name), full_page=True)
            run["failure_screenshot"] = failure_name
        except Exception as screenshot_exc:
            run["failure_screenshot_error"] = f"{type(screenshot_exc).__name__}: {screenshot_exc}"
    finally:
        run["network"] = log
        # A blocked service-worker registration warning and deliberate fixture
        # 503 console messages are expected. Everything else is retained.
        expected_fixture_503 = scenario["kind"] in {"error_retry", "sources_failure"}
        unexpected_console = [
            item
            for item in log["console"]
            if "Service Worker registration blocked by Playwright" not in item["text"]
            and "ERR_BLOCKED_BY_CLIENT" not in item["text"]
            and not (expected_fixture_503 and "503 (Service Unavailable)" in item["text"])
        ]
        add_check(
            run,
            "runtime.no-page-errors",
            not log["page_errors"],
            category="Console",
            severity="high",
            expected=[],
            actual=log["page_errors"],
        )
        add_check(
            run,
            "runtime.no-unexpected-console-errors",
            not unexpected_console,
            category="Console",
            severity="medium",
            expected=[],
            actual=unexpected_console,
        )
        add_check(
            run,
            "safety.no-unexpected-api",
            not log["unexpected_api_requests"],
            category="Safety",
            severity="critical",
            expected=[],
            actual=log["unexpected_api_requests"],
        )
        # Resolve intentionally held loading-state fixtures before closing the
        # context so Playwright does not leave route-handler tasks pending.
        for held_route in held_routes:
            try:
                held_route.abort("blockedbyclient")
            except Exception:
                pass
        context.close()
    return run


def markdown_report(report: dict[str, Any]) -> str:
    summary = report["summary"]
    failures = [
        (run, check)
        for run in report["runs"]
        for check in run["checks"]
        if not check["passed"]
    ]
    lines = [
        "# Dashboard browser-state regression report",
        "",
        "## Result",
        "",
        f"- **Status:** {report['status'].upper()}",
        f"- **Target:** `{report['base']}`",
        f"- **Browser host:** `{report['browser_execution_host']}`",
        f"- **Browser:** `{report['browser']} {report['browser_version']}`",
        f"- **Theme:** `{report['theme']}`",
        f"- **Scenario/device runs:** {summary['run_count']}",
        f"- **Checks:** {summary['check_count']} ({summary['passed_checks']} passed, {summary['failed_checks']} failed)",
        f"- **Screenshots:** {summary['screenshot_count']}",
        f"- **Observed production writes:** {summary['production_writes']}",
        "",
        "## Safety and determinism",
        "",
        "- `/api/stats` and `/api/sources` were fulfilled entirely by in-process fixtures.",
        "- Every non-GET/HEAD/OPTIONS request was aborted before network dispatch.",
        "- Service workers were blocked and the runtime API override was forced to the preview origin.",
        "",
        "## Actionable failures",
        "",
    ]
    if not failures:
        lines.append("None.")
    else:
        lines.extend(["| Severity | Scenario | Device | Check | Actual |", "|---|---|---|---|---|"])
        for run, check in failures:
            actual = json.dumps(check.get("actual"), ensure_ascii=False).replace("|", "\\|")
            if len(actual) > 500:
                actual = actual[:497] + "..."
            lines.append(
                f"| {check['severity']} | {run['scenario']} | {run['device']} | `{check['id']}` | {actual} |"
            )
    lines.extend(["", "## Run matrix", "", "| Scenario | Device | Result | Screenshot | Axe |", "|---|---|---|---|---|"])
    for run in report["runs"]:
        failed = sum(not check["passed"] for check in run["checks"])
        result = "PASS" if failed == 0 else f"FAIL ({failed})"
        screenshot = run.get("screenshot") or run.get("failure_screenshot") or "—"
        axe = run.get("axe", {}).get("status", "not reached")
        lines.append(f"| {run['scenario']} | {run['device']} | {result} | `{screenshot}` | {axe} |")
    lines.extend(
        [
            "",
            "## Coverage",
            "",
            "- Loading skeleton and labelled busy region",
            "- Stats error, alert copy, keyboard retry, and post-retry focus",
            "- Due (>10 label cap), New (>10 label cap), Free Practice, and completed-goal primary actions",
            "- `habit.available=false` offline semantics",
            "- Sources failure isolation and all supported source-count response shapes",
            "- Desktop 1440×1000, iPhone-sized 390×844, and narrow 320×700 layout",
            "- Skip link, focus visibility, theme toggle, mobile More menu, touch targets, headings, and progressbar semantics",
            "- Pinned local axe-core on all four core states at all three viewports when supplied",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    base = args.base.rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit("--base must be an absolute HTTP(S) origin")
    if parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise SystemExit("This fixture suite is intentionally restricted to a localhost preview origin")
    if args.axe_script and not args.axe_script.is_file():
        raise SystemExit(f"--axe-script does not exist: {args.axe_script}")
    args.output.mkdir(parents=True, exist_ok=True)

    report: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "base": base,
        "output": str(args.output.resolve()),
        "browser_execution_host": socket.gethostname(),
        "browser": args.browser,
        "browser_version": None,
        "theme": args.theme,
        "safety": {
            "allowed_methods": sorted(SAFE_METHODS),
            "intercepted_endpoints": ["/api/stats", "/api/sources"],
            "service_workers": "blocked",
            "api_override": "preview origin",
        },
        "devices": DEVICES,
        "scenarios": {name: value["description"] for name, value in SCENARIOS.items()},
        "axe_script": str(args.axe_script.resolve()) if args.axe_script else None,
        "runs": [],
    }

    with sync_playwright() as playwright:
        browser = getattr(playwright, args.browser).launch(headless=True)
        report["browser_version"] = browser.version
        try:
            for device_name in DEVICES:
                for scenario_name, scenario in SCENARIOS.items():
                    report["runs"].append(
                        exercise_scenario(
                            browser,
                            base,
                            args.output,
                            device_name,
                            scenario_name,
                            scenario,
                            args.timeout,
                            args.axe_script,
                            args.theme,
                        )
                    )
        finally:
            browser.close()

    all_checks = [check for run in report["runs"] for check in run["checks"]]
    screenshot_files = sorted(args.output.glob("*.png"))
    blocked_mutations = sum(len(run["network"]["blocked_mutations"]) for run in report["runs"])
    report["summary"] = {
        "browser": args.browser,
        "theme": args.theme,
        "run_count": len(report["runs"]),
        "check_count": len(all_checks),
        "passed_checks": sum(check["passed"] for check in all_checks),
        "failed_checks": sum(not check["passed"] for check in all_checks),
        "critical_failures": sum(not check["passed"] and check["severity"] == "critical" for check in all_checks),
        "high_failures": sum(not check["passed"] and check["severity"] == "high" for check in all_checks),
        "medium_failures": sum(not check["passed"] and check["severity"] == "medium" for check in all_checks),
        "screenshot_count": len(screenshot_files),
        "axe_completed_runs": sum(run.get("axe", {}).get("status") == "completed" for run in report["runs"]),
        "blocked_mutations": blocked_mutations,
        "production_writes": 0,
    }
    report["status"] = "passed" if report["summary"]["failed_checks"] == 0 else "failed"

    json_path = args.output / "report.json"
    md_path = args.output / "report.md"
    json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    md_path.write_text(markdown_report(report), encoding="utf-8")
    print(
        json.dumps(
            {
                "status": report["status"],
                "report_json": str(json_path.resolve()),
                "report_markdown": str(md_path.resolve()),
                **report["summary"],
            },
            indent=2,
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
