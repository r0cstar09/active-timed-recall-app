import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";
import {
  canonicalYouTubeVideoId,
  createActionGate,
  createDraftEditorState,
  mergeImportSnapshot,
  reconcileDraftEditor,
  selectedSegmentText,
  toggleContiguousSegment,
} from "../src/lib/curationState.ts";

const segment = (index, text, start = index * 2) => ({ index, text, start, end: start + 1.8 });
const draft = (extra = {}) => ({
  id: 7,
  import_id: 2,
  segment_indices: [0],
  spanish: "Buenos días",
  english: "Good morning",
  start_time: 0,
  end_time: 1.8,
  revision: 1,
  status: "draft",
  approved: false,
  warning: null,
  error_message: null,
  audio_url: null,
  repair_phrase_id: null,
  phrase_id: null,
  existing_phrase_id: null,
  existing_active: null,
  manual_timing: false,
  created_at: "2026-09-08T12:00:00Z",
  updated_at: "2026-09-08T12:00:00Z",
  ...extra,
});
const curationImport = (extra = {}) => ({
  id: 2,
  source_id: 9,
  source_url: "https://www.youtube.com/watch?v=abcdefghijk",
  video_id: "abcdefghijk",
  title: "Conversation",
  status: "ready",
  error_message: null,
  transcript: [segment(0, "Buenos días"), segment(1, "¿Cómo estás?")],
  drafts: [draft()],
  source_audio_url: "/api/audio/source/original.m4a",
  created_at: "2026-09-08T12:00:00Z",
  updated_at: "2026-09-08T12:00:00Z",
  ...extra,
});

test("YouTube validation accepts only supported URLs with canonical 11-character IDs", () => {
  assert.equal(canonicalYouTubeVideoId("https://youtu.be/abcdefghijk?t=3"), "abcdefghijk");
  assert.equal(canonicalYouTubeVideoId("https://www.youtube.com/watch?v=A_b-CdEf123"), "A_b-CdEf123");
  assert.equal(canonicalYouTubeVideoId("https://youtube.com/shorts/abcdefghijk"), "abcdefghijk");
  assert.equal(canonicalYouTubeVideoId("https://example.com/watch?v=abcdefghijk"), null);
  assert.equal(canonicalYouTubeVideoId("ftp://youtube.com/watch?v=abcdefghijk"), null);
  assert.equal(canonicalYouTubeVideoId("https://user:password@youtube.com/watch?v=abcdefghijk"), null);
  assert.equal(canonicalYouTubeVideoId("https://youtu.be/too-short"), null);
});

test("transcript selection combines only adjacent lines and never implies draft deletion", () => {
  assert.deepEqual(toggleContiguousSegment([], 4), { indices: [4], error: null });
  assert.deepEqual(toggleContiguousSegment([4], 5), { indices: [4, 5], error: null });
  assert.deepEqual(toggleContiguousSegment([4, 5], 4), { indices: [5], error: null });
  const blocked = toggleContiguousSegment([4, 5], 7);
  assert.deepEqual(blocked.indices, [4, 5]);
  assert.match(blocked.error, /adjacent/i);
  assert.equal(selectedSegmentText([segment(4, "uno"), segment(5, "dos")], [4, 5]), "uno dos");
});

test("poll snapshots cannot roll a draft back to an older revision", () => {
  const current = curationImport({ drafts: [draft({ revision: 3, english: "Current", updated_at: "2026-09-08T12:03:00Z" })] });
  const stale = curationImport({ drafts: [draft({ revision: 2, english: "Stale", updated_at: "2026-09-08T12:02:00Z" })] });
  assert.equal(mergeImportSnapshot(current, stale).drafts[0].english, "Current");
});

test("poll updates preserve unsaved editor fields and their conflict revision", () => {
  const initial = createDraftEditorState(draft());
  const dirty = {
    ...initial,
    english: "My unsaved translation",
    dirtyFields: ["english"],
  };
  const next = reconcileDraftEditor(dirty, draft({ revision: 2, english: "Server edit", status: "ready", audio_url: "/clip.mp3" }));
  assert.equal(next.english, "My unsaved translation");
  assert.equal(next.baseRevision, 1, "a dirty editor must retain its optimistic concurrency revision");
  assert.equal(next.server.status, "ready", "non-editor server progress still refreshes");
});

test("synchronous action gate blocks same-tick duplicate requests", () => {
  const gate = createActionGate();
  assert.equal(gate.tryAcquire("prepare:7"), true);
  assert.equal(gate.tryAcquire("prepare:7"), false);
  assert.equal(gate.tryAcquire("prepare:8"), true);
  gate.release("prepare:7");
  assert.equal(gate.tryAcquire("prepare:7"), true);
});

test("curation API uses the exact shared HTTP contract and hydrates relative audio", async () => {
  const compiled = await build({
    entryPoints: [new URL("../src/lib/curationApi.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    define: { "import.meta.env": "{}" },
  });
  const { curationApi } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const path = String(url);
    let body = { ok: true };
    if (path.endsWith("/api/curation/imports")) body = curationImport();
    else if (path.includes("/api/curation/imports?") ) body = { imports: [curationImport()], total: 1 };
    else if (/\/api\/curation\/imports\/2$/.test(path)) body = curationImport();
    else if (path.endsWith("/drafts")) body = { drafts: [draft()] };
    else if (path.endsWith("/api/curation/drafts/7")) body = draft();
    else if (path.endsWith("/api/curation/prepare")) body = { drafts: [draft({ status: "queued" })] };
    else if (path.endsWith("/api/curation/promote")) body = { results: [], drafts: [draft({ status: "added" })] };
    else if (path.endsWith("/api/cards/44/repair")) body = draft({ repair_phrase_id: 44 });
    else if (path.includes("/api/cards?active=")) body = { cards: [{ phrase_id: 44, spanish: "Hola", english: "Hello", audio_url: "/api/audio/44.mp3" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    await curationApi.createImport("https://youtu.be/abcdefghijk");
    await curationApi.listImports(50, 0);
    const loaded = await curationApi.getImport(2);
    await curationApi.createDrafts(2, [{ segment_indices: [0, 1], spanish: "Buenos días" }]);
    await curationApi.patchDraft(7, { revision: 1, english: "Good morning" });
    await curationApi.deleteDraft(7, 2);
    await curationApi.prepareDrafts([{ id: 7, revision: 2 }]);
    await curationApi.promoteDrafts([{ id: 7, revision: 2 }]);
    await curationApi.createRepairDraft(44);
    await curationApi.listCards(false);
    await curationApi.reactivateCard(44);

    assert.equal(loaded.source_audio_url, "/api/audio/source/original.m4a");
    const summary = calls.map(({ url, options }) => `${options.method ?? "GET"} ${new URL(url, "https://local.test").pathname}${new URL(url, "https://local.test").search}`);
    assert.deepEqual(summary, [
      "POST /api/curation/imports",
      "GET /api/curation/imports?limit=50&offset=0",
      "GET /api/curation/imports/2",
      "POST /api/curation/imports/2/drafts",
      "PATCH /api/curation/drafts/7",
      "DELETE /api/curation/drafts/7?revision=2",
      "POST /api/curation/prepare",
      "POST /api/curation/promote",
      "POST /api/cards/44/repair",
      "GET /api/cards?active=0&limit=100&offset=0",
      "POST /api/cards/44/reactivate",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ingest UI makes manual curation primary while retaining legacy history and custom verbs", () => {
  const source = ["IngestForm", "ManualCuration"].map((name) => readFileSync(new URL(`../src/components/${name}.tsx`, import.meta.url), "utf8")).join("\n");
  assert.match(source, /curationApi\.createImport/);
  assert.doesNotMatch(source, /api\.createIngest/);
  assert.match(source, /Save selection as draft/);
  assert.match(source, /Add approved/);
  assert.match(source, /api\.getRecentIngests/);
  assert.match(source, /executeIngestCardDeletion/);
  assert.match(source, /api\.addVerb/);
  assert.match(source, /Legacy auto-ingest history/);
  assert.match(source, /\?import=/);
});

test("library exposes active/archive, Restore, Repair, and phrase deep-link handling", () => {
  const source = readFileSync(new URL("../src/components/Library.tsx", import.meta.url), "utf8");
  assert.match(source, /curationApi\.listCards\(true\)/);
  assert.match(source, /curationApi\.listCards\(false\)/);
  assert.match(source, /curationApi\.reactivateCard/);
  assert.match(source, /curationApi\.createRepairDraft/);
  assert.match(source, /Restore/);
  assert.match(source, /Repair clip/);
  assert.match(source, /params\.get\("phrase"\)/);
  assert.match(source, /params\.get\("q"\)/);
});
