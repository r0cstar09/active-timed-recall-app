/* Mode-continuation acceptance. Built UI + fully intercepted synthetic API traffic.
 * Run only on approved browser worker/CI. No learner data is read or mutated.
 */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const BASE=(process.env.CONTINUATION_QA_BASE||'http://127.0.0.1:18765').replace(/\/$/,'');
const OUT=process.env.CONTINUATION_QA_OUTPUT;
assert.ok(OUT,'Set CONTINUATION_QA_OUTPUT to a private artifact directory');fs.mkdirSync(OUT,{recursive:true});
const item={sprint_item_id:990001,phrase_id:990001,position:1,result:'pass',prompt_type:'english_to_spanish',prompt:'I want tea.',english:'I want tea.',english_meaning:'I want tea.',spanish:'Quiero té.',answer_visible:true,recording_id:990001,feedback:'Synthetic completion fixture.',scheduling:{time_limit_seconds:15,prompt_stage:0,state:'review'}};
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const checks=[];
 try{
  for(const scenario of [
   {name:'recall-next',mode:'review',origin:'review',next:'review'},
   {name:'learn-test-next',mode:'practice',origin:'learn',next:'learn'},
   {name:'correction-keeps-recall',mode:'practice',origin:'review',next:'review'},
   {name:'legacy-authoritative-mode',mode:'review',next:'review',legacy:true},
   {name:'recall-exhausted',mode:'review',origin:'review',next:'review',empty:true},
   {name:'recall-network-retry',mode:'review',origin:'review',next:'review',failFirst:true},
   {name:'fresh-grading-next',mode:'review',origin:'review',next:'review',grading:true},
  ]){
   const context=await browser.newContext({viewport:{width:390,height:844},permissions:['microphone'],serviceWorkers:'block',reducedMotion:'reduce'});
   const page=await context.newPage();page.setDefaultTimeout(20000);
   const requests=[],errors=[],blocked=[];let fail=scenario.failFirst;
   page.on('pageerror',error=>errors.push(String(error)));
   const graded={session_id:990001,items:[item],mode:scenario.mode,response_mode:'spoken',affects_fsrs:scenario.mode==='review',status:'complete',summary:{total:1,passed:1,failed:0,partial:0,score:100,overtime_count:0}};
   const saved={sessionId:990001,mode:scenario.legacy?undefined:scenario.mode,continuationMode:scenario.origin,items:[item],index:0,phase:scenario.grading?'grading':'summary',deadline:null,durationMs:15000,promptShownAt:null,uploadedItemIds:[990001],jobId:scenario.grading?990001:null,graded,savedAt:Date.now()};
   await context.addInitScript(({saved})=>{if(!sessionStorage.getItem('continuation-fixture-seeded')){localStorage.setItem('atr.session',JSON.stringify(saved));sessionStorage.setItem('continuation-fixture-seeded','1');}},{saved});
   await context.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname;
    if(u.hostname==='static.cloudflareinsights.com')return route.fulfill({status:200,contentType:'application/javascript',body:'/* fixture telemetry off */'});
    if(u.origin===new URL(BASE).origin&&p==='/cdn-cgi/rum'){return route.abort();}
    const isAPI=u.hostname==='api-spanish.tonymuzo.dev'||(u.origin===new URL(BASE).origin&&p.startsWith('/api/'));
    if(!isAPI){if(u.origin===new URL(BASE).origin&&['GET','HEAD'].includes(req.method()))return route.continue();blocked.push({method:req.method(),category:'unexpected-origin'});return route.abort();}
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'};
    const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',headers,body:JSON.stringify(body)});
    if(req.method()==='OPTIONS')return reply({});
    if(p==='/api/sessions/990001'&&req.method()==='GET')return reply(graded);
    if(p==='/api/sessions/990002'&&req.method()==='GET')return reply({...graded,session_id:990002,mode:scenario.next,items:[{...item,sprint_item_id:990002,phrase_id:990002}]});
    if(p==='/api/sessions/990001/grade'&&req.method()==='POST'&&scenario.grading)return reply({job_id:990001});
    if(p==='/api/jobs/990001'&&req.method()==='GET')return reply({job_id:990001,status:'complete'});
    if(p==='/api/sessions'&&req.method()==='POST'){
     const body=req.postDataJSON();requests.push(body);
     await new Promise(resolve=>setTimeout(resolve,180));
     if(fail){fail=false;return reply({detail:'Synthetic next-set outage'},503);}
     const nextItem={...item,sprint_item_id:990002,phrase_id:990002,recording_id:null,result:'pending',answer_visible:body.mode==='learn',spanish:body.mode==='learn'?'Necesito agua.':null,english:'I need water.',english_meaning:'I need water.',prompt:'I need water.'};
     return reply({session_id:990002,mode:body.mode,response_mode:'spoken',affects_fsrs:body.mode==='review',items:scenario.empty?[]:[nextItem]});
    }
    if(req.method()==='GET'&&p==='/api/sources')return reply([]);
    blocked.push({method:req.method(),category:'unexpected-api',path:p});return route.abort();
   });
   try{
    await page.goto(BASE+'/session/?mode='+scenario.mode);
    if(!scenario.grading)await page.getByRole('button',{name:'Resume',exact:true}).click();
    const label=scenario.next==='learn'?'Learn next batch':'Next recall set';
    const button=page.getByRole('button',{name:label,exact:true});await button.waitFor();
    assert.match(await button.getAttribute('class'),/btn-primary/);
    if(scenario.next!=='learn')assert.equal(await page.getByText('Learn next batch',{exact:true}).count(),0);
    await page.screenshot({path:path.join(OUT,scenario.name+'-results.png')});
    await button.evaluate(element=>{element.click();element.click();Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Home')?.click();});
    if(scenario.failFirst){
     await page.getByText(/Synthetic next-set outage/).waitFor();
     assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('atr.session')).sessionId),990001);
     assert.equal(requests.length,1);await button.click();
    }
    if(scenario.empty){
     await page.getByText(/No (?:more )?recall|Nothing due|Recall complete/i).first().waitFor();
     assert.equal(await page.locator('a[href="/session?mode=learn"]').count(),0);
     assert.equal(await page.evaluate(()=>localStorage.getItem('atr.session')),null);
    }else{
     await page.getByText('I need water.',{exact:true}).first().waitFor();
     const nextSaved=await page.evaluate(()=>JSON.parse(localStorage.getItem('atr.session')));
     assert.equal(nextSaved.sessionId,990002);assert.equal(nextSaved.mode,scenario.next);
     assert.equal(nextSaved.continuationMode,scenario.next);
     assert.equal(new URL(page.url()).searchParams.get('mode'),scenario.next);
     // Freeze a synthetic completed next set, then verify reload does not hide it.
     await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('atr.session'));s.phase='summary';s.graded={session_id:s.sessionId,mode:s.mode,items:s.items};localStorage.setItem('atr.session',JSON.stringify(s));});
     await page.reload();await page.getByRole('button',{name:'Resume',exact:true}).click();
     await page.getByRole('button',{name:label,exact:true}).waitFor();
    }
    assert.equal(requests.length,scenario.failFirst?2:1);assert.ok(requests.every(r=>r.mode===scenario.next));
    assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
    checks.push({name:scenario.name,mode:scenario.next,create_requests:requests.length,synthetic_only:true,passed:true});
   }catch(error){await page.screenshot({path:path.join(OUT,scenario.name+'-failure.png')});console.error(JSON.stringify({scenario:scenario.name,error:String(error),requests,blocked,errors}));throw error;}
   finally{await context.close();}
  }
  const report={status:'passed',checks,production_api_reads:0,production_api_writes:0,base:BASE};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser.close();}
})().catch(error=>{console.error(String(error));process.exitCode=1;});
