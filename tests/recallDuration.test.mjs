import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RECALL_SECONDS,
  RECALL_SECONDS,
  itemForDuration,
  recallSecondsFromServer,
} from "../src/lib/recallDuration.ts";

test("keeps the 15 second fallback for missing and malformed payloads", () => {
  assert.equal(RECALL_SECONDS, 15);
  assert.equal(recallSecondsFromServer(undefined), 15);
  assert.equal(recallSecondsFromServer(null), 15);
  assert.equal(recallSecondsFromServer(Number.NaN), 15);
  assert.equal(recallSecondsFromServer(-5), 15);
  assert.equal(recallSecondsFromServer(8), 15);
});

test("uses backend per-card clause budgets", () => {
  assert.equal(recallSecondsFromServer(20), 20);
  assert.equal(recallSecondsFromServer(25), 25);
  assert.equal(recallSecondsFromServer(30), 30);
  assert.equal(recallSecondsFromServer(35), 35);
});

test("caps stale or hostile server values at 35 seconds", () => {
  assert.equal(MAX_RECALL_SECONDS, 35);
  assert.equal(recallSecondsFromServer(300), 35);
});

test("reads the main recall duration from item scheduling metadata", () => {
  assert.equal(itemForDuration(), 15);
  assert.equal(itemForDuration({ scheduling: { time_limit_seconds: 25 } }), 25);
});
