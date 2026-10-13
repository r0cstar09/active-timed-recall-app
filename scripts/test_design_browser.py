#!/usr/bin/env python3
"""Read-only visual QA for the Spanish app.

Browser execution for this project belongs on the Alienware browser worker, not
on the VPS. Live runs allow only GET/HEAD/OPTIONS requests; every other HTTP
method is aborted before it reaches the network.

Example:
  python test_design_browser.py \
    --base https://spanish-app.tonymuzo.dev \
    --output /home/rootadmin/spanish-studio-redesign/evidence/before
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.sync_api import Browser, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

ROUTES = ("/", "/session", "/lessons", "/library")
API_ORIGIN = None
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
DEVICES = {
    "desktop": {
        "viewport": {"width": 1440, "height": 1000},
        "screen": {"width": 1440, "height": 1000},
        "is_mobile": False,
        "has_touch": False,
        "device_scale_factor": 1,
    },
    # Browser emulation at the requested CSS viewport; this is not a physical-iPhone claim.
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
}
THEMES = {"light": "paper", "dark": "dark"}

# The live design sweep may render learner-backed API data. Keep its persisted
# report on a strict metadata-only schema: adding a new field fails closed until
# the offline safety test and this allowlist are deliberately updated.
REPORT_ALLOWED_KEYS = frozenset(
    {
        "after",
        "allowed_methods",
        "before",
        "behavior_checks",
        "behavior_error_type",
        "blocked_methods",
        "blocked_mutation_count",
        "blocked_telemetry_count",
        "blocked_mutations",
        "browser_requested",
        "browser_version",
        "capture_count",
        "capture_error_type",
        "captures",
        "category",
        "color_scheme",
        "console",
        "console_error_or_warning_count",
        "count",
        "current_page_count",
        "data_theme",
        "device",
        "document",
        "emulation_note",
        "expected_capture_count",
        "expected_guard_block",
        "final_route_match",
        "generated_at",
        "height",
        "horizontal_overflow",
        "horizontal_overflow_cases",
        "http_error_count",
        "http_errors",
        "initial_navigation",
        "inspection",
        "lang",
        "left",
        "live_mode",
        "mask_count",
        "mask_scope",
        "method",
        "more_menu_passed",
        "navigation",
        "navigation_behavior_passed",
        "navigation_error_type",
        "navigation_failures",
        "navigation_links",
        "network_idle_timeout",
        "ok",
        "overflowers",
        "page_error_count",
        "page_errors",
        "passed",
        "persisted_after_reload",
        "png",
        "privacy",
        "production_test_writes",
        "reason_code",
        "request_failures",
        "right",
        "route",
        "safety",
        "schema_version",
        "scroll_height",
        "scroll_width",
        "screenshots_written",
        "service_workers",
        "screenshot",
        "screenshot_mask_scope",
        "status",
        "stored",
        "summary",
        "tag",
        "target",
        "target_route",
        "theme_after_navigation_passed",
        "theme_behavior_passed",
        "theme_requested",
        "theme_toggle",
        "theme_toggle_count",
        "type",
        "unexpected_console_count",
        "unexpected_request_failure_count",
        "viewport",
        "viewport_requested",
        "visible_count",
        "width",
    }
)
URL_MARKERS = ("http://", "https://", "blob:", "data:")


def diagnostic_category(value: object) -> str:
    message = str(value or "")
    if message == "Service Worker registration blocked by Playwright":
        return "expected_service_worker_block"
    if "ERR_BLOCKED_BY_CLIENT" in message:
        return "expected_guard_block"
    return "unexpected"


def failure_category(value: object) -> str:
    failure = str(value or "").upper()
    if "ABORT" in failure or "CANCEL" in failure:
        return "aborted_or_cancelled"
    if "BLOCKED" in failure:
        return "blocked"
    if "TIMEOUT" in failure or "TIMED_OUT" in failure:
        return "timeout"
    return "other" if failure else "none"


def privacy_safe_inspection(value: dict) -> dict:
    """Copy only geometry and fixed UI metadata from a DOM inspection."""
    navigation = value.get("navigationLinks") or {}
    viewport = value.get("viewport") or {}
    document = value.get("document") or {}
    overflowers = [
        {
            "tag": str(item.get("tag") or "unknown")[:24],
            "left": item.get("left"),
            "right": item.get("right"),
            "width": item.get("width"),
        }
        for item in (value.get("overflowers") or [])[:12]
        if isinstance(item, dict)
    ]
    return {
        "lang": value.get("lang"),
        "data_theme": value.get("dataTheme"),
        "color_scheme": value.get("colorScheme"),
        "viewport": {"width": viewport.get("width"), "height": viewport.get("height")},
        "document": {
            "scroll_width": document.get("scrollWidth"),
            "scroll_height": document.get("scrollHeight"),
        },
        "horizontal_overflow": bool(value.get("horizontalOverflow")),
        "overflowers": overflowers,
        "navigation_links": {
            "count": int(navigation.get("count") or 0),
            "visible_count": int(navigation.get("visibleCount") or 0),
            "current_page_count": int(navigation.get("currentPageCount") or 0),
        },
        "theme_toggle_count": int(value.get("themeToggleCount") or 0),
    }


def assert_privacy_safe_report(value: object, path: str = "report") -> None:
    """Reject report fields or URL-bearing strings outside the safe schema."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key not in REPORT_ALLOWED_KEYS:
                raise ValueError(f"privacy-unsafe report key at {path}: {key}")
            assert_privacy_safe_report(item, f"{path}.{key}")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            assert_privacy_safe_report(item, f"{path}[{index}]")
        return
    if isinstance(value, str) and any(marker in value.lower() for marker in URL_MARKERS):
        raise ValueError(f"privacy-unsafe URL value at {path}")


def capture_privacy_safe_screenshot(page: Page, destination: Path) -> dict:
    """Mask all learner-rendered main content, or refuse to capture."""
    main = page.locator("main#main-content")
    if main.count() != 1 or not main.is_visible():
        raise RuntimeError("required privacy mask target is not uniquely visible")
    page.screenshot(
        path=str(destination),
        full_page=False,
        animations="disabled",
        mask=[main],
        mask_color="#111827",
    )
    return {"mask_scope": "main-content", "mask_count": 1}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only Spanish app visual QA")
    parser.add_argument("--base", required=True, help="Origin to test, e.g. https://spanish-app.tonymuzo.dev")
    parser.add_argument("--output", required=True, type=Path, help="Directory for PNGs and report.json")
    parser.add_argument("--browser", choices=("chromium", "webkit"), default="chromium")
    parser.add_argument("--api-origin", help="Read-only API proxy for localhost static preview only")
    parser.add_argument("--all-routes", action="store_true", help="Check all 11 application routes")
    parser.add_argument("--timeout", type=int, default=15_000, help="Per-operation timeout in milliseconds")
    return parser.parse_args()


def png_dimensions(path: Path) -> dict[str, int]:
    with path.open("rb") as handle:
        signature = handle.read(24)
    if len(signature) != 24 or signature[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"Not a PNG: {path}")
    width, height = struct.unpack(">II", signature[16:24])
    return {"width": width, "height": height}


def inspect_page(page: Page) -> dict:
    raw = page.evaluate(
        """() => {
          const root = document.documentElement;
          const body = document.body;
          const viewportWidth = root.clientWidth;
          const overflowers = [...document.querySelectorAll('body *')]
            .map((element) => {
              const rect = element.getBoundingClientRect();
              if (rect.right <= viewportWidth + 1 && rect.left >= -1) return null;
              return {
                tag: element.tagName.toLowerCase(),
                left: Math.round(rect.left * 10) / 10,
                right: Math.round(rect.right * 10) / 10,
                width: Math.round(rect.width * 10) / 10,
              };
            })
            .filter(Boolean)
            .slice(0, 12);
          const navLinks = [...document.querySelectorAll(
            'nav a[href], header a[href], .tabbar a[href], .recall-command-strip a[href]'
          )];
          return {
            lang: root.lang,
            dataTheme: root.dataset.theme || null,
            colorScheme: getComputedStyle(root).colorScheme,
            viewport: {width: viewportWidth, height: root.clientHeight},
            document: {
              scrollWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0),
              scrollHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0),
            },
            horizontalOverflow: Math.max(root.scrollWidth, body?.scrollWidth || 0) > viewportWidth + 1,
            overflowers,
            navigationLinks: {
              count: navLinks.length,
              visibleCount: navLinks.filter(anchor => !!(
                anchor.offsetWidth || anchor.offsetHeight || anchor.getClientRects().length
              )).length,
              currentPageCount: navLinks.filter(anchor => anchor.getAttribute('aria-current') === 'page').length,
            },
            themeToggleCount: document.querySelectorAll('[data-theme-toggle]').length,
          };
        }"""
    )
    return privacy_safe_inspection(raw)


def attach_read_only_guard(page: Page, log: dict) -> None:
    navigation_generation = 0

    def on_navigation(frame) -> None:
        nonlocal navigation_generation
        if frame == page.main_frame:
            navigation_generation += 1

    page.on("framenavigated", on_navigation)

    def guard(route) -> None:
        request = route.request
        method = request.method.upper()
        if method not in SAFE_METHODS:
            parsed = urlparse(request.url)
            category = "mutation_attempt"
            # Telemetry is still aborted, but only this exact same-origin POST
            # may be reported separately from a fatal application mutation.
            if method == "POST" and parsed.path == "/cdn-cgi/rum" and not parsed.query and not parsed.fragment:
                origin = urlparse(page.url)
                if parsed.scheme in {"http", "https"} and (parsed.scheme, parsed.netloc) == (origin.scheme, origin.netloc):
                    category = "expected_telemetry"
            log["blocked_mutations"].append({"method": method, "category": category})
            route.abort("blockedbyclient")
            return
        parsed = urlparse(request.url)
        if API_ORIGIN and parsed.hostname in {"localhost", "127.0.0.1"} and parsed.path.startswith("/api/"):
            request_generation = navigation_generation
            target = API_ORIGIN + parsed.path + ("?" + parsed.query if parsed.query else "")
            try:
                response = route.fetch(url=target)
                if not page.is_closed():
                    # A genuine same-origin preview proxy: do not carry the
                    # upstream URL metadata into WebKit's local response.
                    route.fulfill(status=response.status, body=response.body(), headers={
                        "content-type": response.headers.get("content-type", "application/json"),
                        "access-control-allow-origin": f"{parsed.scheme}://{parsed.netloc}",
                        "access-control-allow-credentials": "true",
                    })
            except Exception as exc:
                if page.is_closed():
                    return
                # Navigation cancels the old document's reads without closing
                # the Page. Playwright may already have handled that route by
                # the time its upstream response arrives. Only suppress this
                # exact lifecycle error with evidence of a navigation/cancel;
                # genuine errors for the current page remain fatal.
                if "Route is already handled!" in str(exc) and (
                    request_generation != navigation_generation
                    or "ABORT" in (request.failure or "").upper()
                    or "CANCEL" in (request.failure or "").upper()
                ):
                    return
                raise
            return
        route.continue_()

    page.route("**/*", guard)


def attach_observers(page: Page, log: dict) -> None:
    def on_console(message) -> None:
        if message.type in {"warning", "error"}:
            log["console"].append(
                {"type": message.type, "category": diagnostic_category(message.text)}
            )

    def on_response(response) -> None:
        if response.status >= 400:
            log["http_errors"].append(
                {"status": response.status, "method": response.request.method}
            )

    page.on("console", on_console)
    page.on("pageerror", lambda _error: log["page_errors"].append({"category": "page_error"}))
    page.on(
        "requestfailed",
        lambda request: log["request_failures"].append(
            {
                "method": request.method,
                "category": failure_category(request.failure),
                "expected_guard_block": request.method.upper() not in SAFE_METHODS,
            }
        ),
    )
    page.on("response", on_response)


def navigate(page: Page, url: str, expected_route: str, timeout: int) -> dict:
    result = {
        "ok": False,
        "status": None,
        "navigation_error_type": None,
        "final_route_match": False,
    }
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        result["status"] = response.status if response else None
        page.wait_for_timeout(900)
        try:
            page.wait_for_load_state("networkidle", timeout=min(timeout, 3_000))
        except PlaywrightTimeoutError:
            result["network_idle_timeout"] = True
        result["ok"] = True
    except Exception as exc:  # preserve error category rather than stopping the matrix
        result["navigation_error_type"] = type(exc).__name__
    expected_path = expected_route.rstrip("/") or "/"
    actual_path = urlparse(page.url).path.rstrip("/") or "/"
    result["final_route_match"] = actual_path == expected_path
    return result


def run_behavior_checks(browser: Browser, base: str, device_name: str, timeout: int) -> dict:
    device = DEVICES[device_name]
    context = browser.new_context(**device, service_workers="block")
    page = context.new_page()
    log = {"blocked_mutations": [], "console": [], "page_errors": [], "request_failures": [], "http_errors": []}
    attach_read_only_guard(page, log)
    attach_observers(page, log)
    result = {
        "device": device_name,
        "theme_toggle": {"passed": False},
        "navigation": {"passed": False},
        **log,
    }
    try:
        result["initial_navigation"] = navigate(page, urljoin(base + "/", "./"), "/", timeout)
        # Establish a known preference once. An init script would overwrite it
        # on reload and invalidate the persistence check.
        page.evaluate("localStorage.setItem('atr-theme', 'paper')")
        page.reload(wait_until="domcontentloaded", timeout=timeout)
        page.wait_for_timeout(150)
        toggle = page.locator("[data-theme-toggle]").first
        if toggle.count() and toggle.is_visible():
            before = page.locator("html").get_attribute("data-theme")
            toggle.click()
            page.wait_for_timeout(150)
            after = page.locator("html").get_attribute("data-theme")
            stored = page.evaluate("localStorage.getItem('atr-theme')")
            page.reload(wait_until="domcontentloaded", timeout=timeout)
            page.wait_for_timeout(150)
            persisted = page.locator("html").get_attribute("data-theme")
            result["theme_toggle"] = {
                "passed": before != after and after == stored == persisted,
                "before": before,
                "after": after,
                "stored": stored,
                "persisted_after_reload": persisted,
            }
        else:
            result["theme_toggle"]["reason_code"] = "theme_toggle_not_visible"

        page.goto(urljoin(base + "/", "./"), wait_until="domcontentloaded", timeout=timeout)
        candidates = page.locator(
            'nav a[href="/lessons"], header a[href="/lessons"], '
            '.tabbar a[href="/lessons"], .recall-command-strip a[href="/lessons"]'
        )
        clicked = None
        for index in range(candidates.count()):
            candidate = candidates.nth(index)
            if candidate.is_visible():
                clicked = candidate
                break
        if clicked is not None:
            clicked.click()
            page.wait_for_function("location.pathname.replace(/\\/$/, '') === '/lessons'", timeout=timeout)
            page.locator('h1').wait_for(state="visible", timeout=timeout)
            path = urlparse(page.url).path.rstrip("/") or "/"
            result["navigation"] = {
                "passed": path == "/lessons",
                "target_route": "/lessons",
            }
            # Astro swaps page DOM without reloading the document.
            before_swap_toggle = page.locator("html").get_attribute("data-theme")
            page.locator("[data-theme-toggle]").click()
            page.wait_for_function("document.documentElement.dataset.theme !== " + json.dumps(before_swap_toggle))
            result["theme_after_navigation_passed"] = True
            if device_name == "iphone":
                menu = page.locator("[data-nav-more]")
                menu.locator("summary").click()
                assert menu.get_attribute("open") is not None
                assert menu.get_by_role("link", name="Settings", exact=True).is_visible()
                page.keyboard.press("Escape")
                assert menu.get_attribute("open") is None
                result["more_menu_passed"] = True
        else:
            result["navigation"]["reason_code"] = "lessons_navigation_not_visible"
    except Exception as exc:
        result["behavior_error_type"] = type(exc).__name__
    finally:
        context.close()
    return result


def main() -> int:
    global API_ORIGIN, ROUTES
    args = parse_args()
    API_ORIGIN = args.api_origin.rstrip("/") if args.api_origin else None
    if API_ORIGIN and urlparse(args.base).hostname not in {"localhost", "127.0.0.1"}:
        raise SystemExit("--api-origin is only permitted for localhost preview QA")
    if args.all_routes:
        ROUTES = ("/", "/session", "/write", "/lessons", "/lessons/patterns", "/verbs", "/library", "/misses", "/review", "/ingest", "/settings")
    base = args.base.rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit("--base must be an absolute http(s) origin")
    args.output.mkdir(parents=True, exist_ok=True)

    report = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "target": (
            "live-read-only-origin"
            if parsed.hostname not in {"localhost", "127.0.0.1"}
            else "localhost-preview-with-read-only-api"
            if API_ORIGIN
            else "localhost-static-preview"
        ),
        "browser_requested": args.browser,
        "safety": {
            "live_mode": parsed.scheme == "https" and parsed.hostname not in {"localhost", "127.0.0.1"},
            "allowed_methods": sorted(SAFE_METHODS),
            "blocked_methods": ["POST", "PUT", "PATCH", "DELETE", "and every other non-safe method"],
            "service_workers": "blocked",
            "production_test_writes": 0,
            "screenshot_mask_scope": "main-content",
        },
        "emulation_note": "iPhone results use browser mobile emulation at 390x844 CSS px; no physical iPhone was tested.",
        "captures": [],
        "behavior_checks": [],
        "summary": {},
    }

    with sync_playwright() as playwright:
        browser_type = getattr(playwright, args.browser)
        browser = browser_type.launch(headless=True)
        report["browser_version"] = browser.version
        try:
            for device_name, device in DEVICES.items():
                for theme_name, theme_value in THEMES.items():
                    context = browser.new_context(**device, service_workers="block")
                    context.add_init_script(
                        "localStorage.setItem('atr-theme', " + json.dumps(theme_value) + ")"
                    )
                    for route in ROUTES:
                        # Isolate full-document screenshots. A slow read from
                        # the previous document can otherwise be reported by
                        # WebKit as an access-control error on the next page.
                        # SPA navigation is tested separately below.
                        page = context.new_page()
                        log = {
                            "blocked_mutations": [],
                            "console": [],
                            "page_errors": [],
                            "request_failures": [],
                            "http_errors": [],
                        }
                        attach_read_only_guard(page, log)
                        attach_observers(page, log)
                        slug = "home" if route == "/" else route.strip("/").replace("/", "-")
                        filename = f"{args.browser}-{device_name}-{theme_name}-{slug}.png"
                        destination = args.output / filename
                        before_counts = {key: len(value) for key, value in log.items()}
                        nav = navigate(page, base + route, route, args.timeout)
                        capture = {
                            "route": route,
                            "device": device_name,
                            "theme_requested": theme_name,
                            "viewport_requested": device["viewport"],
                            "screenshot": filename,
                            "navigation": nav,
                        }
                        try:
                            capture["inspection"] = inspect_page(page)
                            capture["privacy"] = capture_privacy_safe_screenshot(page, destination)
                            capture["png"] = png_dimensions(destination)
                        except Exception as exc:
                            capture["capture_error_type"] = type(exc).__name__
                        for key, values in log.items():
                            capture[key] = values[before_counts[key] :]
                        report["captures"].append(capture)
                        page.close()
                    context.close()
            for device_name in DEVICES:
                report["behavior_checks"].append(
                    run_behavior_checks(browser, base, device_name, args.timeout)
                )
        finally:
            browser.close()

    captures = report["captures"]
    observed_runs = [*captures, *report["behavior_checks"]]
    report["summary"] = {
        "expected_capture_count": len(ROUTES) * len(DEVICES) * len(THEMES),
        "capture_count": len(captures),
        "screenshots_written": sum((args.output / item["screenshot"]).is_file() for item in captures),
        "navigation_failures": sum(
            not item["navigation"]["ok"] or not item["navigation"]["final_route_match"]
            for item in captures
        ),
        "horizontal_overflow_cases": sum(
            bool(item.get("inspection", {}).get("horizontal_overflow")) for item in captures
        ),
        "console_error_or_warning_count": sum(len(item["console"]) for item in observed_runs),
        "unexpected_console_count": sum(
            message["category"] == "unexpected"
            for item in observed_runs
            for message in item["console"]
        ),
        "page_error_count": sum(len(item["page_errors"]) for item in observed_runs),
        "http_error_count": sum(len(item["http_errors"]) for item in observed_runs),
        "unexpected_request_failure_count": sum(
            not item["expected_guard_block"] and item["category"] not in {"blocked", "aborted_or_cancelled"}
            for run in observed_runs
            for item in run["request_failures"]
        ),
        "blocked_mutation_count": sum(
            event.get("category") != "expected_telemetry"
            for item in observed_runs for event in item["blocked_mutations"]
        ),
        "blocked_telemetry_count": sum(
            event.get("category") == "expected_telemetry"
            for item in observed_runs for event in item["blocked_mutations"]
        ),
        "theme_behavior_passed": all(
            item["theme_toggle"]["passed"] for item in report["behavior_checks"]
        ),
        "navigation_behavior_passed": all(
            item["navigation"]["passed"] for item in report["behavior_checks"]
        ),
        "theme_after_navigation_passed": all(item.get("theme_after_navigation_passed", False) for item in report["behavior_checks"]),
        "more_menu_passed": all(item.get("more_menu_passed", False) for item in report["behavior_checks"] if item["device"] == "iphone"),
    }
    report["status"] = (
        "passed"
        if report["summary"]["screenshots_written"] == report["summary"]["expected_capture_count"]
        and report["summary"]["navigation_failures"] == 0
        and report["summary"]["horizontal_overflow_cases"] == 0
        and report["summary"]["page_error_count"] == 0
        and report["summary"]["http_error_count"] == 0
        and report["summary"]["unexpected_console_count"] == 0
        and report["summary"]["unexpected_request_failure_count"] == 0
        and report["summary"]["blocked_mutation_count"] == 0
        and report["summary"]["theme_behavior_passed"]
        and report["summary"]["navigation_behavior_passed"]
        and report["summary"]["theme_after_navigation_passed"]
        and report["summary"]["more_menu_passed"]
        else "failed"
    )
    report_path = args.output / "report.json"
    assert_privacy_safe_report(report)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), "status": report["status"], **report["summary"]}, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
