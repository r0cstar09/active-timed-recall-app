/* Built-UI acceptance using synthetic intercepted APIs. No learner reads/writes. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const BASE=process.env.RETRY_QA_BASE||'http://127.0.0.1:18769',OUT=process.env.RETRY_QA_OUTPUT;
assert.ok(OUT);fs.mkdirSync(OUT,{recursive:true});
const failure={code:'grader_unavailable',retryable:true,retry_action:'retry_grading_same_answer',message:'AI grading was temporarily unavailable.'};
const pending={sprint_item_id:990001,phrase_id:990001,position:1,result:'pending',english:'I want tea.',prompt:'I want tea.',recording_id:990001,spanish:null};
const passed={...pending,sprint_item_id:990002,phrase_id:990002,position:2,result:'pass',spanish:'Necesito agua.',english:'I need water.',fsrs_applied:true,fsrs_rating:3};
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});const checks=[];
 try{
 for(const scenario of ['spoken-failure','spoken-repeat-failure','spoken-already-complete','spoken-lost-response','spoken-complete','spoken-unclear','spoken-running-reload','written-initial-failure','written-legacy-failure','written-failure','written-lost-response']){
  const written=scenario.startsWith('written'),complete=scenario==='spoken-complete',unclear=scenario==='spoken-unclear';
  const ctx=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'});const page=await ctx.newPage();page.setDefaultTimeout(15000);
  const blocked=[],errors=[],posts=[];let retries=0,finished=complete||unclear,failedAgain=false,lost=false;
  const job={job_id:990010,status:'failed',failure,error_message:null};
  if(scenario==='spoken-running-reload'){job.job_id=990011;job.status='processing';}
  const session=()=>({session_id:990001,mode:'review',response_mode:written?'written':'spoken',affects_fsrs:true,status:finished||scenario==='written-legacy-failure'?'complete':written?'awaiting_recordings':'failed',
   grading_job:written?null:finished?{job_id:990011,status:'complete'}:job,
   items:[{...pending,...(scenario==='written-legacy-failure'?{result:'fail',error_type:'grader_timeout'}:{}),...(written?{recording_id:null,user_transcript_segment:'Quiero té.'}:{}),...(finished?{result:unclear?'partial':'pass',error_type:unclear?'transcription_unclear':'none',spanish:'Quiero té.',fsrs_applied:!unclear,feedback:unclear?'Audio was unclear.':'Meaning accepted.'}: {})},written?{...passed,result:finished||scenario==='written-legacy-failure'?'pass':'pending',user_transcript_segment:'Necesito agua.'}:passed],
   summary:finished?{total:2,passed:unclear?1:2,failed:0,partial:unclear?1:0,score:100,overtime_count:0}:null});
  const saved=written?{version:1,sessionId:990001,phraseIds:[990001,990002],mode:'review',targetVerb:'',phase:scenario==='written-initial-failure'?'answer':'results',index:1,answers:{990001:{answer:'Quiero té.',response_seconds:3},990002:{answer:'Necesito agua.',response_seconds:4}},draft:'Necesito agua.',promptStartedAt:Date.now()}
    :{sessionId:990001,mode:'review',continuationMode:'review',items:session().items,index:1,phase:complete||unclear||scenario==='spoken-running-reload'?'summary':'grading',deadline:null,durationMs:null,promptShownAt:null,uploadedItemIds:[990001,990002],jobId:990010,graded:session(),savedAt:Date.now()};
  await ctx.addInitScript(({saved,written})=>{if(!sessionStorage.seeded){localStorage.setItem(written?'atr.writtenSession':'atr.session',JSON.stringify(saved));sessionStorage.seeded='1';}},{saved,written});
  page.on('pageerror',e=>errors.push(String(e)));
  await ctx.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname,method=req.method();
   if(u.hostname==='static.cloudflareinsights.com')return route.fulfill({status:200,body:''});
   const isAPI=u.hostname==='api-spanish.tonymuzo.dev'||u.origin===BASE&&p.startsWith('/api/');
   if(!isAPI){if(u.origin===BASE&&['GET','HEAD'].includes(method))return route.continue();blocked.push({p,method});return route.abort();}
   const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'},body:JSON.stringify(body)});
   if(method==='OPTIONS')return reply({});
   if(method==='POST')posts.push({p,body:req.postDataJSON()});
   if(p==='/api/sessions/990001'&&method==='GET')return reply(session());
   if(p==='/api/study/verbs')return reply({verbs:[]});
   if(p==='/api/sources')return reply([]);
   if(p==='/api/sessions/990001/written-grade')return reply({detail:'AI grading was temporarily unavailable.'},503);
   if(p==='/api/sessions/990001/grade')return reply({job_id:990010});
   if(p==='/api/jobs/990010')return reply(job);
   if(p==='/api/jobs/990011'){
    if(scenario==='spoken-repeat-failure'&&!failedAgain){failedAgain=true;job.job_id=990011;return reply({...job});}
    finished=true;return reply({job_id:990011,status:'complete'});
   }
   if(/\/api\/jobs\/99001[01]\/retry/.test(p)||p==='/api/sessions/990001/written-grade/retry'){
    retries++;await new Promise(r=>setTimeout(r,250));
    if(scenario.endsWith('lost-response')&&!lost){lost=true;if(written)finished=true;return route.abort('failed');}
    if(written){finished=true;return reply(session());}
    if(scenario==='spoken-already-complete'){finished=true;return reply({status:'already_complete'});}
    return reply({status:'queued',job_id:990011},202);
   }
   blocked.push({p,method});return route.abort();
  });
  try{
   await page.goto(BASE+(written?'/write/':'/session/?mode=review'));
   if(complete||unclear||scenario==='spoken-running-reload')await page.getByRole('button',{name:'Resume',exact:true}).click();
   if(complete||unclear){
    await page.getByText(complete?'Clean recall':'Session graded',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Retry grading',exact:true}).count(),0);
    if(unclear)await page.getByRole('button',{name:'Re-record now',exact:true}).waitFor();
   }else{
    if(scenario==='written-initial-failure')await page.getByRole('button',{name:'Grade all answers',exact:true}).click();
    let retry=page.getByRole('button',{name:scenario==='spoken-running-reload'?'Reconnect to grading':'Retry grading',exact:true});await retry.waitFor();
    assert.equal(await page.getByText('Clean recall',{exact:true}).count(),0);
    await page.reload();if(!written)await page.getByRole('button',{name:'Resume',exact:true}).click();await retry.waitFor();
    await page.screenshot({path:path.join(OUT,scenario+'-failure.png')});
    await retry.evaluate(el=>{el.click();el.click();});
    if(scenario==='spoken-repeat-failure'||scenario.endsWith('lost-response')){
     await retry.waitFor();assert.equal(retries,1);await retry.click();
    }
    await page.getByText(written?'Written pack complete':'Clean recall',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Retry grading',exact:true}).count(),0);
    assert.equal(retries,scenario==='spoken-running-reload'?0:scenario==='spoken-repeat-failure'||scenario==='spoken-lost-response'?2:1);
    assert.ok(posts.every(r=>!r.p.includes('/recording')&&!r.p.includes('/items/')));
    assert.ok(posts.filter(r=>r.p.endsWith('/retry')).every(r=>JSON.stringify(r.body)==='{}'));
    await page.screenshot({path:path.join(OUT,scenario+'-complete.png')});
   }
   assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   checks.push({scenario,passed:true,retries,synthetic_only:true});
  }catch(e){await page.screenshot({path:path.join(OUT,scenario+'-error.png')});console.error({scenario,blocked,errors,posts});throw e;}finally{await ctx.close();}
 }
 const report={status:'passed',checks,production_api_reads:0,production_api_writes:0};fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
