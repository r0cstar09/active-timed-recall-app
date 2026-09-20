import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import {
  filterPracticeTopics,
  requirePracticeTopicPhraseIds,
} from "../src/lib/practiceTopics.ts";

const compiled = await build({
  entryPoints: [new URL("../src/lib/api.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  define: { "import.meta.env": "{}" },
});
const { api } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64")
);

const topic = {
  id: "grammar:give/to-you? tense",
  label: "Giving things to people",
  kind: "grammar",
  description: "Choose who gave what, when.",
  learned_count: 8,
  available_count: 6,
  examples: ["She gave it to you.", "I will give it to you."],
};

test("topic search covers English label, description, and examples", () => {
  const topics = [topic, { ...topic, id: "verb:ser", label: "Ser", description: "Identity", examples: ["I am ready."] }];
  assert.deepEqual(filterPracticeTopics(topics, "gave it"), [topic]);
  assert.deepEqual(filterPracticeTopics(topics, "who gave"), [topic]);
  assert.deepEqual(filterPracticeTopics(topics, "things to people"), [topic]);
  assert.deepEqual(filterPracticeTopics(topics, "  IDENTITY  ").map((item) => item.id), ["verb:ser"]);
});

test("topic card IDs fail closed for mismatches, empties, duplicates, and invalid IDs", () => {
  assert.deepEqual(
    requirePracticeTopicPhraseIds({ topic_id: topic.id, phrase_ids: [42, 9], learned_count: 8, available_count: 6 }, topic.id),
    [42, 9],
  );
  for (const response of [
    { topic_id: "verb:ser", phrase_ids: [42], learned_count: 1, available_count: 1 },
    { topic_id: topic.id, phrase_ids: [], learned_count: 8, available_count: 0 },
    { topic_id: topic.id, phrase_ids: [42, 42], learned_count: 8, available_count: 2 },
    { topic_id: topic.id, phrase_ids: [42, 0], learned_count: 8, available_count: 2 },
  ]) {
    assert.throws(() => requirePracticeTopicPhraseIds(response, topic.id), /topic|card|available/i);
  }
});

test("topic APIs encode the exact topic query and never issue a session request themselves", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const href = String(input);
    calls.push({ href, method: options.method || "GET" });
    if (href.includes("/api/practice/topics")) {
      return new Response(JSON.stringify({ topics: [topic], learned_count: 8, available_count: 6 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (href.includes("/api/practice/topic-cards")) {
      return new Response(JSON.stringify({ topic_id: topic.id, phrase_ids: [42, 9], learned_count: 8, available_count: 6 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${href}`);
  };
  try {
    const catalog = await api.getPracticeTopics();
    assert.deepEqual(catalog.topics, [topic]);
    const selection = await api.getPracticeTopicCards(topic.id, 10);
    assert.deepEqual(requirePracticeTopicPhraseIds(selection, topic.id), [42, 9]);
    const parsed = new URL(calls[1].href, "http://fixture.local");
    assert.equal(parsed.pathname, "/api/practice/topic-cards");
    assert.equal(parsed.searchParams.get("topic_id"), topic.id);
    assert.equal(parsed.searchParams.get("limit"), "10");
    assert.equal(calls.some((call) => call.href.includes("/api/sessions")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an empty topic selection cannot fall through to mix-all session creation", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const href = String(input);
    calls.push({ href, method: options.method || "GET" });
    if (href.includes("/api/practice/topic-cards")) {
      return new Response(JSON.stringify({ topic_id: topic.id, phrase_ids: [], learned_count: 8, available_count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${href}`);
  };
  try {
    const selection = await api.getPracticeTopicCards(topic.id, 10);
    assert.throws(() => requirePracticeTopicPhraseIds(selection, topic.id), /available/i);
    assert.equal(calls.some((call) => call.href.includes("/api/sessions")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
