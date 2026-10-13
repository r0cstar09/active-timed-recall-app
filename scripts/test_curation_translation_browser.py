#!/usr/bin/env python3
"""Fixture-only browser QA for bilingual manual transcript selection.

Run only on a permitted browser worker/CI. Every API request is intercepted;
no learner or production API data is read or written.
"""
from __future__ import annotations

import argparse
import json
import re
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
            "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
            "Cache-Control": "no-store",
        },
        body=json.dumps(payload),
    )


def attach_fixtures(page: Page, base: str, evidence: dict[str, Any]) -> dict[str, Any]:
    state = {
        "retry": False,
        "polls_after_retry": 0,
        "selection_calls": 0,
        "hold_selection": False,
        "pending": [],
        "import_deleted": False,
        "import_delete_attempts": 0,
        "pending_import_delete": None,
        "job_removed": False,
        "job_remove_attempts": 0,
        "pending_job_remove": None,
    }
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
                imports = [] if state["import_deleted"] else [import_fixture()]
                fulfill_json(route, {"imports": imports, "total": len(imports)})
                return
            if request.method == "GET" and parsed.path == "/api/ingest/recent":
                jobs = [
                    {
                        "job_id": 502, "status": "complete", "phrase_count": 2,
                        "active_phrase_count": 2, "ownership_unknown": False,
                        "ownership_message": None, "ownership_mode": "exact", "phrases": [],
                    },
                ]
                if not state["job_removed"]:
                    jobs.append({
                        "job_id": 501, "status": "failed", "phrase_count": 0,
                        "active_phrase_count": 0, "ownership_unknown": False,
                        "ownership_message": None, "ownership_mode": "exact", "phrases": [],
                        "error_message": "Fixture ingest failed.",
                    })
                fulfill_json(route, {"jobs": jobs})
                return
            if request.method == "GET" and parsed.path == "/api/curation/imports/91":
                if state["import_deleted"]:
                    fulfill_json(route, {"detail": "Import not found"}, 404)
                    return
                if state["retry"]:
                    state["polls_after_retry"] += 1
                    ready = state["polls_after_retry"] >= 1
                    fulfill_json(route, import_fixture(status="ready" if ready else "translating", completed=3 if ready else 2))
                else:
                    fulfill_json(route, import_fixture())
                return
            if request.method == "DELETE" and parsed.path == "/api/curation/imports/91":
                state["import_delete_attempts"] += 1
                if state["import_delete_attempts"] == 1:
                    fulfill_json(route, {"detail": "Fixture discard failure; retry is safe."}, 503)
                else:
                    state["pending_import_delete"] = route
                return
            if request.method == "GET" and parsed.path == "/api/ingest/501":
                if state["job_removed"]:
                    fulfill_json(route, {"detail": "Job not found"}, 404)
                else:
                    fulfill_json(route, {
                        "job_id": 501, "status": "failed", "phrase_count": 0,
                        "active_phrase_count": 0, "ownership_unknown": False,
                        "ownership_message": None, "ownership_mode": "exact", "phrases": [],
                        "error_message": "Fixture ingest failed.",
                    })
                return
            if request.method == "DELETE" and parsed.path == "/api/ingest/501":
                state["job_remove_attempts"] += 1
                if state["job_remove_attempts"] == 1:
                    fulfill_json(route, {"detail": "Fixture history removal failure; retry is safe."}, 503)
                else:
                    state["pending_job_remove"] = route
                return
            if request.method == "POST" and parsed.path == "/api/curation/imports/91/translations/retry":
                state["retry"] = True
                fulfill_json(route, import_fixture(status="queued"))
                return
            if request.method == "POST" and parsed.path == "/api/curation/imports/91/translations/selection":
                state["selection_calls"] += 1
                assert isinstance(body, dict), body
                text = body["source_text"]
                value = {
                    "Me quedé en blanco": "My mind went blank.",
                    "Me quedé en blanco cuando me hizo la pregunta.": "My mind went blank when he asked me the question.",
                    "Me quedé en blanco cuando me hizo la pregunta. Después respiré y pude responder.": "I blanked, then took a breath and answered.",
                    "muy nervioso. Me quedé en blanco": "very nervous. My mind went blank",
                }[text]
                if state["hold_selection"]:
                    state["pending"].append((route, value))
                else:
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
    return state


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


def run_removal_flows(page: Page, state: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    def request_count(method: str, path: str) -> int:
        return sum(1 for item in evidence["api_requests"] if item["method"] == method and item["path"] == path)

    discard = page.get_by_role("button", name="Discard transcript", exact=True)
    discard.click()
    discard_group = page.get_by_role("group", name="Confirm discard transcript")
    expect(discard_group).to_be_visible()
    discard_group.get_by_role("button", name="Cancel", exact=True).click()
    expect(discard_group).to_have_count(0)
    assert request_count("DELETE", "/api/curation/imports/91") == 0

    discard.click()
    discard_group = page.get_by_role("group", name="Confirm discard transcript")
    discard_group.get_by_role("button", name="Yes, discard transcript", exact=True).click()
    expect(page.get_by_role("alert").filter(has_text="Fixture discard failure; retry is safe.")).to_be_visible()
    expect(page.get_by_text("Fixture interview", exact=True)).to_be_visible()
    assert page.evaluate("localStorage.getItem('spanish.curation.lastImport')") == "91"
    assert "import=91" in page.url
    assert request_count("DELETE", "/api/curation/imports/91") == 1

    # Two same-tick DOM clicks exercise the synchronous lock before React can
    # disable the button. Exactly one retry request may reach the fixture.
    page.evaluate("""() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => node.textContent?.trim() === 'Yes, discard transcript');
      if (!button) throw new Error('discard confirmation button missing');
      button.click(); button.click();
    }""")
    expect(discard_group.get_by_role("button", name="Discarding…", exact=True)).to_be_disabled()
    assert request_count("DELETE", "/api/curation/imports/91") == 2
    assert state["pending_import_delete"] is not None
    state["import_deleted"] = True
    fulfill_json(state["pending_import_delete"], {"import_id": 91, "removed": True, "history_preserved": True})
    state["pending_import_delete"] = None
    page.get_by_text("Transcript discarded. Existing cards and review history were preserved.", exact=True).wait_for()
    expect(page.get_by_text("Fixture interview", exact=True)).to_have_count(0)
    assert page.evaluate("localStorage.getItem('spanish.curation.lastImport')") is None
    assert "import=" not in page.url

    page.reload(wait_until="networkidle")
    expect(page.get_by_text("Fixture interview", exact=True)).to_have_count(0)
    assert page.evaluate("localStorage.getItem('spanish.curation.lastImport')") is None

    open_failed = page.get_by_role("button", name=re.compile(r"^Job #501 · failed"))
    open_failed.click()
    page.get_by_text("Ingestion job #501", exact=True).wait_for()
    remove_job = page.get_by_role("button", name="Remove job from history", exact=True)
    remove_job.click()
    remove_group = page.get_by_role("group", name="Confirm remove job 501 from history")
    expect(remove_group).to_be_visible()
    remove_group.get_by_role("button", name="Cancel", exact=True).click()
    expect(remove_group).to_have_count(0)
    assert request_count("DELETE", "/api/ingest/501") == 0

    remove_job.click()
    remove_group = page.get_by_role("group", name="Confirm remove job 501 from history")
    remove_group.get_by_role("button", name="Yes, remove job from history", exact=True).click()
    page.get_by_text("Fixture history removal failure; retry is safe.", exact=False).wait_for()
    expect(page.get_by_text("Ingestion job #501", exact=True)).to_be_visible()
    assert page.evaluate("JSON.parse(localStorage.getItem('atr.ingest.active')).jobId") == 501
    assert request_count("DELETE", "/api/ingest/501") == 1

    page.evaluate("""() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => node.textContent?.trim() === 'Yes, remove job from history');
      if (!button) throw new Error('job removal confirmation button missing');
      button.click(); button.click();
    }""")
    expect(remove_group.get_by_role("button", name="Removing…", exact=True)).to_be_disabled()
    assert request_count("DELETE", "/api/ingest/501") == 2
    assert state["pending_job_remove"] is not None
    state["job_removed"] = True
    fulfill_json(state["pending_job_remove"], {"job_id": 501, "removed": True, "history_preserved": True})
    state["pending_job_remove"] = None
    page.get_by_text("Removed job #501 from ingestion history. Existing cards and review history were preserved.", exact=True).wait_for()
    expect(page.get_by_text("Ingestion job #501", exact=True)).to_have_count(0)
    expect(page.get_by_role("button", name=re.compile(r"^Job #501"))).to_have_count(0)
    assert page.evaluate("localStorage.getItem('atr.ingest.active')") is None

    page.reload(wait_until="networkidle")
    expect(page.get_by_role("button", name=re.compile(r"^Job #501"))).to_have_count(0)
    assert page.evaluate("localStorage.getItem('atr.ingest.active')") is None
    card_deletes = [
        item for item in evidence["api_requests"]
        if item["method"] == "DELETE" and item["path"].endswith("/cards")
    ]
    assert not card_deletes, card_deletes
    return {
        "import_delete_requests": request_count("DELETE", "/api/curation/imports/91"),
        "job_delete_requests": request_count("DELETE", "/api/ingest/501"),
        "card_delete_requests": len(card_deletes),
        "refresh_persistence": True,
    }


def run_device(browser: Any, base: str, output: Path, name: str) -> dict[str, Any]:
    evidence: dict[str, Any] = {"device": name, "api_requests": [], "blocked_external": [], "console": [], "page_errors": []}
    context = browser.new_context(**DEVICES[name], color_scheme="light", service_workers="block")
    page = context.new_page()
    page.on("console", lambda message: evidence["console"].append({"type": message.type, "text": message.text, "location": message.location}) if message.type == "error" else None)
    page.on("pageerror", lambda error: evidence["page_errors"].append(str(error)))
    state = attach_fixtures(page, base, evidence)
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

    save = page.get_by_role("button", name="Save selection as draft", exact=True)
    expect(save).to_be_disabled()
    state["hold_selection"] = True
    selected_line = page.get_by_label("Select transcript line 2", exact=True)
    with page.expect_request(
        lambda request: request.method == "POST" and request.url.endswith("/translations/selection"),
        timeout=10_000,
    ) as first_request_info:
        selected_line.focus()
        selected_line.press("Space")
    expect(selected_line).to_be_checked()
    english = page.get_by_label("Selected English meaning", exact=True)
    english.wait_for()
    expect(save).to_be_disabled()
    expect(english).to_have_attribute("placeholder", "Translating the exact selection…")
    assert state["pending"], "translation request must be intercepted, never reach the server"
    # Edit while an automatic response is genuinely in flight.
    english.fill("My in-flight meaning")
    expect(save).to_be_disabled()
    pending_route, value = state["pending"].pop()
    fulfill_json(pending_route, {"english": value})
    state["hold_selection"] = False
    expect(english).to_have_value("My in-flight meaning")
    expect(save).to_be_enabled()
    expect(english).to_have_attribute("placeholder", "English remains editable", timeout=10_000)
    assert english.input_value().strip(), "single-line English translation was empty"
    first_request = first_request_info.value
    assert first_request.post_data_json == {
        "source_text": "Me quedé en blanco cuando me hizo la pregunta.",
        "context_before": "Durante la entrevista estaba muy nervioso.",
        "context_after": "Después respiré y pude responder.",
    }, first_request.post_data_json

    english.fill("My own editable meaning")
    adjacent_line = page.get_by_label("Select transcript line 3", exact=True)
    with page.expect_request(
        lambda request: request.method == "POST" and request.url.endswith("/translations/selection"),
        timeout=10_000,
    ) as adjacent_request_info:
        adjacent_line.focus()
        adjacent_line.press("Space")
    expect(adjacent_line).to_be_checked()
    expect(english).to_have_attribute("placeholder", "English remains editable", timeout=10_000)
    try:
        page.get_by_text("English meaning kept because you edited it.", exact=True).wait_for(timeout=5_000)
        assert english.input_value() == "My own editable meaning"
    except Exception:
        evidence["failure_state"] = {
            "english": english.input_value(),
            "spanish": page.get_by_label("Selected phrase", exact=True).input_value(),
            "statuses": page.get_by_role("status").all_text_contents(),
        }
        page.screenshot(path=str(output / f"bilingual-{name}-failure.png"), full_page=True)
        (output / f"bilingual-{name}-failure.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence["failure_state"]))
        raise
    assert adjacent_request_info.value.post_data_json["source_text"] == (
        "Me quedé en blanco cuando me hizo la pregunta. Después respiré y pude responder."
    ), adjacent_request_info.value.post_data_json

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
    # Select substrings from the Spanish DOM nodes, including a range crossing
    # intervening English. This exercises the actual mouseup extraction handler.
    for selection in [
        {"start": 1, "end": 1, "prefix": "", "last": "Me quedé en blanco", "spanish": "Me quedé en blanco", "english": "My mind went blank."},
        {"start": 0, "end": 1, "prefix": "Durante la entrevista estaba ", "last": "Me quedé en blanco", "spanish": "muy nervioso. Me quedé en blanco", "english": "very nervous. My mind went blank"},
    ]:
        page.get_by_role("button", name="Clear selection", exact=True).click() if page.get_by_role("button", name="Clear selection", exact=True).is_enabled() else None
        page.evaluate("""(s) => {
            const first = document.querySelector(`[data-transcript-text="${s.start}"]`).firstChild;
            const last = document.querySelector(`[data-transcript-text="${s.end}"]`).firstChild;
            const range = document.createRange();
            range.setStart(first, s.prefix.length);
            range.setEnd(last, s.last.length);
            const selected = window.getSelection();
            selected.removeAllRanges(); selected.addRange(range);
            document.querySelector('.curation-transcript').dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
        }""", selection)
        expect(page.get_by_label("Selected phrase", exact=True)).to_have_value(selection["spanish"])
        expect(english).to_have_value(selection["english"], timeout=10_000)
        last_translation = [item for item in evidence["api_requests"] if item["path"].endswith("/translations/selection")][-1]
        assert last_translation["body"]["source_text"] == selection["spanish"]
        assert "English" not in last_translation["body"]["source_text"]
    expect(save).to_be_enabled()
    english.fill(" ")
    expect(save).to_be_disabled()
    english.fill("very nervous. My mind went blank")
    expect(save).to_be_enabled()
    screenshot = output / f"bilingual-{name}.png"
    page.screenshot(path=str(screenshot), full_page=True)
    try:
        evidence["removal_flows"] = run_removal_flows(page, state, evidence)
    except Exception:
        page.screenshot(path=str(output / f"removal-{name}-failure.png"), full_page=True)
        (output / f"removal-{name}-failure.json").write_text(json.dumps(evidence, indent=2) + "\n")
        raise
    removal_screenshot = output / f"history-removal-{name}.png"
    page.screenshot(path=str(removal_screenshot), full_page=True)
    assert not evidence["page_errors"], evidence
    expected_failure_paths = {"/api/curation/imports/91", "/api/ingest/501"}
    evidence["unexpected_console_errors"] = [
        item for item in evidence["console"]
        if not (
            "503" in item["text"] and "Failed to load resource" in item["text"]
            and urlparse(item.get("location", {}).get("url", "")).path in expected_failure_paths
        )
    ]
    assert not evidence["unexpected_console_errors"], evidence

    evidence["layout"] = layout
    evidence["screenshot"] = str(screenshot)
    evidence["removal_screenshot"] = str(removal_screenshot)
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
