import assert from "node:assert/strict";
import test from "node:test";
import {
  clipPositionFromSourceTime,
  createLineSplitSuggestions,
  partitionSpanishAtCursor,
  sourceTimeFromClipPosition,
  splitDraftEligibility,
} from "../src/lib/clipEditing.ts";

const draft = (extra = {}) => ({
  id: 701,
  import_id: 91,
  segment_indices: [4, 5],
  spanish: "¿Qué cambió en el descanso? Salimos con más intensidad y marcamos pronto.",
  english: "What changed at halftime? We came out with more intensity and scored early.",
  start_time: 100.8,
  end_time: 109.2,
  revision: 3,
  status: "ready",
  approved: false,
  warning: null,
  error_message: null,
  audio_url: "/api/audio/combined.wav",
  repair_phrase_id: null,
  phrase_id: null,
  existing_phrase_id: null,
  existing_active: null,
  manual_timing: true,
  created_at: "2026-10-13T00:00:00Z",
  updated_at: "2026-10-13T00:00:00Z",
  ...extra,
});

const transcript = [
  { index: 3, text: "Antes del partido.", english: "Before the match.", start: 98, end: 100 },
  { index: 4, text: "¿Qué cambió en el descanso?", english: "What changed at halftime?", start: 101, end: 107.6 },
  { index: 5, text: "Salimos con más intensidad y marcamos pronto.", english: "We came out with more intensity and scored early.", start: 105.4, end: 109 },
];

test("clip-relative playhead maps to absolute source seconds and back", () => {
  assert.equal(sourceTimeFromClipPosition(100.8, 3.4, 8.4), 104.2);
  assert.equal(sourceTimeFromClipPosition(100.8, 99, 8.4), 109.2);
  assert.equal(clipPositionFromSourceTime(100.8, 104.2, 8.4), 3.4);
  assert.equal(clipPositionFromSourceTime(100.8, 80, 8.4), 0);
});

test("an exact saved question and answer uses the next line start despite overlapping captions", () => {
  const suggestions = createLineSplitSuggestions(draft(), transcript);
  assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0], {
    afterSegmentIndex: 4,
    leftSpanish: "¿Qué cambió en el descanso?",
    rightSpanish: "Salimos con más intensidad y marcamos pronto.",
    suggestedSourceTime: 105.4,
  });
});

test("line suggestions disappear when transcript lines do not exactly map to saved Spanish", () => {
  assert.deepEqual(createLineSplitSuggestions(draft({ spanish: "¿Qué cambió? Salimos con intensidad." }), transcript), []);
  assert.deepEqual(createLineSplitSuggestions(draft({ segment_indices: [4] }), transcript), []);
});

test("cursor fallback partitions every Spanish word exactly without splitting a word", () => {
  const spanish = "¿Qué cambió en el descanso? Salimos con más intensidad.";
  const cursor = spanish.indexOf(" Salimos") + 1;
  assert.deepEqual(partitionSpanishAtCursor(spanish, cursor), {
    ok: true,
    leftSpanish: "¿Qué cambió en el descanso?",
    rightSpanish: "Salimos con más intensidad.",
  });
  const insideWord = spanish.indexOf("cambió") + 3;
  const invalid = partitionSpanishAtCursor(spanish, insideWord);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /between words/i);
});

test("split eligibility blocks unsafe draft states and allows prepared ordinary clips", () => {
  assert.deepEqual(splitDraftEligibility(draft(), { busy: false, changed: false, stale: false }), { allowed: true, reason: null });
  assert.deepEqual(splitDraftEligibility(draft({ status: "needs_review" }), { busy: false, changed: false, stale: false }), { allowed: true, reason: null });
  assert.match(splitDraftEligibility(draft(), { busy: true, changed: false, stale: false }).reason, /finish/i);
  assert.match(splitDraftEligibility(draft(), { busy: false, changed: true, stale: false }).reason, /unsaved/i);
  assert.match(splitDraftEligibility(draft(), { busy: false, changed: false, stale: true }).reason, /server/i);
  assert.match(splitDraftEligibility(draft({ status: "queued" }), { busy: false, changed: false, stale: false }).reason, /prepar/i);
  assert.match(splitDraftEligibility(draft({ repair_phrase_id: 44 }), { busy: false, changed: false, stale: false }).reason, /repair/i);
  assert.match(splitDraftEligibility(draft({ status: "added" }), { busy: false, changed: false, stale: false }).reason, /library/i);
});
