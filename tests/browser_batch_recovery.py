"""Recovery regressions using real Chromium and isolated, fail-closed study API fixtures."""
import argparse
import copy
import functools
import http.server
import json
import os
from pathlib import Path
import re
import threading
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from browser_learn_batch import StudyFixture, ROOT, BATCH, TEXT


class RecoveryFixture(StudyFixture):
    def __init__(self):
        super().__init__()
        self.fail_reads = False
        self.retries = []
        self.deletes = []

    def route(self, route):
        path = urlparse(route.request.url).path
        def reply(data, status=200):
            return route.fulfill(status=status, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(data))
        if self.fail_reads and re.fullmatch(r"/api/sessions/\d+", path):
            return reply({"detail": "Fixture connection unavailable"}, 503)
        match = re.fullmatch(r"/api/sessions/(\d+)/items/(\d+)/(retry|grade)", path)
        if match:
            session = self.sessions[int(match[1])]
            if match[3] == "retry":
                pending = next(item for item in session["items"] if item["result"] == "pending")
                self.retries.append(pending["sprint_item_id"])
                return reply({"ok": True, "sprint_item_id": pending["sprint_item_id"], "time_limit_seconds": 15, "existing": True})
            item = next(item for item in session["items"] if item["sprint_item_id"] == int(match[2]))
            item.update(result="pass", score=100, error_type=None)
            return reply({"job_id": session["session_id"]})
        match = re.fullmatch(r"/api/cards/(\d+)", path)
        if match and route.request.method == "DELETE":
            self.deletes.append(int(match[1]))
            # Backend retains historical session rows after soft-deleting a card.
            return reply({"ok": True})
        return super().route(route)


def verify_spoken(browser, base):
    context = browser.new_context(permissions=["microphone"], service_workers="block", viewport={"width": 390, "height": 844})
    fixture = RecoveryFixture()
    context.route("**/*", fixture.route)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    session = fixture.make_session({"mode": "practice", "phrase_ids": BATCH})
    fixture.grade(session["session_id"])
    session["items"][1]["error_type"] = "transcription_unclear"
    saved = {"sessionId": session["session_id"], "mode": "practice", "phase": "summary", "items": copy.deepcopy(session["items"]), "graded": copy.deepcopy(session), "index": 2, "uploadedItemIds": [], "deadline": None, "durationMs": None, "promptShownAt": None, "jobId": None}
    pending = {**session["items"][1], "sprint_item_id": 10999, "attempt_number": 2, "result": "pending", "recording_id": None, "error_type": None}
    session["items"].append(pending)
    page.goto(base + "/session/?mode=practice", wait_until="networkidle")
    page.evaluate("saved => localStorage.setItem('atr.session', JSON.stringify(saved))", saved)
    page.reload(wait_until="networkidle")
    page.get_by_role("button", name="Resume", exact=True).click()
    expect(page.get_by_text(re.compile("An unfinished re-recording is still"))).to_be_visible()
    expect(page.get_by_role("button", name="Correct this batch", exact=True)).to_be_disabled()
    page.get_by_role("button", name="Re-record now", exact=True).click()
    expect(page.get_by_role("button", name="Done — grade it", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="Correct this batch", exact=True)).to_be_disabled()
    page.wait_for_timeout(320)  # Deliberate audio capture, not a readiness wait.
    page.get_by_role("button", name="Done — grade it", exact=True).click()
    expect(page.get_by_role("button", name="Correct this batch", exact=True)).to_be_enabled()
    expect(page.get_by_role("button", name="Re-record now", exact=True)).to_have_count(0)
    expect(page.get_by_text(re.compile("Repeat only the 1 card needing correction"))).to_be_visible()
    assert fixture.retries == [10999]
    # Delete the only remaining failure, then refresh against historical server rows.
    page.on("dialog", lambda dialog: dialog.accept())
    page.locator(".card.stack").filter(has=page.get_by_text(TEXT[17][1], exact=True)).get_by_role("button", name="Delete malformed card").click()
    expect(page.get_by_text(TEXT[17][1], exact=True)).to_have_count(0)
    page.reload(wait_until="networkidle")
    page.get_by_role("button", name="Resume", exact=True).click()
    expect(page.get_by_role("link", name="Learn next batch", exact=True)).to_be_visible()
    expect(page.get_by_text(TEXT[17][1], exact=True)).to_have_count(0)
    expect(page.get_by_role("button", name="Correct this batch", exact=True)).to_have_count(0)
    assert fixture.deletes == [17]
    assert not fixture.created and not fixture.unexpected and not errors, (fixture.created, fixture.unexpected, errors)
    context.close()
    return {"spoken": ["server retry reconciled on refresh", "pending inline retry reconnects exact item", "bulk corrections blocked during inline capture", "successful retry clears historical failure", "deleted card stays out of persisted correction scope"], "production_writes": 0}


def verify_written(browser, base):
    context = browser.new_context(service_workers="block")
    fixture = RecoveryFixture()
    context.route("**/*", fixture.route)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    session = fixture.make_session({"mode": "practice", "response_mode": "written", "phrase_ids": BATCH, "target_verb": "ser"})
    saved = {"version": 1, "sessionId": session["session_id"], "phraseIds": BATCH, "mode": "learn", "targetVerb": "ser", "index": 1, "phase": "answer", "answers": {}, "draft": "Necesito agua", "promptStartedAt": 1000}
    page.goto(base + "/write/", wait_until="networkidle")
    page.evaluate("saved => localStorage.setItem('atr.writtenSession', JSON.stringify(saved))", saved)
    fixture.fail_reads = True
    page.reload(wait_until="networkidle")
    expect(page.get_by_role("button", name="Retry restore", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name=re.compile("Start 10-card"))).to_have_count(0)
    assert not fixture.created
    fixture.fail_reads = False
    page.get_by_role("button", name="Retry restore", exact=True).click()
    expect(page.locator("#written-answer")).to_have_value(saved["draft"])
    # A server-completed grade must win over a stale in-flight client phase.
    fixture.grade(session["session_id"])
    page.evaluate("() => { const s = JSON.parse(localStorage.getItem('atr.writtenSession')); s.phase = 'grading'; localStorage.setItem('atr.writtenSession', JSON.stringify(s)); }")
    page.reload(wait_until="networkidle")
    expect(page.get_by_role("button", name="Correct this batch", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="Learn next batch", exact=True)).to_be_visible()
    assert not fixture.created and not fixture.unexpected and not errors, (fixture.created, fixture.unexpected, errors)
    context.close()
    return {"written": ["failed rehydrate never opens Review", "explicit retry restores draft and exact batch", "committed grade recovered without resubmission", "Learn origin survives grading recovery"], "production_writes": 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    server = None
    if args.base_url:
        base = args.base_url.rstrip("/")
    else:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "dist")))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get("BROWSER_BINARY", "/home/rootadmin/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"), headless=True, args=["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
            report = {"base": base, "scope": "Mocked API routes; no production writes", "results": [verify_spoken(browser, base), verify_written(browser, base)]}
            Path(args.output).write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))
            browser.close()
    finally:
        if server:
            server.shutdown(); server.server_close()


if __name__ == "__main__":
    main()
