/**
 * Timestamp-based recall timer with crash/refresh-safe persistence.
 *
 * Why timestamps (not a decrementing counter): iPhone Safari throttles or
 * suspends timers when the tab is backgrounded / the phone is locked. By
 * persisting an absolute `deadline` (epoch ms) we can always recompute the
 * true remaining time on `visibilitychange` or after a full page refresh —
 * satisfying acceptance tests #4, #5 and #12.
 */

import type { SessionPayload } from "./types";

const KEY = "atr.session";

export type Phase = "recall" | "recording" | "submitting" | "feedback";

export interface PersistedSession {
  sessionId: string;
  cards: SessionPayload["cards"];
  index: number;
  phase: Phase;
  /** Absolute deadline for the current recall countdown (epoch ms). */
  deadline: number | null;
  /** Duration of the current card's recall window (ms) — for progress UI. */
  durationMs: number | null;
  /** attemptId once an upload has happened, so feedback survives refresh. */
  attemptId: string | null;
  startedAt: number;
}

export function loadSession(): PersistedSession | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed?.sessionId || !Array.isArray(parsed.cards)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(s: PersistedSession): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(KEY);
}

/** Remaining milliseconds for the current countdown, clamped at 0. */
export function remainingMs(deadline: number | null): number {
  if (deadline == null) return 0;
  return Math.max(0, deadline - Date.now());
}

/** Whole seconds remaining (rounded up) for display. */
export function remainingSeconds(deadline: number | null): number {
  return Math.ceil(remainingMs(deadline) / 1000);
}
