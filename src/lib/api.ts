/**
 * Centralized, typed API client for the FastAPI learning engine.
 *
 * Access is gated by Tailscale at the network layer — there is NO public auth,
 * so no auth headers are ever sent. In production the API base URL is the EMPTY
 * STRING (same origin): the frontend and FastAPI are served from the same
 * Tailscale host, so all calls and `/api/audio/...` media URLs are same-origin.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SESSION / GRADING FLOW (real backend contract)
 * ─────────────────────────────────────────────────────────────────────────
 *   1. POST   /api/sessions                                   -> Session
 *   2. (show items one at a time, record spoken answer)
 *   3. POST   /api/sessions/:sid/items/:itemId/recording      (multipart)
 *   4. (repeat for every item)
 *   5. POST   /api/sessions/:sid/grade                        -> { job_id }
 *   6. GET    /api/jobs/:jobId                                -> Job (poll)
 *   7. GET    /api/sessions/:sid       (when job complete)    -> graded Session
 *
 * Grading is done ASYNC by the backend (transcription + scoring + FSRS). The
 * client never self-grades.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIBRARY / STATS / HEALTH (real contract)
 * ─────────────────────────────────────────────────────────────────────────
 *   GET    /health                                            -> 200
 *   GET    /api/stats                                         -> 200 (opaque)
 *   GET    /api/sources                                       -> Source[]
 *   GET    /api/cards                                         -> Card[]
 *
 * INGESTION (real contract)
 *   POST   /api/ingest              { url }                 -> IngestJob
 *   GET    /api/ingest/:jobId                               -> IngestJob
 */

import {
  getApiBaseUrl,
  getBaseCandidates,
  getCachedActiveBase,
  resolveUrl,
  setActiveBase,
} from "./config";
import type {
  Card,
  GradeResponse,
  Job,
  RecordingMeta,
  RecordingResponse,
  RetryItemResponse,
  Session,
  SessionItem,
  SessionMode,
  IngestJob,
  Source,
  Phrase,
} from "./types";
import { isJobComplete, isJobFailed } from "./types";

export class ApiError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function url(path: string): string {
  const base = getApiBaseUrl();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

/**
 * One-time (per page session) selection of a healthy base. Candidates are
 * probed in priority order (tailnet -> Alienware tunnel -> VPS/GCP LB); the
 * winner is cached for a few minutes so later page loads skip the probes.
 * When the tailnet primary is healthy this adds a single cheap /health call
 * and changes nothing else.
 */
let baseSelection: Promise<void> | null = null;

async function probeBase(base: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function ensureBaseSelected(): Promise<void> {
  if (!baseSelection) {
    baseSelection = (async () => {
      const candidates = getBaseCandidates();
      if (candidates.length < 2) return; // override/env/same-origin: fixed base
      const cached = getCachedActiveBase();
      if (cached) {
        setActiveBase(cached);
        return;
      }
      for (const base of candidates) {
        if (await probeBase(base)) {
          setActiveBase(base);
          return;
        }
      }
      // Nothing healthy: stay on the preferred base and let requests surface errors.
    })();
  }
  return baseSelection;
}

function extractFirstJsonValue(text: string): unknown {
  const src = text.trim();
  if (!src) return undefined;
  try {
    return JSON.parse(src);
  } catch {
    /* fall through to one-shot extraction */
  }

  const starts = [src.indexOf("{"), src.indexOf("[")].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const opener = src[start];
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < src.length; i += 1) {
      const ch = src[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === opener) depth += 1;
      else if (ch === closer) {
        depth -= 1;
        if (depth === 0) {
          const candidate = src.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new SyntaxError("Response did not contain a valid JSON object or array.");
}

async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return extractFirstJsonValue(text);
  } catch (err) {
    const preview = text.trim().slice(0, 280) || res.statusText;
    throw new ApiError(
      `Backend returned malformed JSON (${res.status}). ${err instanceof Error ? err.message : String(err)} Preview: ${preview}`,
      res.status,
      { preview },
    );
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  await ensureBaseSelected();
  let res: Response;
  try {
    res = await fetch(url(path), {
      ...init,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    // Mid-session failover: if the active base drops after selection, walk the
    // remaining candidates in priority order and retry this request once each.
    const candidates = getBaseCandidates();
    const current = getApiBaseUrl();
    const at = candidates.indexOf(current);
    const rest = candidates.length > 1 && at >= 0 ? candidates.slice(at + 1) : [];
    let recovered: Response | null = null;
    for (const base of rest) {
      const p = path.startsWith("/") ? path : `/${path}`;
      try {
        recovered = await fetch(`${base}${p}`, {
          ...init,
          headers: { Accept: "application/json", ...(init?.headers ?? {}) },
        });
        setActiveBase(base);
        break;
      } catch {
        /* try the next candidate */
      }
    }
    if (!recovered) {
      throw new ApiError(
        `Network error reaching backend${rest.length ? " and fallbacks" : ""}. Check Tailscale connectivity and the API base URL in Settings. (${
          err instanceof Error ? err.message : String(err)
        })`,
        0,
      );
    }
    res = recovered;
  }

  if (!res.ok) {
    let body: unknown;
    let detail = res.statusText;
    try {
      body = await readJsonBody(res);
      if (body && typeof body === "object" && "detail" in body) {
        detail = String((body as Record<string, unknown>).detail);
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(`Request failed (${res.status}): ${detail}`, res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return (await readJsonBody(res)) as T;
}

async function requestJson<T>(path: string, method: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Resolve an item's source audio URL against the API base. In production the
 * base is "" so `/api/audio/source/...` stays same-origin and untouched.
 */
function hydrateItem(item: SessionItem): SessionItem {
  return {
    ...item,
    source_audio_url: resolveUrl(item.source_audio_url),
    recording_audio_url: item.recording_audio_url ? resolveUrl(item.recording_audio_url) : item.recording_audio_url,
  };
}
function hydrateSession(s: Session): Session {
  return { ...s, items: (s.items ?? []).map(hydrateItem) };
}

/**
 * Some list endpoints return a bare JSON array, others wrap it in an object
 * like `{ cards: [...] }` / `{ items: [...] }` / `{ data: [...] }`. Normalize
 * both shapes into an array so the UI never crashes on `.map`.
 */
function toArray<T>(res: unknown, keys: string[]): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object") {
    for (const k of keys) {
      const v = (res as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
    for (const v of Object.values(res as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

export type StudyGradeItem = {
  client_id?: string;
  prompt?: string;
  expected_answer?: string;
  user_answer: string;
  verb?: string;
  pronoun?: string;
  tense?: string;
  pattern_ids?: string[];
  verb_ids?: string[];
  slots?: Record<string, unknown>;
  usage_focus?: string;
  target_vocabulary?: string[];
};

export type StudyGradeRequest = {
  exercise_type: "verb_conjugation" | "verb_usage" | "sentence_lesson";
  source?: string;
  lesson_id?: string;
  section?: string;
  lesson_context?: Record<string, unknown>;
  module_total_prompts?: number;
  total_assignments?: number;
  verb_category?: string;
  items: StudyGradeItem[];
};

export type StudyGradeResultItem = {
  attempt_id: number;
  client_id?: string | null;
  result: "pass" | "partial" | "fail";
  score: number;
  corrected_answer: string;
  accepted_variants: string[];
  error_type: string;
  feedback: string;
  should_review: boolean;
  should_promote_to_recall: boolean;
  lesson_miss_id?: number;
};

export type StudyProgress = {
  lesson_id?: string;
  verb?: string;
  category?: string;
  total_prompts?: number;
  passed_prompts?: number;
  full_pass_count?: number;
  required_full_passes?: number;
  completed?: boolean | number;
};

export type PatternCatalogEntry = {
  id: string;
  pattern_id?: string;
  name: string;
  frame: string;
  description?: string | null;
  level: string;
  target_dialect: string;
  examples: string[];
  unlock_threshold?: Record<string, unknown>;
  status: "locked" | "unlocked" | "drilling" | "recall_active" | "stable" | "mastered" | string;
  unlocked_at?: string | null;
  source_lesson_id?: string | null;
  mastery_score: number;
};

export type PatternDrill = {
  id: number;
  pack_id: number;
  pattern_id: string;
  verb_id?: string | null;
  prompt_en: string;
  expected_es: string;
  acceptable_answers: string[];
  slots: Record<string, unknown>;
  grading_notes?: string | null;
  difficulty: string;
  sealed?: boolean;
  audio_path?: string | null;
  audio_url?: string | null;
  audio_status?: "pending" | "ready" | "failed" | string;
  audio_error?: string | null;
};

export type PatternPack = {
  id: number;
  pattern_id: string;
  source_lesson_id?: string | null;
  status: string;
  drills: PatternDrill[];
};

export type PatternMiss = {
  id: number;
  pattern_id: string;
  verb_id?: string | null;
  drill_id?: number | null;
  prompt_en?: string | null;
  expected_es?: string | null;
  user_answer?: string | null;
  feedback?: string | null;
  error_tags?: string[];
  status: string;
  miss_count: number;
};

export type PatternGradeResultItem = {
  drill_id: number;
  result: "pass" | "partial" | "fail";
  score: number;
  corrected_answer: string;
  feedback: string;
  error_tags: string[];
  pattern_correct: boolean;
  verb_correct: boolean;
  object_correct: boolean;
  word_order_correct: boolean;
};

export type StudyGradeResponse = {
  exercise_type: string;
  model: string;
  items: StudyGradeResultItem[];
  saved_attempt_count?: number;
  attempt_ids?: number[];
  progress?: StudyProgress | null;
  pattern_unlocks?: PatternCatalogEntry[];
  summary: string;
  next_drill_recommendation: string;
};

export type VerbMiss = {
  id: number;
  verb: string;
  pronoun: string;
  tense: string;
  prompt: string | null;
  user_answer: string | null;
  correct_answer: string | null;
  feedback: string | null;
  error_type: string | null;
  status: string;
  miss_count: number;
  last_seen_at: string | null;
  next_due_at: string | null;
};

export type LessonMiss = {
  id: number;
  lesson_id: string;
  section: string | null;
  prompt: string;
  expected_answer: string | null;
  user_answer: string | null;
  corrected_answer: string | null;
  feedback: string | null;
  error_type: string | null;
  target_pattern: string | null;
  should_promote_to_recall: number;
  promoted_phrase_id?: number | null;
  status: string;
  miss_count: number;
  last_seen_at: string | null;
  next_due_at: string | null;
};

export type LessonProgress = {
  lesson_id: string;
  title?: string | null;
  total_prompts: number;
  passed_prompts: number;
  completed: number;
  completed_at?: string | null;
};

export type LessonPromptProgress = {
  lesson_id: string;
  section: string;
  prompt: string;
  expected_answer?: string | null;
  status: "open" | "pass" | string;
  last_result?: string | null;
  last_attempt_id?: number | null;
  updated_at?: string | null;
};

export type VerbPromptProgress = {
  verb: string;
  pronoun: string;
  tense: string;
  prompt?: string | null;
  status: "open" | "pass" | string;
  last_result?: string | null;
  last_attempt_id?: number | null;
  updated_at?: string | null;
};

export type VerbProgress = {
  verb: string;
  category?: string | null;
  total_assignments: number;
  full_pass_count: number;
  required_full_passes: number;
  completed: number;
  completed_at?: string | null;
};

export type VerbCatalogAssignment = {
  pronoun: string;
  tense: string;
  translation: string;
};

export type VerbCatalogEntry = {
  verb: string;
  englishBase: string;
  category: string;
  inDailyRotation: boolean;
  usageHint: string;
  assignments: VerbCatalogAssignment[];
};

export type VerbCatalog = {
  sourceRepo: string;
  count: number;
  rotationCount: number;
  tenses: string[];
  pronouns: string[];
  verbs: VerbCatalogEntry[];
};

export type CreateVerbRequest = {
  verb: string;
  english_base: string;
  category?: string;
  usage_hint?: string;
  add_to_daily_rotation?: boolean;
};

export type VerbUsagePrompt = {
  id: string;
  verb: string;
  batch: number;
  batch_size: number;
  tense: string;
  mood: string;
  difficulty: string;
  construction: string;
  prompt_en: string;
  expected_es?: string;
  acceptable_answer_pattern?: string | null;
  target_vocabulary?: string[];
  grading_notes?: string;
  correction_hint?: string;
};

export type VerbUsageBankBatch = {
  verb: string;
  batch: number;
  batch_size: number;
  total_batches: number;
  total_prompts: number;
  status?: string;
  prompts: VerbUsagePrompt[];
};

export const api = {
  // ── Sessions / grading (real contract) ───────────────────────────────────
  async createSession(mode: SessionMode = "review", size = 10): Promise<Session> {
    return hydrateSession(await requestJson<Session>("/api/sessions", "POST", { mode, size }));
  },

  introducePhrase(phraseId: number | string): Promise<{ id: number; introduced_at: string; learning_status: string }> {
    return requestJson<{ id: number; introduced_at: string; learning_status: string }>(
      `/api/cards/${encodeURIComponent(String(phraseId))}/introduce`,
      "POST",
      {},
    );
  },

  async getSession(sessionId: number | string): Promise<Session> {
    return hydrateSession(
      await request<Session>(`/api/sessions/${encodeURIComponent(String(sessionId))}`),
    );
  },

  uploadRecording(
    sessionId: number | string,
    sprintItemId: number | string,
    audio: Blob,
    meta: RecordingMeta,
  ): Promise<RecordingResponse> {
    const form = new FormData();
    form.append("audio", audio, meta.filename);
    form.append("mime_type", meta.mimeType);
    form.append("prompt_shown_at", meta.promptShownAt);
    form.append("answered_at", meta.answeredAt);
    form.append("response_seconds", String(meta.responseSeconds));
    form.append("timed_out", String(meta.timedOut));
    form.append("noisy_mode", String(Boolean(meta.noisyMode)));
    return request<RecordingResponse>(
      `/api/sessions/${encodeURIComponent(String(sessionId))}/items/${encodeURIComponent(
        String(sprintItemId),
      )}/recording`,
      { method: "POST", body: form },
    );
  },

  gradeSession(sessionId: number | string): Promise<GradeResponse> {
    return requestJson<GradeResponse>(
      `/api/sessions/${encodeURIComponent(String(sessionId))}/grade`,
      "POST",
      {},
    );
  },

  /** Stage an inline re-record attempt for a transcription_unclear item. */
  retryItem(sessionId: number | string, itemId: number | string): Promise<RetryItemResponse> {
    return requestJson<RetryItemResponse>(
      `/api/sessions/${encodeURIComponent(String(sessionId))}/items/${encodeURIComponent(String(itemId))}/retry`,
      "POST",
      {},
    );
  },

  /** Queue grading for one (retry) item; idempotent server-side. */
  gradeItem(sessionId: number | string, itemId: number | string): Promise<GradeResponse> {
    return requestJson<GradeResponse>(
      `/api/sessions/${encodeURIComponent(String(sessionId))}/items/${encodeURIComponent(String(itemId))}/grade`,
      "POST",
      {},
    );
  },

  getJob(jobId: number | string): Promise<Job> {
    return request<Job>(`/api/jobs/${encodeURIComponent(String(jobId))}`);
  },

  // ── Health / stats (real) ────────────────────────────────────────────────
  health(): Promise<unknown> {
    return request<unknown>("/health");
  },
  getStats(): Promise<unknown> {
    return request<unknown>("/api/stats");
  },

  /**
   * Server-side aggregated dashboard counts. Prefer this over deriving counts
   * from listCards(), which is capped at 100 rows and silently undercounts once
   * the deck grows past that.
   */
  async getDashboardCounts(): Promise<{
    due_count: number;
    new_count: number;
    review_count: number;
    learning_count: number;
    suspended_count: number;
  }> {
    const res = (await request<Record<string, unknown>>("/api/stats")) ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      due_count: num(res.due_count),
      new_count: num(res.new_count),
      review_count: num(res.review_count),
      learning_count: num(res.learning_count),
      suspended_count: num(res.suspended_count),
    };
  },

  /** Total source count (reads the `total` field the list endpoint returns). */
  async countSources(): Promise<number> {
    const res = await request<unknown>("/api/sources");
    if (res && typeof res === "object" && typeof (res as Record<string, unknown>).total === "number") {
      return (res as Record<string, number>).total;
    }
    return toArray<Source>(res, ["sources", "items", "data", "results"]).length;
  },

  // ── Library (real) ───────────────────────────────────────────────────────
  async listSources(): Promise<Source[]> {
    const res = await request<unknown>("/api/sources");
    return toArray<Source>(res, ["sources", "items", "data", "results"]);
  },
  async listSourcePhrases(sourceId: number | string): Promise<Phrase[]> {
    const res = await request<unknown>(`/api/sources/${encodeURIComponent(String(sourceId))}/phrases`);
    return toArray<Phrase>(res, ["phrases", "items", "data", "results"]).map((p) => ({
      ...p,
      audio_url: resolveUrl(p.audio_url || (p.audio_path ? `/api/audio/source/${p.audio_path}` : "")),
    }));
  },
  async listCards(): Promise<Card[]> {
    const res = await request<unknown>("/api/cards?active=1");
    const cards = toArray<Card>(res, ["cards", "items", "data", "results"]);
    return cards.map((c) => ({ ...c, audio_url: resolveUrl(c.audio_url) }));
  },
  removeCard(phraseId: number | string): Promise<{ phrase_id: number; removed: boolean; active: boolean }> {
    return requestJson<{ phrase_id: number; removed: boolean; active: boolean }>(
      `/api/cards/${encodeURIComponent(String(phraseId))}`,
      "DELETE",
      {},
    );
  },

  // ── Study grading (LLM-backed, additive) ──────────────────────────────────
  gradeStudy(payload: StudyGradeRequest): Promise<StudyGradeResponse> {
    return requestJson<StudyGradeResponse>("/api/study/grade", "POST", payload);
  },
  async listVerbMisses(limit = 100): Promise<VerbMiss[]> {
    const res = await request<unknown>(`/api/study/verb-misses?limit=${encodeURIComponent(String(limit))}`);
    return toArray<VerbMiss>(res, ["items", "data", "results"]);
  },
  async listLessonMisses(limit = 100): Promise<LessonMiss[]> {
    const res = await request<unknown>(`/api/study/lesson-misses?limit=${encodeURIComponent(String(limit))}`);
    return toArray<LessonMiss>(res, ["items", "data", "results"]);
  },
  async listLessonProgress(lessonId?: string): Promise<LessonProgress[]> {
    const suffix = lessonId ? `?lesson_id=${encodeURIComponent(lessonId)}` : "";
    const res = await request<unknown>(`/api/study/lesson-progress${suffix}`);
    return toArray<LessonProgress>(res, ["items", "data", "results"]);
  },
  async listLessonPromptProgress(lessonId: string, section?: string): Promise<LessonPromptProgress[]> {
    const params = new URLSearchParams({ lesson_id: lessonId });
    if (section) params.set("section", section);
    const res = await request<unknown>(`/api/study/lesson-prompt-progress?${params.toString()}`);
    return toArray<LessonPromptProgress>(res, ["items", "data", "results"]);
  },
  resetLessonProgress(lessonId: string): Promise<LessonProgress> {
    return requestJson<LessonProgress>("/api/study/lesson-progress/reset", "POST", { lesson_id: lessonId });
  },
  async listVerbProgress(verb?: string): Promise<VerbProgress[]> {
    const suffix = verb ? `?verb=${encodeURIComponent(verb)}` : "";
    const res = await request<unknown>(`/api/study/verb-progress${suffix}`);
    return toArray<VerbProgress>(res, ["items", "data", "results"]);
  },
  async listVerbPromptProgress(verb: string, tense?: string): Promise<VerbPromptProgress[]> {
    const params = new URLSearchParams({ verb });
    if (tense) params.set("tense", tense);
    const res = await request<unknown>(`/api/study/verb-prompt-progress?${params.toString()}`);
    return toArray<VerbPromptProgress>(res, ["items", "data", "results"]);
  },
  resetVerbProgress(verb: string): Promise<VerbProgress> {
    return requestJson<VerbProgress>("/api/study/verb-progress/reset", "POST", { verb });
  },
  listVerbCatalog(): Promise<VerbCatalog> {
    return request<VerbCatalog>("/api/study/verbs");
  },
  addVerb(payload: CreateVerbRequest): Promise<VerbCatalogEntry> {
    return requestJson<VerbCatalogEntry>("/api/study/verbs", "POST", payload);
  },
  getVerbUsageBank(verb: string, batch = 1): Promise<VerbUsageBankBatch> {
    const params = new URLSearchParams({ verb, batch: String(batch) });
    return request<VerbUsageBankBatch>(`/api/study/verb-usage-bank?${params.toString()}`);
  },
  promoteLessonMiss(missId: number): Promise<{ phrase_id: number; already_promoted: boolean }> {
    return requestJson<{ phrase_id: number; already_promoted: boolean }>("/api/study/promote-lesson-miss", "POST", { miss_id: missId });
  },
  async listPatterns(): Promise<{ patterns: PatternCatalogEntry[]; packs: PatternPack[] }> {
    const res = await request<unknown>("/api/study/patterns");
    const obj = res && typeof res === "object" ? res as Record<string, unknown> : {};
    return {
      patterns: toArray<PatternCatalogEntry>(obj.patterns, ["items", "data", "results"]),
      packs: toArray<PatternPack>(obj.packs, ["items", "data", "results"]).map((pack) => ({
        ...pack,
        drills: (pack.drills ?? []).map((drill) => ({
          ...drill,
          audio_url: drill.audio_path ? resolveUrl(`/api/audio/source/${drill.audio_path}`) : null,
        })),
      })),
    };
  },
  async listPatternPacks(patternId?: string): Promise<PatternPack[]> {
    const suffix = patternId ? `?pattern_id=${encodeURIComponent(patternId)}` : "";
    const res = await request<unknown>(`/api/study/pattern-packs${suffix}`);
    return toArray<PatternPack>(res, ["packs", "items", "data", "results"]);
  },
  generatePatternPack(patternId: string, payload: { source_lesson_id?: string | null; count?: number } = {}): Promise<{ pack: PatternPack }> {
    return requestJson<{ pack: PatternPack }>(`/api/study/patterns/${encodeURIComponent(patternId)}/generate-pack`, "POST", payload);
  },
  promotePatternPack(packId: number): Promise<{ pack_id: number; promoted: number; phrase_ids: number[] }> {
    return requestJson<{ pack_id: number; promoted: number; phrase_ids: number[] }>(`/api/study/pattern-packs/${packId}/promote`, "POST", {});
  },
  gradePatternDrills(attempts: { drill_id: number; user_answer: string }[]): Promise<{ items: PatternGradeResultItem[]; summary: string }> {
    return requestJson<{ items: PatternGradeResultItem[]; summary: string }>("/api/study/pattern-drills/grade", "POST", { attempts });
  },
  async listPatternMisses(limit = 100): Promise<PatternMiss[]> {
    const res = await request<unknown>(`/api/study/pattern-misses?limit=${encodeURIComponent(String(limit))}`);
    return toArray<PatternMiss>(res, ["items", "data", "results"]);
  },

  // ── Ingestion (real) ─────────────────────────────────────────────────────
  createIngest(sourceUrl: string): Promise<IngestJob> {
    return requestJson<IngestJob>("/api/ingest", "POST", { url: sourceUrl });
  },
  getIngest(jobId: number | string): Promise<IngestJob> {
    return request<IngestJob>(`/api/ingest/${encodeURIComponent(String(jobId))}`);
  },
  async getRecentIngests(limit = 10): Promise<IngestJob[]> {
    const res = await request<{ jobs?: IngestJob[] }>(`/api/ingest/recent?limit=${encodeURIComponent(String(limit))}`);
    return Array.isArray(res.jobs) ? res.jobs : [];
  },

  // Backward-compatible names used by older UI code.
  createSource(sourceUrl: string): Promise<IngestJob> {
    return this.createIngest(sourceUrl);
  },
  getSource(jobId: number | string): Promise<IngestJob> {
    return this.getIngest(jobId);
  },
};

/** Poll a grading job until it completes or fails (or times out). */
export async function pollJob(
  jobId: number | string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (j: Job) => void;
    signal?: AbortSignal;
  } = {},
): Promise<Job> {
  const intervalMs = opts.intervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const start = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const job = await api.getJob(jobId);
    opts.onUpdate?.(job);
    if (isJobFailed(job)) {
      throw new ApiError(job.error_message || "Grading failed.", 0);
    }
    if (isJobComplete(job)) return job;
    if (Date.now() - start > timeoutMs) {
      throw new ApiError("Grading timed out.", 0);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
