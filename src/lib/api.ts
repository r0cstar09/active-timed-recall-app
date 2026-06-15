/**
 * Centralized, typed API client for the FastAPI learning engine.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ASSUMED BACKEND CONTRACT (single source of truth — remap here if it differs)
 * ─────────────────────────────────────────────────────────────────────────
 *  Ingestion
 *    POST   /api/ingest                 { youtubeUrl }            -> IngestJob
 *    GET    /api/ingest/:jobId                                    -> IngestJob
 *
 *  Library
 *    GET    /api/videos                                           -> Video[]
 *    DELETE /api/videos/:videoId                                  -> 204
 *    GET    /api/videos/:videoId/cards                            -> Card[]
 *
 *  Sessions / scheduling
 *    GET    /api/stats                                            -> Stats
 *    POST   /api/session/start          { limit? }                -> SessionPayload
 *
 *  Recall attempts (acoustic)
 *    POST   /api/cards/:cardId/attempt  multipart(audio,sessionId,elapsedMs)
 *                                                                 -> Attempt (grading)
 *    GET    /api/attempts/:attemptId                              -> Attempt
 *    POST   /api/cards/:cardId/review   { rating }                -> 204
 *
 *  Corrections review
 *    GET    /api/corrections                                      -> CorrectionCard[]
 *
 * Every backend call in the app goes through this module. UI code never builds
 * URLs or touches fetch directly.
 */

import { getApiBaseUrl, resolveUrl } from "./config";
import type {
  Attempt,
  Card,
  CorrectionCard,
  IngestJob,
  ReviewRating,
  SessionPayload,
  Stats,
  Video,
} from "./types";

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
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
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

/** Normalize any audio URLs in a card to absolute URLs against the API base. */
function hydrateCard(card: Card): Card {
  return { ...card, nativeAudioUrl: resolveUrl(card.nativeAudioUrl) };
}

function hydrateAttempt(a: Attempt): Attempt {
  return {
    ...a,
    userAudioUrl: a.userAudioUrl ? resolveUrl(a.userAudioUrl) : a.userAudioUrl,
    nativeAudioUrl: a.nativeAudioUrl ? resolveUrl(a.nativeAudioUrl) : a.nativeAudioUrl,
  };
}

export const api = {
  // ── Ingestion ──────────────────────────────────────────────────────────
  startIngest(youtubeUrl: string): Promise<IngestJob> {
    return requestJson<IngestJob>("/api/ingest", "POST", { youtubeUrl });
  },
  getIngest(jobId: string): Promise<IngestJob> {
    return request<IngestJob>(`/api/ingest/${encodeURIComponent(jobId)}`);
  },

  // ── Library ────────────────────────────────────────────────────────────
  listVideos(): Promise<Video[]> {
    return request<Video[]>("/api/videos");
  },
  deleteVideo(videoId: string): Promise<void> {
    return request<void>(`/api/videos/${encodeURIComponent(videoId)}`, {
      method: "DELETE",
    });
  },
  async listCards(videoId: string): Promise<Card[]> {
    const cards = await request<Card[]>(
      `/api/videos/${encodeURIComponent(videoId)}/cards`,
    );
    return cards.map(hydrateCard);
  },

  // ── Sessions / scheduling ────────────────────────────────────────────────
  getStats(): Promise<Stats> {
    return request<Stats>("/api/stats");
  },
  async startSession(limit = 20): Promise<SessionPayload> {
    const payload = await requestJson<SessionPayload>("/api/session/start", "POST", {
      limit,
    });
    return { ...payload, cards: payload.cards.map(hydrateCard) };
  },

  // ── Recall attempts ──────────────────────────────────────────────────────
  async submitAttempt(
    cardId: string,
    audio: Blob,
    meta: { sessionId?: string; elapsedMs?: number; filename?: string },
  ): Promise<Attempt> {
    const form = new FormData();
    form.append("audio", audio, meta.filename ?? "recall.webm");
    if (meta.sessionId) form.append("sessionId", meta.sessionId);
    if (typeof meta.elapsedMs === "number") {
      form.append("elapsedMs", String(meta.elapsedMs));
    }
    const attempt = await request<Attempt>(
      `/api/cards/${encodeURIComponent(cardId)}/attempt`,
      { method: "POST", body: form },
    );
    return hydrateAttempt(attempt);
  },
  async getAttempt(attemptId: string): Promise<Attempt> {
    return hydrateAttempt(
      await request<Attempt>(`/api/attempts/${encodeURIComponent(attemptId)}`),
    );
  },
  submitReview(cardId: string, rating: ReviewRating): Promise<void> {
    return requestJson<void>(
      `/api/cards/${encodeURIComponent(cardId)}/review`,
      "POST",
      { rating },
    );
  },

  // ── Corrections review ────────────────────────────────────────────────────
  async listCorrections(): Promise<CorrectionCard[]> {
    const items = await request<CorrectionCard[]>("/api/corrections");
    return items.map((c) => ({
      ...c,
      nativeAudioUrl: resolveUrl(c.nativeAudioUrl),
      userAudioUrl: c.userAudioUrl ? resolveUrl(c.userAudioUrl) : c.userAudioUrl,
    }));
  },
};

/**
 * Poll an attempt until it leaves the "grading" state (or times out).
 * Used by the session screen for grading-status polling.
 */
export async function pollAttempt(
  attemptId: string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (a: Attempt) => void;
    signal?: AbortSignal;
  } = {},
): Promise<Attempt> {
  const intervalMs = opts.intervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const start = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const attempt = await api.getAttempt(attemptId);
    opts.onUpdate?.(attempt);
    if (attempt.status !== "grading") return attempt;
    if (Date.now() - start > timeoutMs) {
      throw new ApiError("Grading timed out.", 0);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
