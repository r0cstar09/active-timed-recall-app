import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  loadSession,
  saveCompletedSession,
  saveSession,
} from "../src/lib/timer.ts";

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
  clear() { this.#values.clear(); }
}

globalThis.localStorage = new MemoryStorage();

const session = (session_id, mode) => ({
  session_id,
  mode,
  affects_fsrs: mode !== "practice",
  items: [{ phrase_id: 9, sprint_item_id: 90, result: "pass" }],
});

const persisted = (sessionId, mode, continuationMode) => ({
  sessionId,
  mode,
  continuationMode,
  items: session(sessionId, mode).items,
  index: 0,
  phase: "grading",
  deadline: null,
  durationMs: null,
  promptShownAt: null,
  uploadedItemIds: [90],
  jobId: null,
  graded: null,
  savedAt: 1,
});

test.beforeEach(() => localStorage.clear());

test("completed Learn practice keeps Learn as its continuation", () => {
  saveSession(persisted(41, "practice", "learn"));
  saveCompletedSession(session(41, "practice"));
  const saved = loadSession();
  assert.equal(saved.mode, "practice");
  assert.equal(saved.continuationMode, "learn");
  assert.equal(saved.phase, "summary");
});

test("correction practice keeps the original timed-recall continuation", () => {
  saveSession(persisted(52, "practice", "review"));
  saveCompletedSession(session(52, "practice"));
  assert.equal(loadSession().continuationMode, "review");
});

test("explicit continuation wins and a different session cannot inherit stale origin", () => {
  saveSession(persisted(60, "practice", "learn"));
  saveCompletedSession(session(60, "practice"), "review");
  assert.equal(loadSession().continuationMode, "review");

  saveCompletedSession(session(61, "practice"));
  assert.equal(loadSession().continuationMode, "practice");
});

test("spoken summary uses functioning mode-aware continuation controls", () => {
  const source = readFileSync(new URL("../src/components/RecallSession.tsx", import.meta.url), "utf8");
  const summary = source.slice(source.indexOf("function Summary("));
  assert.match(source, /launchSession\(continuationModeRef\.current, true\)/);
  assert.match(source, /saved\.mode && saved\.mode !== explicitMode/);
  assert.match(source, /continuationMode: saved\.continuationMode \?\? continuationModeRef\.current/);
  assert.match(summary, /continuationMode === "learn" \? "Learn next batch" : "Next recall set"/);
  assert.doesNotMatch(summary, /href="\/session\?mode=learn"/);
  assert.match(summary, /Recall complete/);
  assert.match(summary, /No more cards are available in this recall queue right now/);
});
