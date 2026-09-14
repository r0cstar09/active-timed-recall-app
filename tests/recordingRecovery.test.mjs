import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { isIncompleteRecordingError } from '../src/lib/recordingRecovery.ts';

test('incomplete capture is distinguished from a retryable upload outage', () => {
  assert.equal(isIncompleteRecordingError({status:422,body:{detail:{code:'recording_incomplete',message:'Record again'}}}),true);
  for (const error of [null,undefined,'recording_incomplete',new Error('Network failed'),{status:503},{body:{detail:'recording_incomplete'}},{body:{detail:[{msg:'Invalid input'}]}},{body:{detail:{code:'other'}}}]) {
    assert.equal(isIncompleteRecordingError(error),false);
  }
});

const source=readFileSync(new URL('../src/components/RecallSession.tsx',import.meta.url),'utf8');
test('normal capture recovery stays on the card and resets mic and deadline without grading', () => {
  const recover=source.slice(source.indexOf('  function recoverMicrophone('),source.indexOf('  async function beginItem('));
  assert.match(recover,/recorderRef\.current\?\.dispose\(\)/);
  assert.match(recover,/recorderRef\.current = null/);
  assert.match(recover,/pendingUploadRef\.current = null/);
  assert.match(recover,/setDeadline\(null\)/);
  assert.match(recover,/phase: "arming", deadline: null/);
  assert.doesNotMatch(recover,/api\.|setIndex\(|beginItem\(/);
});

test('normal and inline retry monitor capture health and reject incomplete uploads', () => {
  assert.equal((source.match(/\.captureIssue/g)||[]).length,2);
  assert.equal((source.match(/isIncompleteRecordingError\(err\)/g)||[]).length,2);
  const retry=source.slice(source.indexOf('function RetryRecorder('));
  assert.ok(retry.indexOf('if (rec.interrupted)') < retry.indexOf('pendingRef.current = { blob:'));
  assert.match(retry,/beginningRef\.current \|\|/);
  assert.match(retry,/if \(isIncompleteRecordingError\(err\)\) \{\s*pendingRef\.current = null/);
});

test('session microphone is released before inline retry can open another', () => {
  const grading=source.slice(source.indexOf('  async function startGrading('),source.indexOf('  async function runGrading('));
  assert.ok(grading.indexOf('recorderRef.current?.dispose()') < grading.indexOf('api.gradeSession('));
  assert.match(grading,/recorderRef\.current = null/);
});
