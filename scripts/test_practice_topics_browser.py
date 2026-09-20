"""Topic picker/session regression: synthetic fixtures, no production API writes.
Run on Alienware/CI ONLY. Serves the frozen dist locally when --base is omitted.
"""
import argparse
import functools
import http.server
import json
import re
import threading
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

p = argparse.ArgumentParser()
p.add_argument('--base', default='http://127.0.0.1:18779')
p.add_argument('--browser', choices=['chromium', 'webkit'], default='chromium')
p.add_argument('--output', required=True)
p.add_argument('--axe-script')
a = p.parse_args()
out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
root = Path(__file__).resolve().parents[1]
if a.base == 'http://127.0.0.1:18779':
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args): pass
    handler = functools.partial(QuietHandler, directory=str(root / 'dist'))
    server = http.server.ThreadingHTTPServer(('127.0.0.1',18779), handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()

TOPICS = [dict(id='grammar:giving-it',kind='grammar',label='Giving it to someone',description='Give something to a person, across people and tenses.',learned_count=3,available_count=3,examples=['She gave it to you.', 'I gave it to you.', 'I will give it to you.']),
          dict(id='verb:dar',kind='verb',label='Dar',description='The verb dar.',learned_count=3,available_count=3,examples=['I gave it to you.']),
          dict(id='lesson:lesson-18',kind='lesson',label='Lesson 18',description='Your prior lesson.',learned_count=3,available_count=3,examples=['I gave it to you.'])]
IDS = [990011,990012,990013]
ITEMS = [dict(sprint_item_id=990101+i, phrase_id=pid, position=i+1, result='pending', prompt_type='english_to_spanish',prompt=cue,english=cue,spanish=target,target_spanish=target,answer_visible=False, scheduling=dict(time_limit_seconds=35,prompt_stage=0,state='review')) for i,(pid,cue,target) in enumerate(zip(IDS,TOPICS[0]['examples'],['Ella te lo dio.','Te lo di.','Te lo daré.']))]
report={'browser':a.browser,'fixture_apis':True,'production_writes':0,'checks':[]}
with sync_playwright() as pw:
    kwargs={'headless':True}
    if a.browser=='chromium':kwargs['args']=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']
    browser=getattr(pw,a.browser).launch(**kwargs)
    def case(route,theme='paper',width=390,scenario='normal'):
        context=browser.new_context(viewport={'width':width,'height':900},service_workers='block',**({'permissions':['microphone']} if a.browser=='chromium' else {}))
        context.add_init_script('localStorage.setItem("atr-theme",'+json.dumps(theme)+');')
        if scenario.startswith('resume-'):
            saved: dict = dict(version=1,sessionId=990001,phraseIds=IDS,mode='practice',targetVerb='',index=0,phase='results',answers={},draft='',promptStartedAt=1000)
            if scenario=='resume-focused': saved['practiceTopicId']='grammar:giving-it'
            if scenario=='resume-mix': saved['practiceTopicId']=None
            context.add_init_script('localStorage.setItem("atr.writtenSession",'+json.dumps(json.dumps(saved))+');')
        requests=[]; blocked=[]; errors=[]; state={'catalog_calls':0}
        def guard(r):
            req=r.request; parsed=urlparse(req.url); path=parsed.path
            headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}
            def reply(body,status=200):r.fulfill(status=status,content_type='application/json',body=json.dumps(body),headers=headers)
            if parsed.hostname=='static.cloudflareinsights.com':
                r.fulfill(status=200,body=''); return
            if parsed.netloc==urlparse(a.base).netloc and not path.startswith('/api/') and req.method in ('GET','HEAD'):
                r.continue_(); return
            if parsed.hostname!='api-spanish.tonymuzo.dev' and not (parsed.netloc==urlparse(a.base).netloc and path.startswith('/api/')):
                blocked.append(req.url); r.abort(); return
            if req.method=='OPTIONS':reply({}); return
            requests.append({'method':req.method,'path':path,'body':req.post_data_json if req.method=='POST' else None})
            if path=='/api/practice/topics':
                state['catalog_calls']+=1
                if scenario=='retry' and state['catalog_calls']==1:reply({'detail':'Fixture topics unavailable'},503); return
                topics=[dict(t,available_count=0) for t in TOPICS] if scenario=='unavailable' else TOPICS
                reply(dict(topics=topics,learned_count=3,available_count=0 if scenario=='unavailable' else 3)); return
            if path=='/api/practice/topic-cards':
                topic_id=parse_qs(parsed.query)['topic_id'][0]
                if scenario=='selection-error':reply({'detail':'Fixture selection unavailable'},503); return
                reply(dict(topic_id=topic_id,phrase_ids=[] if scenario=='empty' else IDS,learned_count=3,available_count=0 if scenario=='empty' else 3)); return
            if path=='/api/sessions/990001' and req.method=='GET' and scenario.startswith('resume-'):
                reply(dict(session_id=990001,status='complete',mode='practice',response_mode='written',affects_fsrs=False,items=[dict(item,result='pass',answer_visible=True) for item in ITEMS])); return
            if path=='/api/sessions' and req.method=='POST':
                body=req.post_data_json
                assert body['mode']=='practice', body
                if scenario=='resume-mix': assert 'phrase_ids' not in body and body['size']==10, body
                else: assert body['phrase_ids']==IDS and body['size']==3, body
                assert 'target_verb' not in body
                reply(dict(session_id=990001,status='awaiting_recordings',mode='practice',response_mode=body.get('response_mode','spoken'),affects_fsrs=False,items=ITEMS)); return
            if path=='/api/study/verbs':reply({'verbs':[]}); return
            if path=='/api/sources':reply([]); return
            if path=='/api/stats':reply({}); return
            blocked.append(req.method+' '+req.url); r.abort()
        context.route('**/*',guard)
        page=context.new_page(); page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(a.base.rstrip('/')+route,wait_until='domcontentloaded')
        page.wait_for_function("() => [...document.querySelectorAll('astro-island')].every(e => !e.hasAttribute('ssr'))")
        return context,page,requests,blocked,errors

    for route in ['/session/?mode=practice','/write/?mode=practice']:
        modality='written' if '/write/' in route else 'spoken'
        for theme in ['paper','dark']:
            for width in [390,1365]:
                ctx,page,requests,blocked,errors=case(route,theme,width)
                picker=page.get_by_role('combobox',name='Topic',exact=True)
                expect(picker).to_be_enabled()
                assert picker.locator('optgroup').count()==3
                picker.select_option('grammar:giving-it')
                expect(page.locator('.practice-topic-detail')).to_contain_text('3 learned')
                expect(page.locator('.practice-topic-detail')).to_contain_text('She gave it to you.')
                search=page.get_by_role('searchbox',name='Search topics and examples')
                search.fill('gave it to you'); expect(picker).to_have_value('grammar:giving-it'); search.fill('')
                assert 'topic=grammar%3Agiving-it' in page.url
                link=page.locator('a.practice-topic-modality-link, .practice-topic-modality-link a')
                assert 'topic=grammar%3Agiving-it' in link.get_attribute('href')
                picker.focus(); expect(picker).to_be_focused()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
                page.locator('.practice-topic-picker').scroll_into_view_if_needed()
                if a.axe_script:
                    page.add_script_tag(path=a.axe_script)
                    violations=page.evaluate("async () => (await axe.run('.practice-topic-picker',{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations")
                    assert not violations, json.dumps(violations)
                page.screenshot(path=str(out/f'{modality}-{theme}-{width}.png'),full_page=True)
                picker.select_option('');expect(picker).to_have_value('')
                assert 'topic=' not in page.url
                assert not errors and not blocked,(errors,blocked)
                report['checks'].append(f'{modality} {theme} {width}: browse, search, clear, keyboard, responsive'+(', axe' if a.axe_script else ''))
                ctx.close()

        for scenario in ['normal','empty','selection-error','unavailable','retry','unknown']:
            suffix='&topic=does-not-exist' if scenario=='unknown' else '&topic=grammar%3Agiving-it'
            ctx,page,requests,blocked,errors=case(route+suffix,scenario=scenario)
            start=page.get_by_role('button',name=re.compile(r'^Start'))
            if scenario=='retry':
                expect(page.get_by_role('button',name='Retry topics')).to_be_visible()
                expect(start).to_be_disabled()
                page.get_by_role('button',name='Retry topics').click()
            picker=page.get_by_role('combobox',name='Topic',exact=True)
            expect(picker).to_be_enabled()
            if scenario in ['unavailable','unknown']:
                expect(start).to_be_disabled()
                assert not any(r['method']=='POST' for r in requests)
            elif modality=='written' or a.browser=='chromium':
                expect(start).to_be_enabled()
                start.click()
                if scenario in ['empty','selection-error']:
                    expect(page.locator('.alert-error')).to_be_visible()
                    assert not any(r['method']=='POST' for r in requests), requests
                    expect(start).to_be_enabled()
                else:
                    expect(page.get_by_role('heading',name='She gave it to you.',exact=True)).to_be_visible()
                    assert len([r for r in requests if r['method']=='POST'])==1
                    assert not page.get_by_text('Ella te lo dio.',exact=True).is_visible()
            assert not errors and not blocked,(errors,blocked)
            report['checks'].append(f'{modality} {scenario}: '+('launch verified' if modality=='written' or a.browser=='chromium' else 'picker verified; no WebKit microphone simulation'))
            ctx.close()
    for scenario,route in [('resume-focused','/write/'),('resume-focused','/write/?mode=practice'),('resume-focused','/write/?mode=practice&topic=verb%3Adar'),('resume-mix','/write/?mode=practice&topic=verb%3Adar'),('resume-legacy','/write/?mode=practice&topic=verb%3Adar')]:
        ctx,page,requests,blocked,errors=case(route,scenario=scenario)
        another=page.get_by_role('button',name='Another practice pack',exact=True)
        expect(another).to_be_visible()
        stored=page.evaluate("JSON.parse(localStorage.getItem('atr.writtenSession'))")
        if scenario=='resume-focused': assert stored['practiceTopicId']=='grammar:giving-it'
        if scenario=='resume-legacy': assert 'practiceTopicId' not in stored
        another.click()
        if scenario=='resume-legacy':
            expect(page.get_by_role('combobox',name='Topic',exact=True)).to_be_visible()
            expect(page.locator('.alert-error')).to_contain_text('no saved practice focus')
            assert not any(r['method']=='POST' for r in requests), requests
        else:
            expect(page.get_by_role('heading',name='She gave it to you.',exact=True)).to_be_visible()
            assert len([r for r in requests if r['method']=='POST'])==1
            topic_calls=[r for r in requests if r['path']=='/api/practice/topic-cards']
            assert bool(topic_calls)==(scenario=='resume-focused'), requests
            if scenario=='resume-focused': assert 'topic=grammar%3Agiving-it' in page.url
            saved=page.evaluate("JSON.parse(localStorage.getItem('atr.writtenSession'))")
            assert saved['practiceTopicId']==('grammar:giving-it' if scenario=='resume-focused' else None), saved
        assert not errors and not blocked,(errors,blocked)
        report['checks'].append(f'written {scenario} from {route}: next-pack scope preserved or fails closed')
        ctx.close()
    browser.close()
report['status']='passed'
(out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
