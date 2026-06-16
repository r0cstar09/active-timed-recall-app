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

import { getApiBaseUrl, resolveUrl } from "./config";
import type {
  Card,
  GradeResponse,
  Job,
  RecordingMeta,
  RecordingResponse,
  Session,
  SessionItem,
  SessionMode,
  IngestJob,
  Source,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(path), {
      ...init,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError(
      `Network error reaching backend. Check Tailscale connectivity and the API base URL in Settings. (${
        err instanceof Error ? err.message : String(err)
      })`,
      0,
    );
  }

  if (!res.ok) {
    let body: unknown;
    let detail = res.statusText;
    try {
      body = await res.json();
      if (body && typeof body === "object" && "detail" in body) {
        detail = String((body as Record<string, unknown>).detail);
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(`Request failed (${res.status}): ${detail}`, res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
  return { ...item, source_audio_url: resolveUrl(item.source_audio_url) };
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

  // ── Library (real) ───────────────────────────────────────────────────────
  async listSources(): Promise<Source[]> {
    const res = await request<unknown>("/api/sources");
    return toArray<Source>(res, ["sources", "items", "data", "results"]);
  },
  async listCards(): Promise<Card[]> {
    const res = await request<unknown>("/api/cards");
    const cards = toArray<Card>(res, ["cards", "items", "data", "results"]);
    return cards.map((c) => ({ ...c, audio_url: resolveUrl(c.audio_url) }));
  },

  // ── Ingestion (real) ─────────────────────────────────────────────────────
  createIngest(sourceUrl: string): Promise<IngestJob> {
    return requestJson<IngestJob>("/api/ingest", "POST", { url: sourceUrl });
  },
  getIngest(jobId: number | string): Promise<IngestJob> {
    return request<IngestJob>(`/api/ingest/${encodeURIComponent(String(jobId))}`);
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
