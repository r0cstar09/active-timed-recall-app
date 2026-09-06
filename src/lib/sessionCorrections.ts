import type { Session, SessionItem } from "./types";

/** Undefined means the general queue; an explicit empty/invalid scope never does. */
export function targetedPhraseIds(ids?: number[]): number[] | undefined {
  if (ids === undefined) return undefined;
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("This card batch is empty or invalid. No other queue cards were requested.");
  }
  return [...new Set(ids)];
}

/** Use the latest attempt for each card, not a historical failure it corrected. */
export function correctionPhraseIds(items: SessionItem[]): number[] {
  const latest = new Map<number, SessionItem>();
  for (const item of items) {
    const previous = latest.get(item.phrase_id);
    const attempt = item.attempt_number ?? 1;
    const previousAttempt = previous?.attempt_number ?? 1;
    if (!previous || attempt > previousAttempt ||
        (attempt === previousAttempt && item.sprint_item_id > previous.sprint_item_id)) {
      latest.set(item.phrase_id, item);
    }
  }
  return [...latest.values()]
    .filter((item) => item.result === "fail" || item.result === "partial")
    .map((item) => item.phrase_id);
}

/** Never display unrelated cards if a stale server ignores the requested scope. */
export function assertTargetedSession(session: Session, phraseIds: number[]): void {
  if (!session.session_id || session.mode !== "practice" || session.affects_fsrs !== false ||
      session.items.length !== phraseIds.length ||
      session.items.some((item, index) => item.phrase_id !== phraseIds[index])) {
    throw new Error("The exact card batch could not be reserved. Retry this batch; no other cards will be shown.");
  }
}
