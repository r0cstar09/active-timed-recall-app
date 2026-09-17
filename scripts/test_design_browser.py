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
    return page.evaluate(
        """() => {
          const root = document.documentElement;
          const body = document.body;
          const viewportWidth = root.clientWidth;
          const overflowers = [...document.querySelectorAll('body *')]
            .map((element) => {
              const rect = element.getBoundingClientRect();
              if (rect.right <= viewportWidth + 1 && rect.left >= -1) return null;
              const id = element.id ? `#${element.id}` : '';
              const classes = typeof element.className === 'string'
                ? element.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).map(c => `.${c}`).join('')
                : '';
              return {
                selector: `${element.tagName.toLowerCase()}${id}${classes}`,
                left: Math.round(rect.left * 10) / 10,
                right: Math.round(rect.right * 10) / 10,
                width: Math.round(rect.width * 10) / 10,
              };
            })
            .filter(Boolean)
            .slice(0, 12);
          const navLinks = [...document.querySelectorAll(
            'nav a[href], header a[href], .tabbar a[href], .recall-command-strip a[href]'
          )].map((anchor) => ({
            text: (anchor.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
            href: anchor.getAttribute('href'),
            visible: !!(anchor.offsetWidth || anchor.offsetHeight || anchor.getClientRects().length),
            ariaCurrent: anchor.getAttribute('aria-current'),
            className: typeof anchor.className === 'string' ? anchor.className : '',
          }));
          return {
            title: document.title,
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
            navLinks,
            themeToggleCount: document.querySelectorAll('[data-theme-toggle]').length,
            bodyTextPreview: (body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
          };
        }"""
    )


def attach_read_only_guard(page: Page, log: dict) -> None:
    def guard(route) -> None:
        request = route.request
        method = request.method.upper()
        if method not in SAFE_METHODS:
            log["blocked_mutations"].append({"method": method, "url": request.url})
            route.abort("blockedbyclient")
            return
        parsed = urlparse(request.url)
        if API_ORIGIN and parsed.hostname in {"localhost", "127.0.0.1"} and parsed.path.startswith("/api/"):
            target = API_ORIGIN + parsed.path + ("?" + parsed.query if parsed.query else "")
            try:
                response = route.fetch(url=target)
                if not page.is_closed():
                    route.fulfill(response=response)
            except Exception:
                # Astro can leave read-only background requests pending when
                # a screenshot context is closed. Never mask a live-page error.
                if not page.is_closed():
                    raise
            return
        route.continue_()

    page.route("**/*", guard)


def attach_observers(page: Page, log: dict) -> None:
    def on_console(message) -> None:
        if message.type in {"warning", "error"}:
            log["console"].append({"type": message.type, "text": message.text})

    def on_response(response) -> None:
        if response.status >= 400:
            log["http_errors"].append(
                {"status": response.status, "method": response.request.method, "url": response.url}
            )

    page.on("console", on_console)
    page.on("pageerror", lambda error: log["page_errors"].append(str(error)))
    page.on(
        "requestfailed",
        lambda request: log["request_failures"].append(
            {
                "method": request.method,
                "url": request.url,
                "failure": request.failure,
                "expected_guard_block": request.method.upper() not in SAFE_METHODS,
            }
        ),
    )
    page.on("response", on_response)


def navigate(page: Page, url: str, timeout: int) -> dict:
    result = {"url": url, "ok": False, "navigation_error": None, "final_url": None}
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        result["status"] = response.status if response else None
        page.wait_for_timeout(900)
        try:
            page.wait_for_load_state("networkidle", timeout=min(timeout, 3_000))
        except PlaywrightTimeoutError:
            result["network_idle_timeout"] = True
        result["ok"] = True
    except Exception as exc:  # preserve visual/error evidence rather than stopping the matrix
        result["navigation_error"] = f"{type(exc).__name__}: {exc}"
    result["final_url"] = page.url
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
        result["initial_navigation"] = navigate(page, urljoin(base + "/", "./"), timeout)
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
                "persistedAfterReload": persisted,
            }
        else:
            result["theme_toggle"]["reason"] = "No visible [data-theme-toggle] control"

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
            href = clicked.get_attribute("href")
            clicked.click()
            page.wait_for_function("location.pathname.replace(/\\/$/, '') === '/lessons'", timeout=timeout)
            page.locator('h1').wait_for(state="visible", timeout=timeout)
            path = urlparse(page.url).path.rstrip("/") or "/"
            result["navigation"] = {
                "passed": path == "/lessons",
                "clickedHref": href,
                "finalUrl": page.url,
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
            result["navigation"]["reason"] = "No visible navigation link to /lessons"
    except Exception as exc:
        result["behavior_error"] = f"{type(exc).__name__}: {exc}"
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
        "base": base,
        "output": str(args.output.resolve()),
        "browser_requested": args.browser,
        "browser_execution_host": None,
        "safety": {
            "live_mode": parsed.scheme == "https" and parsed.hostname not in {"localhost", "127.0.0.1"},
            "allowed_methods": sorted(SAFE_METHODS),
            "blocked_methods": ["POST", "PUT", "PATCH", "DELETE", "and every other non-safe method"],
            "service_workers": "blocked",
            "production_test_writes": 0,
        },
        "emulation_note": "iPhone results use browser mobile emulation at 390x844 CSS px; no physical iPhone was tested.",
        "captures": [],
        "behavior_checks": [],
        "summary": {},
    }

    import socket

    report["browser_execution_host"] = socket.gethostname()
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
                    for route in ROUTES:
                        slug = "home" if route == "/" else route.strip("/").replace("/", "-")
                        filename = f"{args.browser}-{device_name}-{theme_name}-{slug}.png"
                        destination = args.output / filename
                        before_counts = {key: len(value) for key, value in log.items()}
                        nav = navigate(page, base + route, args.timeout)
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
                            page.screenshot(path=str(destination), full_page=False)
                            capture["png"] = png_dimensions(destination)
                        except Exception as exc:
                            capture["capture_error"] = f"{type(exc).__name__}: {exc}"
                        for key, values in log.items():
                            capture[key] = values[before_counts[key] :]
                        report["captures"].append(capture)
                    context.close()
            for device_name in DEVICES:
                report["behavior_checks"].append(
                    run_behavior_checks(browser, base, device_name, args.timeout)
                )
        finally:
            browser.close()

    captures = report["captures"]
    report["summary"] = {
        "expected_capture_count": len(ROUTES) * len(DEVICES) * len(THEMES),
        "capture_count": len(captures),
        "screenshots_written": sum((args.output / item["screenshot"]).is_file() for item in captures),
        "navigation_failures": sum(not item["navigation"]["ok"] for item in captures),
        "horizontal_overflow_cases": sum(
            bool(item.get("inspection", {}).get("horizontalOverflow")) for item in captures
        ),
        "console_error_or_warning_count": sum(len(item["console"]) for item in captures),
        "unexpected_console_count": sum(
            message["text"] != "Service Worker registration blocked by Playwright"
            and "ERR_BLOCKED_BY_CLIENT" not in message["text"]
            for item in captures
            for message in item["console"]
        ),
        "page_error_count": sum(len(item["page_errors"]) for item in captures),
        "http_error_count": sum(len(item["http_errors"]) for item in captures),
        "blocked_mutation_count": sum(len(item["blocked_mutations"]) for item in captures)
        + sum(len(item["blocked_mutations"]) for item in report["behavior_checks"]),
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
        and report["summary"]["theme_behavior_passed"]
        and report["summary"]["navigation_behavior_passed"]
        and report["summary"]["theme_after_navigation_passed"]
        and report["summary"]["more_menu_passed"]
        else "failed"
    )
    report_path = args.output / "report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), "status": report["status"], **report["summary"]}, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
