import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../src/components/RecallSession.tsx", import.meta.url), "utf8");

assert.match(
  apiSource,
  /createSession\(mode: SessionMode = "review", size = 10, phraseIds\?: number\[\]\)/,
  "createSession must accept an optional targeted phrase batch",
);
assert.match(
  apiSource,
  /\.\.\.\(phrase_ids\?\.length \? \{ phrase_ids \} : \{\}\)/,
  "targeted phrase IDs must be serialized as phrase_ids",
);

const handoffStart = sessionSource.indexOf("async function acknowledgeLearned()");
const handoffEnd = sessionSource.indexOf("async function startGrading", handoffStart);
assert.ok(handoffStart >= 0 && handoffEnd > handoffStart, "Learn handoff function must exist");
const handoff = sessionSource.slice(handoffStart, handoffEnd);

const armAt = handoff.indexOf("await armRecorder()");
const introduceAt = handoff.indexOf("await api.introducePhrase");
assert.ok(armAt >= 0 && armAt < introduceAt, "microphone must arm from the learner's final tap before network awaits");
assert.match(
  handoff,
  /api\.createSession\("practice", learnedPhraseIds\.length, learnedPhraseIds\)/,
  "Learn completion must launch targeted practice for the exact learned batch",
);
assert.match(
  sessionSource,
  /I understand · test these now/,
  "the final Learn action must describe the immediate test",
);
assert.doesNotMatch(
  handoff,
  /setPhase\("summary"\)/,
  "Learn completion must not stop at the old summary dead end",
);

console.log("learn handoff regression checks passed");
