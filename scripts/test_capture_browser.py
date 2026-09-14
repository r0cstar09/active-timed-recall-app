"""Browser capture regressions. Synthetic microphone, fixture APIs; no learner writes.
Run on a browser worker/CI, never the VPS: python scripts/test_capture_browser.py
Set CAPTURE_QA_BASE to exercise exact public deployed assets with API requests intercepted.
"""
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import threading
import time
from email.parser import BytesParser
from email.policy import default
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BASE = os.getenv('CAPTURE_QA_BASE', 'http://127.0.0.1:18763').rstrip('/')
OUT = Path(os.getenv('CAPTURE_QA_OUTPUT', '/tmp/spanish-capture-qa'))
OUT.mkdir(parents=True, exist_ok=True)
if BASE.startswith('http://127.0.0.1:'):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'dist'))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 18763), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

ITEMS = [dict(sprint_item_id=990001+i, phrase_id=990001+i, position=i+1,
    result='pending', prompt_type='english_to_spanish', prompt=english,
    english=english, english_meaning=english, spanish=spanish, answer_visible=False,
    scheduling=dict(time_limit_seconds=15, prompt_stage=0, state='review'))
    for i,(english,spanish) in enumerate([('I want to drink tea.', 'Quiero tomar té.'), ('I need to leave now.', 'Necesito salir ahora.')])]
MIC_SCRIPT = """(() => {
  window.__captureStreams = [];
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await original(...args);
    window.__captureStreams.push(stream);
    return stream;
  };
})();"""
report = {'checks': [], 'fixture_apis': True, 'synthetic_microphone': True, 'production_test_writes': 0, 'base': BASE}

def context_for(browser, inline=False):
    context = browser.new_context(viewport={'width':390,'height':844}, permissions=['microphone'], service_workers='block')
    page = context.new_page()
    errors, uploads, requests, blocked = [], [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    items = [dict(ITEMS[0], result='partial', error_type='transcription_unclear', answer_visible=True,
                  feedback='Fixture capture needs another take.', attempt_number=1)] if inline else ITEMS
    graded = dict(session_id=990001, items=items, mode='practice', response_mode='spoken', affects_fsrs=False,
                  summary=dict(total=1, passed=0, failed=0, partial=1, unclear=1, score=0, overtime_count=0))
    saved = dict(sessionId=990001, mode='practice', items=items, index=0,
                 phase='summary' if inline else 'recall', deadline=None, durationMs=15000,
                 promptShownAt=None, uploadedItemIds=[], jobId=None, graded=graded if inline else None,
                 savedAt=int(time.time()*1000))
    context.add_init_script(MIC_SCRIPT + '\nlocalStorage.setItem("atr.session", ' + json.dumps(json.dumps(saved)) + ');')
    def guard(route):
        request=route.request
        parsed=urlparse(request.url)
        path=parsed.path
        headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}
        def reply(body, status=200):
            route.fulfill(status=status, content_type='application/json', body=json.dumps(body), headers=headers)
        if parsed.netloc==urlparse(BASE).netloc and not path.startswith('/api/') and request.method in ('GET','HEAD'):
            route.continue_(); return
        if parsed.netloc!='api-spanish.tonymuzo.dev':
            blocked.append(request.url); route.abort(); return
        requests.append((request.method,path))
        if request.method=='OPTIONS': reply({}); return
        if path.endswith('/recording') and request.method=='POST':
            data=request.post_data_buffer
            message=BytesParser(policy=default).parsebytes(('Content-Type: '+request.headers['content-type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+data)
            files=[part.get_payload(decode=True) for part in message.iter_parts() if part.get_filename()]
            assert len(files)==1 and isinstance(files[0],bytes) and len(files[0])>0, 'Browser produced empty recording'
            uploads.append({'bytes':len(files[0]),'sha256':hashlib.sha256(files[0]).hexdigest()})
            if len(uploads)==1:
                reply({'detail':{'code':'recording_incomplete','message':'Recording was incomplete. Try recording this card again.'}},422)
            elif not inline and len(uploads)==2: reply({'detail':'Temporary fixture upload outage'},503)
            else: reply({'recording_id':990001,'sprint_item_id':990001,'grading_status':'deferred'})
        elif path.endswith('/retry'):
            reply({'sprint_item_id':990100,'attempt_number':2,'time_limit_seconds':15,'existing':True})
        elif path.endswith('/grade'):
            reply({'job_id':990001})
        elif path.startswith('/api/jobs/'):
            reply({'job_id':990001,'status':'complete','result':None,'error_message':None})
        elif path=='/api/sessions/990001': reply(graded)
        elif path=='/api/sources': reply([])
        elif request.method in ('GET','HEAD'): reply({})
        else:
            blocked.append(request.url); route.abort()
    context.route('**/*',guard)
    page.goto(BASE+'/session/?mode=practice', wait_until='networkidle')
    page.get_by_role('button',name='Resume',exact=True).click()
    return context,page,errors,uploads,requests,blocked

with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,args=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
    context,page,errors,uploads,requests,blocked=context_for(browser)
    expect(page.get_by_text(ITEMS[0]['english'],exact=True)).to_be_visible()
    page.evaluate('window.__captureStreams.at(-1).getAudioTracks()[0].enabled = false')
    expect(page.get_by_role('button',name='Retry microphone',exact=True)).to_be_visible()
    assert not uploads
    saved=page.evaluate('JSON.parse(localStorage.getItem("atr.session"))')
    assert saved['index']==0 and saved['deadline'] is None
    page.get_by_role('button',name='Retry microphone',exact=True).click()
    expect(page.get_by_text(ITEMS[0]['english'],exact=True)).to_be_visible()
    assert page.evaluate('window.__captureStreams.length')>=2
    # First complete Blob is deliberately rejected by the fixture API as truncated.
    page.wait_for_timeout(900)
    page.get_by_role('button',name='Check and continue',exact=True).click()
    expect(page.get_by_role('button',name='Retry microphone',exact=True)).to_be_visible()
    assert len(uploads)==1
    page.get_by_role('button',name='Retry microphone',exact=True).click()
    expect(page.get_by_text(ITEMS[0]['english'],exact=True)).to_be_visible()
    page.wait_for_timeout(900)
    page.get_by_role('button',name='Check and continue',exact=True).click()
    expect(page.get_by_role('button',name='Retry upload',exact=True)).to_be_visible()
    page.get_by_role('button',name='Retry upload',exact=True).click()
    expect(page.get_by_text(ITEMS[1]['english'],exact=True)).to_be_visible()
    assert len(uploads)==3 and uploads[1]['sha256']==uploads[2]['sha256']
    assert not errors,errors
    assert not blocked,blocked
    assert not any(path.endswith('/grade') for method,path in requests)
    page.screenshot(path=str(OUT/'normal-capture-recovery.png'))
    report['checks'].append({'flow':'normal','interrupted_no_upload':True,'same_card_fresh_mic':True,
        'incomplete_capture_not_graded':True,'network_retry_same_blob':True,'uploads':uploads,'page_errors':errors})
    context.close()

    context,page,errors,uploads,requests,blocked=context_for(browser,inline=True)
    page.get_by_role('button',name='Re-record now',exact=True).click()
    expect(page.get_by_role('button',name='Done — grade it',exact=True)).to_be_visible()
    page.evaluate('window.__captureStreams.at(-1).getAudioTracks()[0].enabled = false')
    expect(page.get_by_role('button',name='Try again',exact=True)).to_be_visible()
    assert not uploads
    page.get_by_role('button',name='Try again',exact=True).click()
    expect(page.get_by_role('button',name='Done — grade it',exact=True)).to_be_visible()
    page.wait_for_timeout(900)
    page.get_by_role('button',name='Done — grade it',exact=True).click()
    expect(page.get_by_role('button',name='Try again',exact=True)).to_be_visible()
    assert len(uploads)==1
    assert not any(path.endswith('/grade') for method,path in requests)
    assert page.get_by_role('button',name='Retry upload',exact=True).count()==0
    page.get_by_role('button',name='Try again',exact=True).click()
    expect(page.get_by_role('button',name='Done — grade it',exact=True)).to_be_visible()
    assert page.evaluate('window.__captureStreams.length')>=3
    assert not errors,errors
    assert not blocked,blocked
    page.screenshot(path=str(OUT/'inline-capture-recovery.png'))
    report['checks'].append({'flow':'inline_retry','interrupted_no_upload':True,'fresh_mic_recovery':True,
                            'incomplete_capture_not_graded':True,'page_errors':errors})
    context.close()
    browser.close()
report['status']='passed'
(OUT/'report.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
