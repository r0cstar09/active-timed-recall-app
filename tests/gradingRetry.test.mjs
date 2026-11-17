import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canRetryGrading } from '../src/lib/gradingRetry.ts';
import { reconcileWrittenSession } from '../src/lib/writtenSession.ts';
const failure = { retryable: true, retry_action: 'retry_grading_same_answer', code: 'grader_unavailable', message: 'Unavailable' };
test('only a retryable failed pipeline offers same-answer grading', () => {
  assert.equal(canRetryGrading({status:'failed',failure}),true);
  for(const status of ['queued','processing','complete']) assert.equal(canRetryGrading({status,failure}),false);
  for(const value of [undefined,null,{status:'failed'},{status:'failed',failure:{...failure,retryable:false}},{status:'failed',failure:{...failure,retry_action:'re_record'}}]) assert.equal(canRetryGrading(value),false);
});
test('written failure and refresh preserve submitted answers, time and results retry', () => {
  const saved={version:1,sessionId:1,phraseIds:[1],mode:'learn',targetVerb:'',phase:'grading',index:0,answers:{11:{answer:'Quiero té.',response_seconds:3}},draft:'Quiero té.',promptStartedAt:100};
  const session={session_id:1,response_mode:'written',mode:'practice',status:'awaiting_recordings',items:[{sprint_item_id:11,phrase_id:1,result:'pending'}]};
  for(const phase of ['grading','results']) {
    const result=reconcileWrittenSession({...saved,phase},session);
    assert.equal(result.phase,'results'); assert.deepEqual(result.answers,saved.answers); assert.equal(result.mode,'learn');
  }
  assert.equal(reconcileWrittenSession({...saved,phase:'answer'},session).phase,'answer');
});
