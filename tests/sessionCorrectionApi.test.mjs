import { strict as assert } from "node:assert";
import { test } from "node:test";
import { build } from "esbuild";
import { saveCompletedSession, loadSession, clearSession } from "../src/lib/timer.ts";

const compiled = await build({ entryPoints: [new URL("../src/lib/api.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm", define: { "import.meta.env": "{}" } });
const { api } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const fixture = (ids, extra = {}) => ({ session_id: 6, mode: "practice", affects_fsrs: false, items: ids.map((phrase_id) => ({ phrase_id, result: "pending" })), ...extra });

test("both real API client methods keep explicit scopes and reject mixed response IDs", async () => {
  const originalFetch = globalThis.fetch;
  let calls = [];
  let response = fixture([9, 17]);
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    for (const written of [false, true]) {
      const create = (ids) => written ? api.createWrittenSession("practice", 2, "ser", ids) : api.createSession("practice", 2, ids);
      const count = calls.length;
      await assert.rejects(create([]), /batch/i);
      await assert.rejects(create([9, 0]), /batch/i);
      assert.equal(calls.length, count, "invalid scope must not issue any queue request");
      response = fixture([9, 17]);
      await create([9, 17]);
      assert.deepEqual(calls.at(-1).body.phrase_ids, [9, 17]);
      assert.equal(calls.at(-1).body.size, 2);
      if (written) assert.equal(calls.at(-1).body.response_mode, "written");
      response = fixture([999, 17]);
      await assert.rejects(create([9, 17]), /batch/i);
      response = fixture([9, 17], { affects_fsrs: true });
      await assert.rejects(create([9, 17]), /batch/i);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("summary persistence retains exact correction IDs and clears stale recording timers", () => {
  const originalStorage = globalThis.localStorage;
  const data = new Map();
  globalThis.localStorage = { setItem: (key, value) => data.set(key, value), getItem: (key) => data.get(key) ?? null, removeItem: (key) => data.delete(key) };
  try {
    const session = fixture([9, 17], { status: "complete" });
    saveCompletedSession(session);
    const saved = loadSession();
    assert.equal(saved.phase, "summary");
    assert.equal(saved.mode, "practice");
    assert.deepEqual(saved.graded.items.map((item) => item.phrase_id), [9, 17]);
    assert.equal(saved.deadline, null);
    assert.equal(saved.jobId, null);
    clearSession();
    assert.equal(loadSession(), null);
  } finally { if (originalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originalStorage; }
});
