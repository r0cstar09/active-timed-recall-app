import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const writtenSource = readFileSync(new URL("../src/components/WrittenRecall.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/pages/write.astro", import.meta.url), "utf8");
const navSource = readFileSync(new URL("../src/components/Nav.astro", import.meta.url), "utf8");

assert.match(apiSource, /response_mode: "written"/, "Written sessions must declare their response modality");
assert.match(apiSource, /target_verb/, "Written sessions must serialize the exact verb filter");
assert.match(apiSource, /written-grade/, "Typed answers must use the server-owned Written Recall grader");
assert.match(
  apiSource,
  /\.\.\.\(phrase_ids\?\.length \? \{ phrase_ids \} : \{\}\)/,
  "Written Learn handoff must support the exact learned phrase batch",
);

assert.match(writtenSource, /type WrittenMode = "learn" \| "review" \| "practice"/, "All three queue-backed written modes must remain available");
assert.match(writtenSource, /createWrittenSession\(nextMode, 10,/, "Normal Written Recall packs must contain ten cards");
assert.match(writtenSource, /await api\.introducePhrase\(current\.phrase_id\)/, "Written Learn must use the real introduction endpoint");
assert.match(
  writtenSource,
  /api\.createWrittenSession\([\s\S]*?"practice",[\s\S]*?phraseIds\.length,[\s\S]*?phraseIds,/,
  "Written Learn must immediately test the exact introduced batch",
);
assert.match(writtenSource, /api\.gradeWrittenSession\(session\.session_id, attempts\)/, "Hermes must grade the complete typed batch server-side");
assert.match(writtenSource, /advances shared FSRS scheduling/, "Review scheduling semantics must be explained in the UI");
assert.match(writtenSource, /never claims pronunciation or spoken-speed mastery/, "Typed success must not be presented as spoken evidence");
assert.doesNotMatch(writtenSource, /MediaRecorder|getUserMedia|uploadRecording/, "Written Recall must not require microphone/audio capture");

assert.match(pageSource, /WrittenRecall client:load/, "The /write route must hydrate the Written Recall module");
assert.match(navSource, /href: "\/write"/, "Written Recall must remain directly reachable from navigation");

console.log("written recall regression checks passed");
