import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { correctionPhraseIds, targetedPhraseIds, assertTargetedSession } from "../src/lib/sessionCorrections.ts";

const item = (phrase_id, result, attempt_number = 1, sprint_item_id = phrase_id) => ({ phrase_id, result, attempt_number, sprint_item_id });

test("corrections contain only this batch's failed/partial cards, in batch order", () => {
  assert.deepEqual(correctionPhraseIds([item(42, "pass"), item(9, "partial"), item(17, "fail")]), [9, 17]);
});
test("each correction round shrinks to its own remaining misses; never tops up", () => {
  assert.deepEqual(correctionPhraseIds([item(9, "pass"), item(17, "partial")]), [17]);
  assert.deepEqual(correctionPhraseIds([item(17, "pass")]), []);
  assert.deepEqual(correctionPhraseIds([]), []);
});
test("successful inline retries supersede historical failures even out of order", () => {
  assert.deepEqual(correctionPhraseIds([item(9, "pass", 2, 102), item(9, "fail", 1, 99), item(17, "partial")]), [17]);
  assert.deepEqual(correctionPhraseIds([item(9, "fail", 1, 99), item(9, "pending", 2, 102)]), []);
});
test("explicit empty or invalid targeting must not silently become the general queue", () => {
  assert.equal(targetedPhraseIds(undefined), undefined);
  assert.deepEqual(targetedPhraseIds([9, 17, 9]), [9, 17]);
  for (const ids of [[], [0], [-1], [NaN], [1.2], [9, "17"], [9, 0]]) {
    assert.throws(() => targetedPhraseIds(ids), /batch/i);
  }
});
test("targeted response must match the exact ordered set with FSRS off", () => {
  const session = { session_id: 6, mode: "practice", affects_fsrs: false, items: [item(9, "pending"), item(17, "pending")] };
  assert.doesNotThrow(() => assertTargetedSession(session, [9, 17]));
  for (const change of [
    { items: [item(500, "pending"), item(17, "pending")] },
    { items: [item(9, "pending")] },
    { items: [item(17, "pending"), item(9, "pending")] },
    { items: [] }, { session_id: 0 }, { mode: "review" }, { affects_fsrs: true },
  ]) assert.throws(() => assertTargetedSession({ ...session, ...change }, [9, 17]), /batch/i);
});
test("spoken summary never routes batch corrections through the global misses page", () => {
  const source = readFileSync(new URL("../src/components/RecallSession.tsx", import.meta.url), "utf8");
  const summary = source.slice(source.indexOf("function Summary("));
  assert.doesNotMatch(summary, /href="\/session\?mode=misses"/);
  assert.match(source, /api\.createSession\("practice", phraseIds\.length, phraseIds\)/);
  assert.match(summary, /Correct this batch/);
  assert.match(summary, /Learn next batch/);
});
test("written results offer a targeted correction round, not another queue pack", () => {
  const source = readFileSync(new URL("../src/components/WrittenRecall.tsx", import.meta.url), "utf8");
  assert.match(source, /async function correctBatch/);
  assert.match(source, /correctionPhraseIds\(session\.items\)/);
  assert.match(source, /Correct this batch/);
});
