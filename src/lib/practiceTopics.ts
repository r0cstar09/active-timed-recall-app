import type {
  PracticeTopic,
  PracticeTopicCardsResponse,
  PracticeTopicKind,
  PracticeTopicsResponse,
} from "./types";

const TOPIC_KINDS = new Set<PracticeTopicKind>(["grammar", "verb", "lesson", "source"]);

function nonNegativeCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`The practice topic response has an invalid ${field}.`);
  }
  return Number(value);
}

export function normalizePracticeTopicsResponse(value: unknown): PracticeTopicsResponse {
  if (!value || typeof value !== "object") {
    throw new Error("The practice topic catalog response is invalid.");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.topics)) {
    throw new Error("The practice topic catalog did not include topics.");
  }
  const topics = raw.topics.map((entry, index): PracticeTopic => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Practice topic ${index + 1} is invalid.`);
    }
    const topic = entry as Record<string, unknown>;
    if (typeof topic.id !== "string" || !topic.id.trim() ||
        typeof topic.label !== "string" || !topic.label.trim() ||
        typeof topic.description !== "string" ||
        typeof topic.kind !== "string" || !TOPIC_KINDS.has(topic.kind as PracticeTopicKind) ||
        !Array.isArray(topic.examples) || topic.examples.some((example) => typeof example !== "string")) {
      throw new Error(`Practice topic ${index + 1} has an invalid shape.`);
    }
    return {
      id: topic.id,
      label: topic.label,
      kind: topic.kind as PracticeTopicKind,
      description: topic.description,
      learned_count: nonNegativeCount(topic.learned_count, "learned count"),
      available_count: nonNegativeCount(topic.available_count, "available count"),
      examples: topic.examples as string[],
    };
  });
  if (new Set(topics.map((topic) => topic.id)).size !== topics.length) {
    throw new Error("The practice topic catalog contains duplicate topic IDs.");
  }
  return {
    topics,
    learned_count: nonNegativeCount(raw.learned_count, "learned count"),
    available_count: nonNegativeCount(raw.available_count, "available count"),
  };
}

export function normalizePracticeTopicCardsResponse(value: unknown): PracticeTopicCardsResponse {
  if (!value || typeof value !== "object") {
    throw new Error("The practice topic card response is invalid.");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.topic_id !== "string" || !raw.topic_id.trim() || !Array.isArray(raw.phrase_ids)) {
    throw new Error("The practice topic card response has an invalid shape.");
  }
  return {
    topic_id: raw.topic_id,
    phrase_ids: [...raw.phrase_ids] as number[],
    learned_count: nonNegativeCount(raw.learned_count, "learned count"),
    available_count: nonNegativeCount(raw.available_count, "available count"),
  };
}

export function filterPracticeTopics(topics: PracticeTopic[], query: string): PracticeTopic[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return topics;
  return topics.filter((topic) => [topic.label, topic.description, ...topic.examples]
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle));
}

/**
 * Validate the exact card scope before session creation. Empty or malformed
 * topic results throw so callers can never reinterpret them as a mix-all
 * request (where omitting phrase_ids has intentionally different semantics).
 */
export function requirePracticeTopicPhraseIds(
  selection: PracticeTopicCardsResponse,
  expectedTopicId: string,
): number[] {
  if (selection.topic_id !== expectedTopicId) {
    throw new Error("The topic card response did not match the selected topic. Nothing was started.");
  }
  const ids = selection.phrase_ids;
  if (!ids.length) {
    throw new Error("No learned cards are available for this topic yet. Choose another topic or Mix all.");
  }
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new Error("The selected topic returned an invalid card list. Nothing was started.");
  }
  return [...ids];
}