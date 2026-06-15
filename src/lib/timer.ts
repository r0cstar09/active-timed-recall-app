/**
 * Timestamp-based recall timer with crash/refresh-safe persistence.
 *
 * Why timestamps (not a decrementing counter): iPhone Safari throttles or
 * suspends timers when the tab is backgrounded / the phone is locked. By
 * persisting an absolute `deadline` (epoch ms) we can always recompute the true
 * remaining time on `visibilitychange` or after a full page refresh — satisfying
 * acceptance tests #4, #5 and #12.
 *
 * The flow is record-all-then-grade: every item's recording is uploaded as we
 * go, then the whole session is graded async. Persistence tracks where we are
 * (item index + phase), the current countdown deadline, which items have been
 * uploaded, the grading job id, and the final graded session.
 */

import type { Session } from "./types";

const KEY = "atr.session";
const GRADED_KEY = "atr.lastGraded";

export type Phase = "recall" | "uploading" | "grading" | "summary";

export interface PersistedSession {
  sessionId: number;
  /** Raw items from POST /api/sessions (ungraded). */
  items: Session["items"];
  index: number;
  phase: Phase;
  /** Absolute deadline for the current recall countdown (epoch ms). */
  deadline: number | null;
  durationMs: number | null;
  /** ISO timestamp the current item's prompt was shown. */
  promptShownAt: string | null;
  /** sprint_item_ids already uploaded (so resume doesn't double-record). */
  uploadedItemIds: number[];
  /** grading job id once /grade has been called. */
  jobId: string | number | null;
  /** final graded session once available. */
  graded: Session | null;
  savedAt: number;
}

export function loadSession(): PersistedSession | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedSession;
    if (parsed?.sessionId == null || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(s: PersistedSession): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify({ ...s, savedAt: Date.now() }));
}

export function clearSession(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(KEY);
}

/** Persist the last graded session so the Review screen can show its misses. */
export function saveLastGraded(s: Session): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(GRADED_KEY, JSON.stringify(s));
}

export function loadLastGraded(): Session | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(GRADED_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
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
