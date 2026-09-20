import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWrittenSession, saveWrittenSession, clearWrittenSession, reconcileWrittenSession } from '../src/lib/writtenSession.ts';

const snapshot = { version: 1, sessionId: 21, phraseIds: [42, 9], mode: 'learn', targetVerb: 'ser', index: 1, phase: 'answer', answers: { 210: { answer: 'Soy feliz.', response_seconds: 3 } }, draft: 'Somos', promptStartedAt: 1000 };
const session = { session_id: 21, response_mode: 'written', mode: 'practice', affects_fsrs: false, status: 'awaiting_recordings', target_verb: 'ser', items: [{ sprint_item_id: 210, phrase_id: 42, result: 'pending' }, { sprint_item_id: 211, phrase_id: 9, result: 'pending' }] };

test('written batch snapshot preserves origin, exact scope, answers and unsaved draft', () => {
  const data = new Map();
  globalThis.localStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  saveWrittenSession(snapshot);
  assert.deepEqual(loadWrittenSession(), snapshot);
  clearWrittenSession();
  assert.equal(loadWrittenSession(), null);
});
test('restore keeps authoritative identity and the current unsaved answer', () => {
  const restored = reconcileWrittenSession(snapshot, session);
  assert.equal(restored.phase, 'answer');
  assert.equal(restored.index, 1);
  assert.equal(restored.draft, 'Somos');
  assert.equal(restored.mode, 'learn');
  assert.equal(restored.targetVerb, 'ser');
});
test('completed server grade takes precedence over a cached grading phase', () => {
  assert.equal(reconcileWrittenSession({ ...snapshot, phase: 'grading' }, { ...session, status: 'complete' }).phase, 'results');
  assert.equal(reconcileWrittenSession({ ...snapshot, phase: 'grading' }, session).phase, 'answer');
});
test('fully introduced Learn restores the handoff instead of unrelated default Review', () => {
  const restored = reconcileWrittenSession({ ...snapshot, phase: 'learn' }, { ...session, mode: 'learn', status: 'complete', items: session.items.map(i => ({ ...i, result: 'pass' })) });
  assert.equal(restored.phase, 'learn');
  assert.equal(restored.index, 1);
});
test('practice scope survives storage and reconciliation, including deliberate Mix all', () => {
  for (const practiceTopicId of ['grammar:giving-it', null]) {
    const data = new Map();
    globalThis.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
    const focused = { ...snapshot, mode: 'practice', practiceTopicId };
    saveWrittenSession(focused);
    const restored = reconcileWrittenSession(loadWrittenSession(), session);
    assert.equal(restored.practiceTopicId, practiceTopicId);
    assert.deepEqual(restored.phraseIds, snapshot.phraseIds);
  }
});
test('legacy unknown scope is not silently converted to deliberate Mix all', () => {
  const legacy = { ...snapshot, mode: 'practice' };
  saveWrittenSession(legacy);
  assert.equal(reconcileWrittenSession(loadWrittenSession(), session).practiceTopicId, undefined);
});
test('invalid persisted practice scope fails closed', () => {
  for (const practiceTopicId of ['', '   ', false, 123, {}]) {
    saveWrittenSession({ ...snapshot, mode: 'practice', practiceTopicId });
    assert.throws(() => loadWrittenSession(), /could not be restored/);
  }
  clearWrittenSession();
});
test('reconciliation rejects a different session, batch, order, modality or verb', () => {
  for (const change of [{ session_id: 22 }, { response_mode: 'spoken' }, { target_verb: 'ir' }, { items: [...session.items].reverse() }, { items: [{ sprint_item_id: 212, phrase_id: 999 }] }]) {
    assert.throws(() => reconcileWrittenSession(snapshot, { ...session, ...change }), /saved written batch/);
  }
});
