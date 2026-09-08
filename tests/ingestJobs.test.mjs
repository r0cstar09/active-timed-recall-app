import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";
import {
  INITIAL_INGEST_DELETE_UI,
  applyIngestDeleteResult,
  canChangeIngestSelection,
  canDeleteIngestCards,
  createIngestDeleteGate,
  executeIngestCardDeletion,
  ingestDeleteUiReducer,
  mergeRecentIngests,
  recentTerminalIngests,
  reopenRecentTerminalJob,
} from "../src/lib/ingestJobs.ts";

const terminalJob = (job_id = 41, extra = {}) => ({
  job_id,
  status: "complete",
  phrase_count: 3,
  active_phrase_count: 3,
  ownership_unknown: false,
  ownership_message: null,
  ownership_mode: "exact",
  phrases: [
    { id: 1, active: true, spanish: "uno", english: "one" },
    { id: 2, active: true, spanish: "dos", english: "two" },
    { id: 3, active: true, spanish: "tres", english: "three" },
  ],
  ...extra,
});

const deleteResponse = (extra = {}) => ({
  job_id: 41,
  removed_count: 3,
  active_phrase_count: 0,
  ownership_unknown: false,
  ownership_message: null,
  ownership_mode: "exact",
  phrase_count: 3,
  history_preserved: true,
  ...extra,
});

test("confirmation is explicit and cancel returns to the safe idle state", () => {
  const confirming = ingestDeleteUiReducer(INITIAL_INGEST_DELETE_UI, {
    type: "confirm",
    job: terminalJob(),
  });
  assert.equal(confirming.confirmJobId, 41);
  assert.equal(confirming.deletingJobId, null);

  const cancelled = ingestDeleteUiReducer(confirming, { type: "cancel" });
  assert.deepEqual(cancelled, INITIAL_INGEST_DELETE_UI);
});

test("successful deletion updates active counts, deactivates loaded phrases, and reports preserved history", () => {
  const job = terminalJob();
  const confirming = ingestDeleteUiReducer(INITIAL_INGEST_DELETE_UI, { type: "confirm", job });
  const deleting = ingestDeleteUiReducer(confirming, { type: "started", jobId: job.job_id });
  const updated = applyIngestDeleteResult(job, deleteResponse());
  const succeeded = ingestDeleteUiReducer(deleting, {
    type: "succeeded",
    jobId: job.job_id,
    removedCount: 3,
    historyPreserved: true,
  });

  assert.equal(updated.active_phrase_count, 0);
  assert.equal(updated.phrase_count, 3);
  assert.ok(updated.phrases.every((phrase) => phrase.active === false));
  assert.equal(succeeded.confirmJobId, null);
  assert.equal(succeeded.deletingJobId, null);
  assert.match(succeeded.message, /Removed 3 cards/);
  assert.match(succeeded.message, /Review history was preserved/);
  assert.equal(succeeded.error, null);
});

test("delete errors remain actionable and keep confirmation available for a retry", () => {
  const job = terminalJob();
  const confirming = ingestDeleteUiReducer(INITIAL_INGEST_DELETE_UI, { type: "confirm", job });
  const deleting = ingestDeleteUiReducer(confirming, { type: "started", jobId: job.job_id });
  const failed = ingestDeleteUiReducer(deleting, {
    type: "failed",
    jobId: job.job_id,
    error: "Temporary backend failure",
  });

  assert.equal(failed.confirmJobId, job.job_id);
  assert.equal(failed.deletingJobId, null);
  assert.equal(failed.message, null);
  assert.equal(failed.error, "Temporary backend failure");
});

test("isolated mocked delete prevents same-tick double clicks from issuing two requests", async () => {
  const gate = createIngestDeleteGate();
  let calls = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const removeCards = async () => {
    calls += 1;
    return pending;
  };
  let starts = 0;

  const first = executeIngestCardDeletion(terminalJob(), removeCards, gate, () => { starts += 1; });
  const second = await executeIngestCardDeletion(terminalJob(), removeCards, gate, () => { starts += 1; });

  assert.deepEqual(second, { status: "blocked", reason: "busy" });
  assert.equal(calls, 1);
  assert.equal(starts, 1);
  assert.equal(canChangeIngestSelection(gate), false);

  finish(deleteResponse());
  const firstResult = await first;
  assert.equal(firstResult.status, "success");
  assert.equal(canChangeIngestSelection(gate), true);
});

test("running jobs are blocked before the mocked delete transport is called", async () => {
  let calls = 0;
  const running = terminalJob(52, { status: "processing" });
  const result = await executeIngestCardDeletion(
    running,
    async () => { calls += 1; return deleteResponse(); },
    createIngestDeleteGate(),
  );

  assert.equal(canDeleteIngestCards(running), false);
  assert.deepEqual(result, { status: "blocked", reason: "unavailable" });
  assert.equal(calls, 0);
  assert.deepEqual(
    ingestDeleteUiReducer(INITIAL_INGEST_DELETE_UI, { type: "confirm", job: running }),
    INITIAL_INGEST_DELETE_UI,
  );
});

test("switching jobs and reset are blocked while deletion is in flight", () => {
  const job = terminalJob();
  const confirming = ingestDeleteUiReducer(INITIAL_INGEST_DELETE_UI, { type: "confirm", job });
  const deleting = ingestDeleteUiReducer(confirming, { type: "started", jobId: job.job_id });

  assert.deepEqual(ingestDeleteUiReducer(deleting, { type: "selectionChanged" }), deleting);
  assert.deepEqual(ingestDeleteUiReducer(deleting, { type: "reset" }), deleting);
});

test("recent terminal jobs remain listed and an older one can be reopened for deletion", () => {
  const jobs = mergeRecentIngests([], [
    terminalJob(103, { status: "processing", active_phrase_count: 2 }),
    terminalJob(102, { source_url: "https://youtu.be/older", active_phrase_count: 2 }),
    terminalJob(101, { status: "failed", active_phrase_count: 0 }),
  ]);

  assert.deepEqual(recentTerminalIngests(jobs).map((job) => job.job_id), [102, 101]);
  const reopened = reopenRecentTerminalJob(jobs, 102, createIngestDeleteGate());
  assert.equal(reopened?.source_url, "https://youtu.be/older");
  assert.equal(canDeleteIngestCards(reopened), true);
  assert.equal(reopenRecentTerminalJob(jobs, 103, createIngestDeleteGate()), null);

  const gate = createIngestDeleteGate();
  assert.equal(gate.tryAcquire(102), true);
  assert.equal(reopenRecentTerminalJob(jobs, 101, gate), null, "history switching is blocked during deletion");
});

test("isolated mocked API client uses the exact DELETE contract without production traffic", async () => {
  const compiled = await build({
    entryPoints: [new URL("../src/lib/api.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    define: { "import.meta.env": "{}" },
  });
  const { api } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(deleteResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await api.removeIngestCards(41);
    assert.equal(result.active_phrase_count, 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/ingest\/41\/cards$/);
    assert.equal(calls[0].options.method, "DELETE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown or missing ownership never authorizes deletion", async () => {
  for (const ownership_unknown of [true, undefined, null]) {
    let calls = 0;
    const result = await executeIngestCardDeletion(terminalJob(41, {ownership_unknown}), async () => { calls += 1; }, createIngestDeleteGate());
    assert.equal(result.status, "blocked");
    assert.equal(calls, 0);
  }
});

test("unverified delete receipts are refused rather than presented as success", async () => {
  for (const extra of [{ownership_unknown:true}, {active_phrase_count:null}, {removed_count:-1}]) {
    const result = await executeIngestCardDeletion(terminalJob(), async () => deleteResponse(extra), createIngestDeleteGate());
    assert.equal(result.status, "refused");
    assert.match(result.message, /not|could not/i);
  }
});

test("the UI does not claim preserved history when the receipt does not confirm it", () => {
  const confirming = ingestDeleteUiReducer(INITIAL_INGEST_DELETE_UI, {type:"confirm", job:terminalJob()});
  const deleting = ingestDeleteUiReducer(confirming, {type:"started",jobId:41});
  const state = ingestDeleteUiReducer(deleting, {type:"succeeded",jobId:41,removedCount:3,historyPreserved:false});
  assert.match(state.message, /did not confirm/);
});

test("IngestForm wires recent history, scoped confirmation, navigation locks, and accessible errors", () => {
  const source = readFileSync(new URL("../src/components/IngestForm.tsx", import.meta.url), "utf8");
  assert.match(source, /api\.getRecentIngests/);
  assert.match(source, /Recent ingestion jobs/);
  assert.match(source, /recentVisibleJobs\.map/);
  assert.match(source, /executeIngestCardDeletion/);
  assert.match(source, /role="alert"/);
  assert.match(source, /Delete available when ingestion finishes/);
});
