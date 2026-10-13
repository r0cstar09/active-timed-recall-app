#!/usr/bin/env python3
"""Fixture-only browser QA for clip splitting and playhead trimming.

Run only in repository CI or an approved browser worker. Every API/media request
is intercepted; this script never reads or mutates learner or production data.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import re
import struct
import wave
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

QUESTION = "¿Qué cambió en el descanso?"
ANSWER = "Salimos con más intensidad y marcamos pronto."
COMBINED = f"{QUESTION} {ANSWER}"
COMBINED_ENGLISH = "What changed at halftime? We came out with more intensity and scored early."


def tone_wav(seconds: float, frequency: float) -> bytes:
    output = io.BytesIO()
    sample_rate = 8_000
    frames = bytearray()
    sample_count = int(seconds * sample_rate)
    for index in range(sample_count):
        envelope = min(1.0, index / 80, (sample_count - index) / 80)
        sample = int(6_000 * envelope * math.sin(2 * math.pi * frequency * index / sample_rate))
        frames.extend(struct.pack("<h", sample))
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(frames)
    return output.getvalue()


SOURCE_WAV = tone_wav(24, 330)
COMBINED_WAV = tone_wav(8.2, 440)
LEFT_WAV = tone_wav(3.4, 550)
RIGHT_WAV = tone_wav(4.8, 660)


def draft(draft_id: int = 701, **changes: Any) -> dict[str, Any]:
    base = {
        "id": draft_id,
        "import_id": 91,
        "segment_indices": [4, 5],
        "spanish": COMBINED,
        "english": COMBINED_ENGLISH,
        "start_time": 9.8,
        "end_time": 18.0,
        "revision": 3,
        "status": "ready",
        "approved": True,
        "warning": None,
        "error_message": None,
        "audio_url": "/api/audio/combined.wav",
        "repair_phrase_id": None,
        "phrase_id": None,
        "existing_phrase_id": None,
        "existing_active": None,
        "manual_timing": True,
        "created_at": "2026-10-13T00:00:00Z",
        "updated_at": "2026-10-13T00:00:00Z",
    }
    base.update(changes)
    return base


def import_fixture(drafts: list[dict[str, Any]], import_id: int = 91, title: str = "Fixture press conference") -> dict[str, Any]:
    return {
        "id": import_id,
        "source_id": 5,
        "source_url": "https://www.youtube.com/watch?v=abcdefghijk",
        "video_id": "abcdefghijk",
        "title": title,
        "status": "ready",
        "error_message": None,
        "translation_status": "ready",
        "translation_error": None,
        "translation_completed": 2,
        "translation_total": 2,
        "transcript": [
            {
                "index": 4,
                "text": QUESTION,
                "english": "What changed at halftime?",
                "start": 10.0,
                "end": 14.759,
            },
            {
                "index": 5,
                "text": ANSWER,
                "english": "We came out with more intensity and scored early.",
                "start": 12.559,
                "end": 17.8,
            },
        ],
        "drafts": deepcopy(drafts),
        "source_audio_url": "/api/audio/source.wav",
        "created_at": "2026-10-13T00:00:00Z",
        "updated_at": "2026-10-13T00:00:00Z",
    }


def fulfill_json(route: Any, payload: Any, status: int = 200) -> None:
    route.fulfill(
        status=status,
        content_type="application/json",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "content-type,accept,range",
            "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
            "Cache-Control": "no-store",
        },
        body=json.dumps(payload),
    )


def fulfill_audio(route: Any, body: bytes) -> None:
    route.fulfill(
        status=200,
        headers={
            "Content-Type": "audio/wav",
            "Content-Length": str(len(body)),
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
        },
        body=body,
    )


def attach_fixtures(page: Page, base: str, evidence: dict[str, Any]) -> dict[str, Any]:
    state: dict[str, Any] = {
        "drafts": [draft()],
        "split_attempts": 0,
        "split_complete": False,
    }
    base_origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"

    def prepare_split_children() -> None:
        if not state["split_complete"]:
            return
        for item in state["drafts"]:
            if item["status"] in {"queued", "preparing"}:
                item["status"] = "ready"
                item["audio_url"] = "/api/audio/left.wav" if item["id"] == 701 else "/api/audio/right.wav"
                item["english"] = "What changed at halftime?" if item["id"] == 701 else "We came out with more intensity and scored early."

    def handle(route: Any) -> None:
        request = route.request
        parsed = urlparse(request.url)
        if request.method == "GET" and (
            request.url.startswith(f"blob:{base_origin}/")
            or request.url.startswith("data:")
        ):
            # WebKit fetches native media-control icons through same-origin blob
            # URLs. They are browser-owned local resources, not external traffic.
            route.continue_()
            return
        if request.method == "OPTIONS":
            fulfill_json(route, {})
            return
        audio_payloads = {
            "/api/audio/source.wav": SOURCE_WAV,
            "/api/audio/combined.wav": COMBINED_WAV,
            "/api/audio/left.wav": LEFT_WAV,
            "/api/audio/right.wav": RIGHT_WAV,
        }
        if parsed.path in audio_payloads:
            evidence["media_requests"].append({"method": request.method, "path": parsed.path})
            fulfill_audio(route, audio_payloads[parsed.path])
            return
        if parsed.path.startswith("/api/"):
            body = json.loads(request.post_data) if request.post_data else None
            evidence["api_requests"].append({"method": request.method, "path": parsed.path, "body": body})
            if request.method == "GET" and parsed.path == "/api/curation/imports":
                other = import_fixture([], import_id=92, title="Other fixture source")
                fulfill_json(route, {"imports": [import_fixture(state["drafts"]), other], "total": 2})
                return
            if request.method == "GET" and parsed.path == "/api/curation/imports/91":
                prepare_split_children()
                fulfill_json(route, import_fixture(state["drafts"]))
                return
            if request.method == "GET" and parsed.path == "/api/curation/imports/92":
                fulfill_json(route, import_fixture([], import_id=92, title="Other fixture source"))
                return
            if request.method == "GET" and parsed.path == "/api/ingest/recent":
                fulfill_json(route, {"jobs": []})
                return
            if request.method == "POST" and parsed.path == "/api/curation/imports/91/translations/selection":
                fulfill_json(route, {"english": "What changed at halftime?"})
                return
            if request.method == "POST" and parsed.path == "/api/curation/drafts/701/split":
                state["split_attempts"] += 1
                assert body == {
                    "revision": 3,
                    "split_time": 13.2,
                    "left": {"spanish": QUESTION, "english": ""},
                    "right": {"spanish": ANSWER, "english": ""},
                }, body
                if state["split_attempts"] == 1:
                    fulfill_json(route, {"detail": "Fixture split failure; retry is safe."}, 503)
                    return
                left = draft(
                    spanish=QUESTION,
                    english="",
                    segment_indices=[4],
                    end_time=13.2,
                    revision=4,
                    status="queued",
                    audio_url=None,
                    approved=False,
                )
                right = draft(
                    draft_id=702,
                    spanish=ANSWER,
                    english="",
                    segment_indices=[5],
                    start_time=13.2,
                    revision=1,
                    status="queued",
                    audio_url=None,
                    approved=False,
                )
                state["drafts"] = [left, right]
                state["split_complete"] = True
                fulfill_json(route, {"drafts": deepcopy(state["drafts"])})
                return
            match = re.fullmatch(r"/api/curation/drafts/(701|702)", parsed.path)
            if request.method == "PATCH" and match:
                draft_id = int(match.group(1))
                item = next(value for value in state["drafts"] if value["id"] == draft_id)
                assert isinstance(body, dict) and body["revision"] == item["revision"], (body, item)
                changed_content = False
                for source, target in (("spanish", "spanish"), ("english", "english"), ("start_time", "start_time"), ("end_time", "end_time")):
                    if source in body:
                        item[target] = body[source]
                        changed_content = True
                if changed_content:
                    item.update({"status": "draft", "audio_url": None, "approved": False})
                if "approved" in body:
                    assert item["status"] in {"ready", "needs_review"}
                    item["approved"] = bool(body["approved"])
                item["revision"] += 1
                fulfill_json(route, deepcopy(item))
                return
            if request.method == "POST" and parsed.path == "/api/curation/prepare":
                assert isinstance(body, dict) and len(body.get("drafts", [])) == 1, body
                ref = body["drafts"][0]
                item = next(value for value in state["drafts"] if value["id"] == ref["id"])
                assert ref["revision"] == item["revision"], (ref, item)
                item.update({
                    "revision": item["revision"] + 1,
                    "status": "ready",
                    "approved": False,
                    "audio_url": "/api/audio/left.wav" if item["id"] == 701 else "/api/audio/right.wav",
                })
                fulfill_json(route, {"drafts": [deepcopy(item)]})
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


def request_count(evidence: dict[str, Any], method: str, path: str) -> int:
    return sum(1 for item in evidence["api_requests"] if item["method"] == method and item["path"] == path)


def beforeunload_prevented(page: Page) -> bool:
    return bool(page.evaluate("""() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }"""))


def run_device(browser: Any, base: str, output: Path, name: str) -> dict[str, Any]:
    evidence: dict[str, Any] = {
        "device": name,
        "api_requests": [],
        "media_requests": [],
        "blocked_external": [],
        "console": [],
        "page_errors": [],
    }
    context = browser.new_context(**DEVICES[name], color_scheme="light", service_workers="block")
    page = context.new_page()
    page.add_init_script("""() => {
      window.__mediaSeekWrites = [];
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      if (!descriptor?.get || !descriptor?.set) throw new Error('currentTime descriptor unavailable');
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get() { return descriptor.get.call(this); },
        set(value) {
          window.__mediaSeekWrites.push({ label: this.getAttribute('aria-label'), value });
          return descriptor.set.call(this, value);
        },
      });
    }""")
    page.on("console", lambda message: evidence["console"].append({"type": message.type, "text": message.text, "location": message.location}) if message.type == "error" else None)
    page.on("pageerror", lambda error: evidence["page_errors"].append(str(error)))
    state = attach_fixtures(page, base, evidence)
    try:
        page.goto(f"{base.rstrip('/')}/ingest/?import=91", wait_until="networkidle")

        original = page.get_by_role("article", name="Draft 701", exact=True)
        expect(original).to_be_visible()
        expect(page.get_by_role("button", name="Add approved (1)", exact=True)).to_be_enabled()

        # Real decodable media must advance without React feeding every clock tick
        # back into currentTime. play() is native; only the UI button starts it.
        trim_audio = original.get_by_label("Draft 701 trim playhead audio", exact=True)
        trim_seek = original.get_by_label("Draft 701 trim playhead seek", exact=True)
        page.wait_for_function("node => node.readyState >= 1", arg=trim_audio.element_handle())
        trim_seek.fill("10.3")
        page.wait_for_timeout(80)
        page.evaluate("window.__mediaSeekWrites = []")
        trim_start = trim_audio.evaluate("node => node.currentTime")
        original.get_by_role("button", name="Play selected range", exact=True).click()
        page.wait_for_function("node => !node.paused", arg=trim_audio.element_handle())
        page.wait_for_timeout(420)
        trim_mid = trim_audio.evaluate("node => node.currentTime")
        trim_audio.evaluate("node => node.pause()")
        trim_clock_writes = page.evaluate("window.__mediaSeekWrites.filter(item => item.label === 'Draft 701 trim playhead audio')")
        assert trim_mid - trim_start >= .18, (trim_start, trim_mid)
        assert trim_clock_writes == [], trim_clock_writes

        # A short candidate audition must stop at its exact boundary instead of
        # waiting for a coarse timeupdate event and leaking past the cut.
        original.get_by_label("End time (seconds)", exact=True).fill("10.15")
        audition = original.get_by_role("button", name="Audition candidate trim", exact=True)
        audition.click()
        page.wait_for_function("node => !node.paused", arg=trim_audio.element_handle())
        page.wait_for_function(
            "node => node.paused && Math.abs(node.currentTime - 10.15) <= .03",
            arg=trim_audio.element_handle(),
        )
        audition_stop = trim_audio.evaluate("node => node.currentTime")
        page.wait_for_timeout(180)
        audition_stable = trim_audio.evaluate("node => node.currentTime")
        assert abs(audition_stop - 10.15) <= .03, audition_stop
        assert abs(audition_stable - audition_stop) <= .005, (audition_stop, audition_stable)
        original.get_by_role("button", name="Discard edits / reload saved", exact=True).click()

        original.get_by_role("button", name="Split clip", exact=True).click()
        panel = page.get_by_role("region", name="Split draft 701", exact=True)
        expect(panel).to_be_visible()

        # Opening the panel is immediately global unsaved work: it blocks the
        # original approved draft, navigation/source switches, and discard.
        assert beforeunload_prevented(page)
        add_approved = page.get_by_role("button", name="Add approved (0)", exact=True)
        expect(add_approved).to_be_disabled()
        page.evaluate("""() => {
          const button = [...document.querySelectorAll('button')]
            .find(node => node.textContent?.trim() === 'Add approved (0)');
          if (!button) throw new Error('global promote button missing');
          button.disabled = false;
          button.click();
        }""")
        assert request_count(evidence, "POST", "/api/curation/promote") == 0

        dialogs: list[str] = []
        page.once("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
        page.get_by_label("YouTube URL", exact=True).fill("https://www.youtube.com/watch?v=lmnopqrstuv")
        page.get_by_role("button", name="Import transcript", exact=True).click()
        assert dialogs and "split choices" in dialogs[-1]
        assert request_count(evidence, "POST", "/api/curation/imports") == 0
        expect(panel).to_be_visible()

        page.get_by_text("Saved imports (2)", exact=True).click()
        page.once("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
        page.get_by_role("button", name=re.compile(r"^Other fixture source · ready$")).click()
        assert "split choices" in dialogs[-1]
        expect(panel).to_be_visible()

        page.get_by_role("button", name="Discard transcript", exact=True).click()
        discard_group = page.get_by_role("group", name="Confirm discard transcript 91", exact=True)
        expect(discard_group.get_by_text("split choices", exact=False)).to_be_visible()
        discard_group.get_by_role("button", name="Cancel", exact=True).click()

        # Inactive duplicate controls are hidden and cannot be played, even by a
        # direct native play() call. A later intentional player pauses the first.
        saved_audio = original.get_by_label("Draft 701 audio preview", exact=True)
        disabled_trim_audio = original.get_by_label("Draft 701 trim playhead audio", exact=True)
        assert saved_audio.evaluate("node => node.controls") is False
        assert disabled_trim_audio.evaluate("node => node.controls") is False
        for inactive_audio in (saved_audio, disabled_trim_audio):
            inactive_state = inactive_audio.evaluate("""async node => {
              try { await node.play(); } catch (_) {}
              await new Promise(resolve => setTimeout(resolve, 80));
              return { paused: node.paused, disabled: node.getAttribute('aria-disabled') };
            }""")
            assert inactive_state == {"paused": True, "disabled": "true"}, inactive_state

        page.get_by_label("Select transcript line 5", exact=True).check()
        source_audio = page.get_by_label("Original source audio", exact=True)
        page.wait_for_function("node => node.readyState >= 1", arg=source_audio.element_handle())
        page.get_by_role("button", name="Play source context", exact=True).click()
        page.wait_for_function("node => !node.paused", arg=source_audio.element_handle())
        split_audio = panel.get_by_label("Draft 701 split playhead audio", exact=True)
        page.wait_for_function("node => node.readyState >= 1", arg=split_audio.element_handle())
        panel.get_by_role("button", name="Play selected range", exact=True).click()
        page.wait_for_function("node => !node.paused", arg=split_audio.element_handle())
        assert source_audio.evaluate("node => node.paused") is True
        split_audio.evaluate("node => node.pause()")

        # Cancelling only clears split work; the ordinary selection remains dirty.
        panel.get_by_role("button", name="Cancel split", exact=True).click()
        assert beforeunload_prevented(page)
        page.get_by_role("button", name="Clear selection", exact=True).click()
        expect(page.get_by_role("button", name="Clear selection", exact=True)).to_be_disabled()
        assert not beforeunload_prevented(page)
        expect(page.get_by_role("button", name="Add approved (1)", exact=True)).to_be_enabled()

        original.get_by_role("button", name="Split clip", exact=True).click()
        panel = page.get_by_role("region", name="Split draft 701", exact=True)
        expect(panel).to_be_visible()
        expect(panel.get_by_text("the app does not detect speakers", exact=False)).to_be_visible()
        expect(panel.get_by_text(COMBINED_ENGLISH, exact=True)).to_be_visible()
        expect(panel.get_by_label("Draft 701 Part 1 English", exact=True)).to_have_value("")
        expect(panel.get_by_label("Draft 701 Part 2 English", exact=True)).to_have_value("")

        # A bounded range ends on the chosen endpoint even when timeupdate is
        # sparse. It remains rewound/clamped there after the deadline fires.
        split_audio = panel.get_by_label("Draft 701 split playhead audio", exact=True)
        seek = panel.get_by_label("Draft 701 split playhead seek", exact=True)
        page.wait_for_function("node => node.readyState >= 1", arg=split_audio.element_handle())
        seek.fill("17.78")
        page.wait_for_timeout(80)
        panel.get_by_role("button", name="Play selected range", exact=True).click()
        page.wait_for_function("node => !node.paused", arg=split_audio.element_handle())
        page.wait_for_function(
            "node => node.paused && Math.abs((node.currentTime + 9.8) - 18.0) <= .03",
            arg=split_audio.element_handle(),
        )
        bounded_stop = split_audio.evaluate("node => node.currentTime + 9.8")
        page.wait_for_timeout(180)
        bounded_stable = split_audio.evaluate("node => node.currentTime + 9.8")
        assert abs(bounded_stop - 18.0) <= .03, bounded_stop
        assert abs(bounded_stable - bounded_stop) <= .005, (bounded_stop, bounded_stable)

        # Overlapping captions deliberately prove the suggestion uses the next line's
        # start (12.559), never the prior line's end (14.759).
        question_line = import_fixture([])["transcript"][0]["index"] + 1
        suggestion = panel.get_by_role("button", name=re.compile(rf"After line {question_line} · suggested 0:12\.56"))
        suggestion.click()
        expect(panel.get_by_label("Draft 701 split time in absolute source seconds", exact=True)).to_have_value("12.559")
        page.wait_for_timeout(80)
        page.evaluate("window.__mediaSeekWrites = []")
        split_start = split_audio.evaluate("node => node.currentTime")
        panel.get_by_role("button", name="Play selected range", exact=True).click()
        page.wait_for_function("node => !node.paused", arg=split_audio.element_handle())
        page.wait_for_timeout(420)
        split_mid = split_audio.evaluate("node => node.currentTime")
        split_audio.evaluate("node => node.pause()")
        split_clock_writes = page.evaluate("window.__mediaSeekWrites.filter(item => item.label === 'Draft 701 split playhead audio')")
        assert split_mid - split_start >= .18, (split_start, split_mid)
        assert split_clock_writes == [], split_clock_writes
        seek.fill("13.2")
        panel.get_by_role("button", name="Use playhead as split point", exact=True).click()
        expect(panel.get_by_label("Draft 701 split time in absolute source seconds", exact=True)).to_have_value("13.20")

        # Re-applying the text boundary must preserve the learner's playhead cut.
        boundary_text = panel.get_by_label("Draft 701 combined Spanish split boundary", exact=True)
        boundary_text.evaluate("(node, position) => { node.focus(); node.setSelectionRange(position, position); node.dispatchEvent(new Event('select', {bubbles: true})); }", len(QUESTION))
        # React's onSelect plugin observes keyboard/selectionchange events,
        # not a synthetic DOM `select` event. Exercise actual cursor movement.
        boundary_text.press("ArrowRight")
        boundary_text.press("ArrowLeft")
        expect(panel.get_by_role("button", name="Split Spanish at text cursor", exact=True)).to_be_enabled()
        panel.get_by_role("button", name="Split Spanish at text cursor", exact=True).click()
        expect(panel.get_by_label("Draft 701 split time in absolute source seconds", exact=True)).to_have_value("13.20")
        panel.get_by_text("I listened around this cut", exact=False).click()

        submit = panel.get_by_role("button", name="Split into 2 saved clips", exact=True)
        submit.click()
        expect(page.get_by_role("alert").filter(has_text="Fixture split failure; retry is safe.")).to_be_visible()
        expect(panel).to_be_visible()
        expect(panel.get_by_label("Draft 701 Part 1 Spanish", exact=True)).to_have_value(QUESTION)
        expect(panel.get_by_label("Draft 701 Part 2 Spanish", exact=True)).to_have_value(ANSWER)
        expect(panel.get_by_label("Draft 701 split time in absolute source seconds", exact=True)).to_have_value("13.20")
        expect(panel.get_by_label("I listened around this cut and chose", exact=False)).to_be_checked()
        assert request_count(evidence, "POST", "/api/curation/drafts/701/split") == 1

        # Same-tick clicks reach the synchronous mutation gate before React rerenders.
        page.evaluate("""() => {
          const panel = document.querySelector('[aria-label="Split draft 701"]');
          const button = [...panel.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Split into 2 saved clips');
          if (!button) throw new Error('split submit missing');
          button.click(); button.click();
        }""")
        page.get_by_text("Split saved as two independent drafts.", exact=False).wait_for()
        assert request_count(evidence, "POST", "/api/curation/drafts/701/split") == 2
        assert not beforeunload_prevented(page)
        expect(page.get_by_role("article", name="Draft 701", exact=True)).to_be_visible()
        expect(page.get_by_role("article", name="Draft 702", exact=True)).to_be_visible()

        # Reload proves both server-owned drafts survive and prepare independently.
        page.reload(wait_until="networkidle")
        left = page.get_by_role("article", name="Draft 701", exact=True)
        right = page.get_by_role("article", name="Draft 702", exact=True)
        expect(left).to_be_visible()
        expect(right).to_be_visible()
        expect(left.get_by_label("Spanish", exact=True)).to_have_value(QUESTION)
        expect(right.get_by_label("Spanish", exact=True)).to_have_value(ANSWER)
        expect(left.get_by_label("English meaning", exact=True)).to_have_value("What changed at halftime?")
        expect(right.get_by_label("English meaning", exact=True)).to_have_value("We came out with more intensity and scored early.")

        # Cancel is local-only and leaves the split endpoint untouched.
        right.get_by_role("button", name="Split clip", exact=True).click()
        right.get_by_role("button", name="Cancel split", exact=True).click()
        assert request_count(evidence, "POST", "/api/curation/drafts/702/split") == 0

        # Trim only Part 1 at its absolute source playhead, then reprepare/reapprove.
        trim_seek = left.get_by_label("Draft 701 trim playhead seek", exact=True)
        trim_seek.fill("12.9")
        left.get_by_role("button", name="Set end here", exact=True).click()
        expect(left.get_by_label("End time (seconds)", exact=True)).to_have_value("12.90")
        expect(left.get_by_text("saved preview still uses the old timing", exact=False)).to_be_visible()
        audition = left.get_by_role("button", name="Audition candidate trim", exact=True)
        expect(audition).to_be_enabled()
        audition.click()
        left.get_by_role("button", name="Save edits", exact=True).click()
        left = page.get_by_role("article", name="Draft 701", exact=True)
        expect(left.get_by_role("button", name="Prepare clip", exact=True)).to_be_enabled()
        left.get_by_role("button", name="Prepare clip", exact=True).click()
        left = page.get_by_role("article", name="Draft 701", exact=True)
        approval = left.get_by_label("I listened and approve this clip and meaning", exact=True)
        approval.click()
        expect(approval).to_be_checked()
        expect(left.get_by_role("button", name="Split clip", exact=True)).to_be_enabled()

        # Part 2 retained its independent revision/timing/approval state.
        right = page.get_by_role("article", name="Draft 702", exact=True)
        expect(right.get_by_label("Start time (seconds)", exact=True)).to_have_value("13.2")
        expect(right.get_by_label("I listened and approve this clip and meaning", exact=True)).not_to_be_checked()
        patch_calls = [item for item in evidence["api_requests"] if item["method"] == "PATCH"]
        assert [item["path"] for item in patch_calls] == [
            "/api/curation/drafts/701",
            "/api/curation/drafts/701",
        ], patch_calls
        assert patch_calls[0]["body"] == {"revision": 4, "end_time": 12.9}, patch_calls[0]
        assert patch_calls[1]["body"] == {"revision": 6, "approved": True}, patch_calls[1]

        layout = page.evaluate("""() => ({
          viewportWidth: document.documentElement.clientWidth,
          scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          splitButtonHeights: [...document.querySelectorAll('button')]
            .filter((node) => node.textContent?.includes('Split clip'))
            .map((node) => Math.round(node.getBoundingClientRect().height)),
        })""")
        assert layout["scrollWidth"] <= layout["viewportWidth"], layout
        assert layout["splitButtonHeights"] and min(layout["splitButtonHeights"]) >= 44, layout

        forbidden = [
            item for item in evidence["api_requests"]
            if item["method"] in {"POST", "PATCH", "DELETE"}
            and (
                item["path"].startswith("/api/cards")
                or item["path"].startswith("/api/reviews")
                or item["path"].startswith("/api/curation/promote")
            )
        ]
        assert not forbidden, forbidden
        assert not evidence["page_errors"], evidence
        expected_failure_path = "/api/curation/drafts/701/split"
        blocked_telemetry = {
            item["url"] for item in evidence["blocked_external"]
            if urlparse(item["url"]).netloc == "static.cloudflareinsights.com"
            and urlparse(item["url"]).path.startswith("/beacon.min.js/")
        }
        evidence["blocked_telemetry"] = sorted(blocked_telemetry)
        evidence["unexpected_console_errors"] = [
            item for item in evidence["console"]
            if not (
                "503" in item["text"] and "Failed to load resource" in item["text"]
                and urlparse(item.get("location", {}).get("url", "")).path == expected_failure_path
            ) and not (
                "Failed to load resource" in item["text"]
                and item.get("location", {}).get("url", "") in blocked_telemetry
            )
        ]
        assert not evidence["unexpected_console_errors"], evidence

        screenshot = output / f"clip-split-{name}.png"
        page.screenshot(path=str(screenshot), full_page=True)
        evidence.update({
            "layout": layout,
            "split_attempts": state["split_attempts"],
            "draft_count_after_reload": len(state["drafts"]),
            "forbidden_learner_writes": len(forbidden),
            "dialogs": dialogs,
            "media_checks": {
                "trim_advanced_seconds": trim_mid - trim_start,
                "trim_clock_seek_writes": trim_clock_writes,
                "audition_stop_absolute": audition_stop,
                "bounded_stop_absolute": bounded_stop,
                "split_advanced_seconds": split_mid - split_start,
                "split_clock_seek_writes": split_clock_writes,
            },
            "screenshot": str(screenshot),
        })
        return evidence
    except Exception as error:
        evidence["failure"] = repr(error)
        page.screenshot(path=str(output / f"failure-{name}.png"), full_page=True)
        (output / f"failure-{name}.json").write_text(json.dumps(evidence, indent=2)+"\n")
        raise
    finally:
        context.close()


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
    report = {
        "browser": args.browser,
        "fixture_only": True,
        "production_writes": 0,
        "runs": runs,
    }
    report_path = args.output / "clip-split-report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": "passed", "browser": args.browser, "devices": list(DEVICES), "report": str(report_path)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
