import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/RecallSession.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('RecallSession.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name, scope) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer && ts.isCallExpression(node.initializer)) found = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `Missing actual source handler ${name}`);
  const code = ts.transpileModule(`globalThis.handler = (${found.getText(tree)});`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const context = vm.createContext(scope);
  vm.runInContext(code, context);
  return context.handler;
}
const ref = current => ({current});
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
function inline() {
  const calls = {upload:0,grade:0,poll:0,refresh:0,done:0};
  const blob = new Blob(['real captured bytes']);
  const scope = {
    api: {uploadRecording: async () => { calls.upload++; }, gradeItem: async () => {calls.grade++; return {job_id:9};}, getSession:async () => {calls.refresh++; return {session_id:1};}},
    pollJob:async () => {calls.poll++;}, onDone:() => {calls.done++;},
    pendingRef:ref({blob,mimeType:'audio/mp4',filename:'take.m4a',answeredAtMs:6000,timedOut:false}),
    targetRef:ref({id:2,limit:15}), shownAtRef:ref(1000), recRef:ref({dispose(){}}),
    uploadedTargetRef:ref(null), gradedTargetRef:ref(null), uploadInFlightRef:ref(false),
    mountedRef:ref(true), finishingRef:ref(true), sessionId:1, noisyMode:false,
    setPhase:phase => {scope.phase=phase;}, setError:error => {scope.error=error;},
    ApiError:Error, isIncompleteRecordingError:e => e?.body?.detail?.code === 'recording_incomplete',
  };
  return {scope,calls,blob,run:handler('uploadAndGrade',scope)};
}
for (const stage of ['grade','poll','refresh']) {
  test(`accepted audio is not uploaded again after ${stage} failure`, async () => {
    const f=inline();
    const key={grade:'gradeItem',poll:'pollJob',refresh:'getSession'}[stage];
    const owner=stage==='poll'?f.scope:f.scope.api;
    const original=owner[key]; let first=true;
    owner[key]=async (...args) => {if(first){first=false; throw new Error('temporary network outage');} return original(...args);};
    await f.run();
    assert.equal(f.scope.phase,'error');
    assert.equal(f.scope.pendingRef.current,null,'accepted Blob must not remain eligible for upload');
    await f.run();
    assert.equal(f.calls.upload,1);
    assert.equal(f.calls.done,1);
    if(stage==='refresh') assert.equal(f.calls.grade,1,'refresh retry must not enqueue grading again');
  });
}
test('unknown upload acceptance retains the exact Blob; incomplete capture discards it', async () => {
  const f=inline(); let first=true;
  f.scope.api.uploadRecording=async (_s,_i,blob) => {f.calls.upload++; assert.equal(blob,f.blob); if(first){first=false;throw new Error('network');}};
  await f.run(); assert.equal(f.scope.pendingRef.current.blob,f.blob);
  await f.run(); assert.equal(f.calls.upload,2); assert.equal(f.calls.done,1);
  const bad=inline();
  bad.scope.api.uploadRecording=async () => {throw {body:{detail:{code:'recording_incomplete'}}};};
  await bad.run(); assert.equal(bad.scope.pendingRef.current,null); assert.equal(bad.calls.grade,0); assert.equal(bad.scope.uploadedTargetRef.current,null);
});
test('inline upload retry has a synchronous single-flight lock', async () => {
  const f=inline(); const gate=deferred();
  f.scope.api.uploadRecording=async () => {f.calls.upload++; await gate.promise;};
  const first=f.run(); const second=f.run();
  assert.equal(f.calls.upload,1); gate.resolve(); await Promise.all([first,second]);
  assert.equal(f.calls.done,1); assert.equal(f.scope.uploadInFlightRef.current,false);
});
test('main upload retry has a synchronous lock released after failure and success', async () => {
  const gate=deferred(); let uploads=0,advances=0;
  const pending={item:{sprint_item_id:2},itemIndex:0,blob:new Blob(['audio']),promptShownAtMs:1,answeredAtMs:1000};
  const scope={pendingUploadRef:ref(pending),uploadInFlightRef:ref(false),sessionIdRef:ref(1),uploadedRef:ref([]),noisyMode:false,items:[{},{}],setPhase(){},setError(){},persist(){},isoFromMs:ms=>new Date(ms).toISOString(),api:{uploadRecording:async()=>{uploads++;await gate.promise;}},ApiError:Error,isIncompleteRecordingError:()=>false,beginItem:()=>{advances++;},startGrading:()=>{throw new Error('unexpected');}};
  const run=handler('uploadPendingAndAdvance',scope);
  const first=run(); const second=run(); assert.equal(uploads,1); gate.resolve(); await Promise.all([first,second]);
  assert.equal(advances,1); assert.equal(scope.uploadInFlightRef.current,false);
  scope.pendingUploadRef.current=pending; scope.api.uploadRecording=async()=>{throw new Error('outage');};
  await run(); assert.equal(scope.uploadInFlightRef.current,false); assert.equal(scope.pendingUploadRef.current,pending);
});
test('inline setup cannot start a recorder after unmount during the retry request', async () => {
  const gate=deferred(); let starts=0;
  const rec={init:async()=>{},start:async()=>{starts++;},dispose(){}};
  const scope={beginningRef:ref(false),mountedRef:ref(true),recRef:ref(rec),targetRef:ref(null),pendingRef:ref(null),uploadedTargetRef:ref(null),gradedTargetRef:ref(null),finishingRef:ref(false),shownAtRef:ref(0),deadlineRef:ref(0),disabled:false,phase:'idle',sessionId:1,item:{sprint_item_id:2},setError(){},setPhase(){},setSecs(){},recallSecondsFromServer:x=>x,ENCODER_PREROLL_MS:0,ApiError:Error,api:{retryItem:()=>gate.promise}};
  const run=handler('begin',scope); const pending=run(); await Promise.resolve();
  scope.mountedRef.current=false; rec.dispose();
  gate.resolve({sprint_item_id:3,time_limit_seconds:15}); await pending;
  assert.equal(starts,0);
});
