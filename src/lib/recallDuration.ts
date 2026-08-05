export const RECALL_SECONDS = 15;
export const MAX_RECALL_SECONDS = 35;

type ItemTiming = {
  scheduling?: {
    time_limit_seconds?: number | null;
  } | null;
};

/**
 * Trust the backend's content-derived per-card budget while keeping old or
 * malformed payloads safe. The client never performs linguistic analysis.
 */
export function recallSecondsFromServer(value: number | null | undefined): number {
  const seconds = Number(value);
  if (!isFinite(seconds) || seconds <= 0) return RECALL_SECONDS;
  return Math.min(MAX_RECALL_SECONDS, Math.max(RECALL_SECONDS, Math.ceil(seconds)));
}

export function itemForDuration(item?: ItemTiming): number {
  return recallSecondsFromServer(item?.scheduling?.time_limit_seconds);
}
