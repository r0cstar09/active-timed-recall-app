"""Real Chromium UI regression with explicitly mocked study APIs; NEVER writes study data.
Run on Alienware: PYTHONPATH=/home/rootadmin/asr-quality-browser/vendor python3 tests/browser_learn_batch.py
Optional --base-url https://spanish-app.tonymuzo.dev verifies deployed UI with the same API isolation.
"""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import re
import threading
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BATCH = [42, 9, 17]
TEXT = {42: ("I want coffee.", "Quiero café."), 9: ("I need water.", "Necesito agua."), 17: ("I am going home.", "Voy a casa."), 999: ("UNRELATED QUEUE CARD", "Tarjeta ajena.")}


class StudyFixture:
    def __init__(self):
        self.created = []
        self.sessions = {}
        self.introduced = []
        self.unexpected = []
        self.inject_unrelated = False

    def make_session(self, body):
        sid = 1000 + len(self.created)
        ids = body.get("phrase_ids", BATCH if body["mode"] == "learn" else [999])
        if self.inject_unrelated and "phrase_ids" in body:
            ids = [999, *ids[1:]]
            self.inject_unrelated = False
        items = [{"sprint_item_id": sid * 10 + i, "phrase_id": pid, "spanish": TEXT[pid][1], "english": TEXT[pid][0], "prompt": TEXT[pid][0], "prompt_type": "english", "result": "pending", "attempt_number": 1, "scheduling": {"time_limit_seconds": 15}} for i, pid in enumerate(ids)]
        session = {"session_id": sid, "mode": body["mode"], "response_mode": body.get("response_mode", "spoken"), "target_verb": body.get("target_verb"), "affects_fsrs": False, "status": "pending", "items": items}
        self.sessions[sid] = session
        return session

    def grade(self, sid):
        session = self.sessions[sid]
        ids = [item["phrase_id"] for item in session["items"]]
        results = ["pass", "partial", "fail"] if ids == BATCH else ["pass", "partial"] if ids == [9, 17] else ["pass"]
        for item, result in zip(session["items"], results):
            item.update(result=result, score=100 if result == "pass" else 50 if result == "partial" else 0, feedback="Fixture feedback", recording_id=item["sprint_item_id"], fsrs_applied=False)
        session.update(status="complete", summary={"total": len(ids), "passed": results.count("pass"), "partial": results.count("partial"), "failed": results.count("fail"), "score": 50, "overtime_count": 0})
        return session

    def route(self, route):
        request = route.request
        parsed = urlparse(request.url)
        path = parsed.path
        # Public Cloudflare telemetry is not a study write; mock it without sending data.
        if parsed.hostname == "spanish-app.tonymuzo.dev" and path == "/cdn-cgi/rum" and request.method == "POST":
            return route.fulfill(status=204, body="")
        # Every API URL, including public host calls, is intercepted. Unknown writes fail closed.
        if not (path.startswith("/api/") or parsed.hostname == "api-spanish.tonymuzo.dev" or path == "/health"):
            if request.method not in ("GET", "HEAD"):
                self.unexpected.append((request.method, request.url))
                return route.abort()
            return route.continue_()
        def reply(data, status=200):
            return route.fulfill(status=status, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(data))
        if request.method == "OPTIONS":
            return reply({})
        if path == "/api/sessions" and request.method == "POST":
            body = request.post_data_json
            self.created.append(body)
            return reply(self.make_session(body))
        match = re.fullmatch(r"/api/cards/(\d+)/introduce", path)
        if match:
            pid = int(match[1]); self.introduced.append(pid)
            for session in self.sessions.values():
                if session["mode"] == "learn":
                    for item in session["items"]:
                        if item["phrase_id"] == pid:
                            item["result"] = "pass"
                    if all(item["result"] == "pass" for item in session["items"]):
                        session["status"] = "complete"
            return reply({"id": pid, "introduced_at": "2026-09-06T00:00:00Z", "learning_status": "introduced"})
        match = re.fullmatch(r"/api/sessions/(\d+)/items/(\d+)/recording", path)
        if match:
            return reply({"recording_id": int(match[2]), "sprint_item_id": int(match[2])})
        match = re.fullmatch(r"/api/sessions/(\d+)/(grade|written-grade)", path)
        if match:
            session = self.grade(int(match[1]))
            return reply(session if match[2] == "written-grade" else {"job_id": session["session_id"]})
        match = re.fullmatch(r"/api/jobs/(\d+)", path)
        if match:
            return reply({"job_id": int(match[1]), "status": "complete", "result": {}, "error_message": None})
        match = re.fullmatch(r"/api/sessions/(\d+)", path)
        if match and request.method == "GET":
            return reply(self.sessions[int(match[1])])
        if request.method == "GET":
            return reply({"verbs": []} if "catalog" in path else {})
        self.unexpected.append((request.method, path))
        return reply({"detail": "Unexpected API write blocked by fixture"}, 500)


def answer_spoken(page, ids):
    for pid in ids:
        expect(page.get_by_text(TEXT[pid][0], exact=True).first).to_be_visible()
        button = page.get_by_role("button", name=re.compile("Check and (continue|grade)"))
        expect(button).to_be_visible()
        page.wait_for_timeout(320)  # Audio capture under test, not a readiness sleep.
        button.click()
    expect(page.get_by_role("heading", name=re.compile("Session graded|Clean recall"))).to_be_visible()


def answer_written(page, ids):
    for pid in ids:
        expect(page.get_by_role("heading", name=TEXT[pid][0], exact=True)).to_be_visible()
        page.locator("#written-answer").fill(TEXT[pid][1])
        if len(ids) > 1 and pid == ids[1]:
            before = page.evaluate("JSON.parse(localStorage.getItem('atr.writtenSession'))")
            page.reload(wait_until="networkidle")
            expect(page.locator("#written-answer")).to_have_value(TEXT[pid][1])
            after = page.evaluate("JSON.parse(localStorage.getItem('atr.writtenSession'))")
            for key in ("sessionId", "phraseIds", "mode", "targetVerb", "index", "answers", "draft"):
                assert after[key] == before[key], (key, before, after)
            assert after["mode"] == "learn" and after["targetVerb"] == "ser"
        page.get_by_role("button", name=re.compile("Save & next|Grade all answers")).click()
    expect(page.get_by_role("heading", name=re.compile(r"passed$"))).to_be_visible()


def verify_flow(browser, base, written, output):
    context = browser.new_context(permissions=["microphone"], viewport={"width": 390, "height": 844}, service_workers="block")
    fixture = StudyFixture()
    context.route("**/*", fixture.route)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base + ("/write/" if written else "/session/?mode=learn"), wait_until="networkidle")
    if written:
        page.locator('input[name="written-mode"][value="learn"]').check()
        page.locator("#target-verb").fill("ser")
        page.get_by_role("button", name="Start 10-card learn queue").click()
    else:
        page.get_by_role("button", name="Start learning", exact=True).click()
    for pid in BATCH:
        expect(page.get_by_text(TEXT[pid][1], exact=True).first).to_be_visible()
        page.get_by_role("button", name=re.compile("I understand|Learned — start writing")).click()
        if written and pid == BATCH[0]:
            page.reload(wait_until="networkidle")
            expect(page.get_by_text(TEXT[BATCH[1]][1], exact=True)).to_be_visible()
    expect(page.locator("#written-answer") if written else page.get_by_role("button", name="Check and continue", exact=True)).to_be_visible()
    assert fixture.introduced == BATCH, fixture.introduced
    assert fixture.created[1]["phrase_ids"] == BATCH, fixture.created
    answer = answer_written if written else answer_spoken
    answer(page, BATCH)
    if not written:
        # A page refresh must restore the same results, not open a generic practice pack.
        saved = page.evaluate("JSON.parse(localStorage.getItem('atr.session'))")
        assert saved["phase"] == "summary" and [i["phrase_id"] for i in saved["graded"]["items"]] == BATCH
        page.reload(wait_until="networkidle")
        page.get_by_role("button", name="Resume", exact=True).click()
        expect(page.get_by_role("button", name="Correct this batch", exact=True)).to_be_visible()
    else:
        page.reload(wait_until="networkidle")
        expect(page.get_by_role("button", name="Correct this batch", exact=True)).to_be_visible()
    # Same-size unrelated server response is rejected without displaying another queue card.
    fixture.inject_unrelated = True
    page.get_by_role("button", name="Correct this batch", exact=True).click()
    expect(page.get_by_role("alert").filter(has_text="The exact card batch could not be")).to_be_visible()
    expect(page.get_by_text("UNRELATED QUEUE CARD", exact=True)).to_have_count(0)
    assert fixture.created[-1]["phrase_ids"] == [9, 17]
    for ids in ([9, 17], [17]):
        before = len(fixture.created)
        page.get_by_role("button", name="Correct this batch", exact=True).evaluate("button => { button.click(); button.click(); }")
        expect(page.locator("#written-answer") if written else page.get_by_role("button", name=re.compile("Check and (continue|grade)"))).to_be_visible()
        expect(page.get_by_text(TEXT[ids[0]][0], exact=True).first).to_be_visible()
        assert len(fixture.created) == before + 1, fixture.created
        request = fixture.created[-1]
        assert request["mode"] == "practice" and request["size"] == len(ids) and request["phrase_ids"] == ids, request
        if not written and ids == [9, 17]:
            page.reload(wait_until="networkidle")
            page.get_by_role("button", name="Resume", exact=True).click()
            expect(page.get_by_text(TEXT[ids[0]][0], exact=True).first).to_be_visible()
            assert len(fixture.created) == before + 1
            saved = page.evaluate("JSON.parse(localStorage.getItem('atr.session'))")
            assert [item["phrase_id"] for item in saved["items"]] == ids
        if written:
            assert request["response_mode"] == "written", request
        answer(page, ids)
    expect(page.get_by_role("button", name="Correct this batch", exact=True)).to_have_count(0)
    expect(page.get_by_role("button" if written else "link", name="Learn next batch", exact=True)).to_be_visible()
    expect(page.locator('a[href="/session?mode=misses"]')).to_have_count(0)
    expect(page.get_by_text("UNRELATED QUEUE CARD", exact=True)).to_have_count(0)
    assert not errors, errors
    assert not fixture.unexpected, fixture.unexpected
    page.screenshot(path=str(output / ("written-batch.png" if written else "spoken-batch.png")), full_page=True)
    result = {"modality": "written" if written else "spoken", "created_requests": fixture.created, "introduced_ids": fixture.introduced, "unexpected_writes": fixture.unexpected, "page_errors": errors, "verified": ["Learn exact-batch test", "same-size unrelated response rejected", "repeat shrinking corrections", "double-click guard", "no queue top-up", "clean completion", "Learn next batch"]}
    result["verified"].append("refresh preserves summary/correction scope")
    if written:
        result["verified"].extend(["Learn refresh resumes next card", "answers and unsaved draft survive refresh", "Learn origin and verb focus survive refresh"])
    context.close()
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url")
    parser.add_argument("--output", default=str(ROOT / "browser-results"))
    args = parser.parse_args()
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    server = None
    if args.base_url:
        base = args.base_url.rstrip("/")
    else:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "dist"))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as p:
            exe = os.environ.get("BROWSER_BINARY", "/home/rootadmin/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome")
            browser = p.chromium.launch(executable_path=exe, headless=True, args=["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
            results = [verify_flow(browser, base, written, output) for written in (False, True)]
            report = {"base": base, "browser": browser.version, "scope": "Real mobile-sized Chromium UI + real MediaRecorder; mocked study API fixtures; zero production study writes. Not a physical iPhone test.", "results": results}
            (output / "result.json").write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))
            browser.close()
    finally:
        if server:
            server.shutdown(); server.server_close()


if __name__ == "__main__":
    main()
