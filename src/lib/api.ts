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
 * INGESTION (assumed — no confirmed contract; remap here if it differs)
 *   POST   /api/sources               { source_url }          -> SourceRaw
 *   GET    /api/sources/:id                                   -> SourceRaw
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
  Source,
  SourceRaw,
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

export const api = {
  // ── Sessions / grading (real contract) ───────────────────────────────────
  async createSession(): Promise<Session> {
    return hydrateSession(await requestJson<Session>("/api/sessions", "POST", {}));
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
  listSources(): Promise<Source[]> {
    return request<Source[]>("/api/sources");
  },
  async listCards(): Promise<Card[]> {
    const cards = await request<Card[]>("/api/cards");
    return cards.map((c) => ({ ...c, audio_url: resolveUrl(c.audio_url) }));
  },

  // ── Ingestion (assumed) ──────────────────────────────────────────────────
  createSource(sourceUrl: string): Promise<SourceRaw> {
    return requestJson<SourceRaw>("/api/sources", "POST", { source_url: sourceUrl });
  },
  getSource(id: number | string): Promise<SourceRaw> {
    return request<SourceRaw>(`/api/sources/${encodeURIComponent(String(id))}`);
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
