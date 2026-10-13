#!/usr/bin/env python3
"""Fixture-only browser QA for bilingual manual transcript selection.

Run only on a permitted browser worker/CI. Every API request is intercepted;
no learner or production API data is read or written.
"""
from __future__ import annotations

import argparse
import json
from copy import deepcopy
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import Page, expect, sync_playwright


DEVICES: dict[str, dict[str, Any]] = {
    "desktop": {"viewport": {"width": 1440, "height": 1000}},
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


def import_fixture(*, status: str = "failed", completed: int = 2) -> dict[str, Any]:
    english = [
        "During the interview, I was very nervous.",
        "I blanked when he asked me the question.",
        "Then I took a breath and was able to answer.",
    ]
    transcript = [
        {"index": 0, "text": "Durante la entrevista estaba muy nervioso.", "english": english[0], "start": 0, "end": 2},
        {"index": 1, "text": "Me quedé en blanco cuando me hizo la pregunta.", "english": english[1], "start": 2, "end": 5},
        {"index": 2, "text": "Después respiré y pude responder.", "english": english[2] if completed == 3 else None, "start": 5, "end": 7},
    ]
    return {
        "id": 91,
        "source_url": "https://www.youtube.com/watch?v=abcdefghijk",
        "video_id": "abcdefghijk",
        "source_id": None,
        "title": "Fixture interview",
        "status": "ready",
        "error_message": None,
        "translation_status": status,
        "translation_error": "The English provider timed out. Retry is safe.",
        "translation_completed": completed,
        "translation_total": 3,
        "transcript": transcript,
        "source_audio_url": None,
        "drafts": [],
        "created_at": "2026-10-13T00:00:00Z",
        "updated_at": "2026-10-13T00:00:00Z",
    }


def fulfill_json(route: Any, payload: Any, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "content-type,accept",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Cache-Control": "no-store",
        },
        body=json.dumps(payload),
    )


def attach_fixtures(page: Page, base: str, evidence: dict[str, Any]) -> None:
    state = {"retry": False, "polls_after_retry": 0, "selection_calls": 0}
    base_origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"

    def handle(route: Any) -> None:
        request = route.request
        parsed = urlparse(request.url)
        if request.method == "OPTIONS":
            fulfill_json(route, {})
            return
        if parsed.path.startswith("/api/"):
            body = json.loads(request.post_data) if request.post_data else None
            evidence["api_requests"].append({"method": request.method, "path": parsed.path, "body": body})
            if request.method == "GET" and parsed.path == "/api/curation/imports":
                fulfill_json(route, {"imports": [import_fixture()], "total": 1})
                return
            if request.method == "GET" and parsed.path == "/api/ingest/recent":
                fulfill_json(route, {"jobs": []})
                return
            if request.method == "GET" and parsed.path == "/api/curation/imports/91":
                if state["retry"]:
                    state["polls_after_retry"] += 1
                    ready = state["polls_after_retry"] >= 1
                    fulfill_json(route, import_fixture(status="ready" if ready else "translating", completed=3 if ready else 2))
                else:
                    fulfill_json(route, import_fixture())
                return
            if request.method == "POST" and parsed.path == "/api/curation/imports/91/translations/retry":
                state["retry"] = True
                fulfill_json(route, import_fixture(status="queued"))
                return
            if request.method == "POST" and parsed.path == "/api/curation/imports/91/translations/selection":
                state["selection_calls"] += 1
                value = "My mind went blank when he asked me the question." if state["selection_calls"] == 1 else "SHOULD NOT OVERWRITE MANUAL ENGLISH"
                fulfill_json(route, {"english": value})
                return
            if request.method == "POST" and parsed.path == "/api/curation/imports/91/drafts":
                assert isinstance(body, dict), body
                selection = body["selections"][0]
                fulfill_json(route, {"drafts": [{
                    "id": 701,
                    "import_id": 91,
                    "phrase_id": None,
                    "status": "draft",
                    "error_message": None,
                    "segment_indices": selection["segment_indices"],
                    "spanish": selection["spanish"],
                    "english": selection["english"],
                    "start_time": 2,
                    "end_time": 7,
                    "rough_start": 2,
                    "rough_end": 7,
                    "audio_path": None,
                    "audio_url": None,
                    "alignment_method": None,
                    "alignment_confidence": None,
                    "alignment_warning": None,
                    "approved": False,
                    "revision": 1,
                    "created_at": "2026-10-13T00:00:00Z",
                    "updated_at": "2026-10-13T00:00:00Z",
                }]})
                return
            fulfill_json(route, {"detail": f"Unexpected fixture route: {request.method} {parsed.path}"}, 501)
            return
        if request.url.startswith(base_origin):
            route.continue_()
            return
        evidence["blocked_external"].append({"method": request.method, "url": request.url})
        route.abort()

    page.route("**/*", handle)


def assert_layout(page: Page) -> dict[str, Any]:
    return page.evaluate(
        """() => ({
          viewport: {width: document.documentElement.clientWidth, height: document.documentElement.clientHeight},
          scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          bilingualRows: [...document.querySelectorAll('.curation-line')].map((row) => {
            const spanish = row.querySelector('[data-transcript-text]');
            const english = row.querySelector('.curation-line-english');
            const spanishRect = spanish?.getBoundingClientRect();
            const englishRect = english?.getBoundingClientRect();
            return {
              spanish: (spanish?.textContent || '').trim(),
              english: (english?.textContent || '').trim(),
              spanishTop: Math.round(spanishRect?.top || 0),
              englishTop: Math.round(englishRect?.top || 0),
              englishHeight: Math.round(englishRect?.height || 0),
            };
          }),
          retryRect: (() => {
            const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Retry English translations'));
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            return {width: Math.round(rect.width), height: Math.round(rect.height)};
          })(),
        })"""
    )


def run_device(browser: Any, base: str, output: Path, name: str) -> dict[str, Any]:
    evidence: dict[str, Any] = {"device": name, "api_requests": [], "blocked_external": [], "console": [], "page_errors": []}
    context = browser.new_context(**DEVICES[name], color_scheme="light")
    page = context.new_page()
    page.on("console", lambda message: evidence["console"].append({"type": message.type, "text": message.text}) if message.type == "error" else None)
    page.on("pageerror", lambda error: evidence["page_errors"].append(str(error)))
    attach_fixtures(page, base, evidence)
    page.goto(f"{base.rstrip('/')}/ingest/?import=91", wait_until="networkidle")

    page.get_by_text("During the interview, I was very nervous.", exact=True).wait_for()
    page.get_by_text("I blanked when he asked me the question.", exact=True).wait_for()
    page.get_by_text("English translation loading…", exact=True).wait_for()
    page.get_by_text("English translations: 2 of 3.", exact=False).wait_for()
    page.get_by_text("Spanish selection is still available.", exact=False).wait_for()
    layout = assert_layout(page)
    assert layout["scrollWidth"] <= layout["viewport"]["width"], layout
    assert len(layout["bilingualRows"]) == 3, layout
    assert all(row["englishHeight"] > 0 for row in layout["bilingualRows"]), layout
    assert all(row["englishTop"] > row["spanishTop"] for row in layout["bilingualRows"]), layout
    assert layout["retryRect"] and layout["retryRect"]["height"] >= 40, layout

    selected_line = page.get_by_label("Select transcript line 2", exact=True)
    selected_line.click()
    expect(selected_line).to_be_checked()
    english = page.get_by_label("English meaning", exact=True)
    english.wait_for()
    expect(english).to_have_attribute("placeholder", "Translating the exact selection…", timeout=5_000)
    expect(english).to_have_attribute("placeholder", "English remains editable", timeout=10_000)
    assert english.input_value().strip(), "single-line English translation was empty"
    first_request = next(item for item in evidence["api_requests"] if item["path"].endswith("/translations/selection"))
    assert first_request["body"] == {
        "source_text": "Me quedé en blanco cuando me hizo la pregunta.",
        "context_before": "Durante la entrevista estaba muy nervioso.",
        "context_after": "Después respiré y pude responder.",
    }, first_request

    english.fill("My own editable meaning")
    adjacent_line = page.get_by_label("Select transcript line 3", exact=True)
    adjacent_line.click()
    expect(adjacent_line).to_be_checked()
    expect(english).to_have_attribute("placeholder", "Translating the exact selection…", timeout=5_000)
    expect(english).to_have_attribute("placeholder", "English remains editable", timeout=10_000)
    page.get_by_text("English meaning kept because you edited it.", exact=True).wait_for(timeout=5_000)
    assert english.input_value() == "My own editable meaning"
    selection_requests = [item for item in evidence["api_requests"] if item["path"].endswith("/translations/selection")]
    assert selection_requests[-1]["body"]["source_text"] == (
        "Me quedé en blanco cuando me hizo la pregunta. Después respiré y pude responder."
    ), selection_requests

    page.get_by_role("button", name="Retry English translations", exact=True).click()
    page.get_by_text("Then I took a breath and was able to answer.", exact=True).wait_for(timeout=6_000)
    page.get_by_role("button", name="Save selection as draft", exact=True).click()
    page.get_by_text("Selection saved as a draft.", exact=False).wait_for()
    draft_request = next(item for item in evidence["api_requests"] if item["path"].endswith("/drafts") and item["method"] == "POST")
    assert draft_request["body"]["selections"] == [{
        "segment_indices": [1, 2],
        "spanish": "Me quedé en blanco cuando me hizo la pregunta. Después respiré y pude responder.",
        "english": "My own editable meaning",
    }], draft_request
    assert not evidence["page_errors"], evidence
    assert not evidence["console"], evidence

    screenshot = output / f"bilingual-{name}.png"
    page.screenshot(path=str(screenshot), full_page=True)
    evidence["layout"] = layout
    evidence["screenshot"] = str(screenshot)
    context.close()
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18764")
    parser.add_argument("--browser", choices=("chromium", "webkit"), default="chromium")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = getattr(playwright, args.browser).launch(headless=True)
        runs = [run_device(browser, args.base, args.output, name) for name in DEVICES]
        browser.close()
    report = {"browser": args.browser, "fixture_only": True, "production_writes": 0, "runs": runs}
    report_path = args.output / "bilingual-report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": "passed", "browser": args.browser, "devices": list(DEVICES), "report": str(report_path)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
