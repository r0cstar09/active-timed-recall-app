import type { IngestJob, RemoveIngestCardsResponse } from "./types";

export const INGEST_TERMINAL_STATUSES = new Set(["complete", "partial", "failed"]);

export function isTerminalIngest(job: IngestJob | null | undefined): boolean {
  return Boolean(job && INGEST_TERMINAL_STATUSES.has(job.status));
}

function nonNegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

export function ingestPhraseCount(job: IngestJob | null | undefined): number | null {
  if (!job) return null;
  const count = nonNegativeCount(job.phrase_count);
  if (count !== null) return count;
  return Array.isArray(job.phrases) ? job.phrases.length : null;
}

export function ingestActivePhraseCount(job: IngestJob | null | undefined): number | null {
  if (!job) return null;
  const count = nonNegativeCount(job.active_phrase_count);
  if (count !== null) return count;
  return Array.isArray(job.phrases)
    ? job.phrases.filter((phrase) => phrase.active).length
    : null;
}

export function ingestDeleteUnavailableMessage(job: IngestJob | null | undefined): string | null {
  if (!isTerminalIngest(job)) return null;
  if (job?.ownership_unknown === true) {
    return job.ownership_message?.trim()
      || "This legacy ingestion cannot be matched to its cards safely. To protect cards from other ingestions, deletion is unavailable.";
  }
  if (job?.ownership_unknown !== false) {
    return "Card ownership could not be verified for this ingestion. Deletion is disabled to protect cards from other ingestions.";
  }
  if (ingestPhraseCount(job) === null || ingestActivePhraseCount(job) === null) {
    return "The backend did not provide verified card counts for this ingestion. Deletion is disabled until the counts are available.";
  }
  return null;
}

export function canDeleteIngestCards(job: IngestJob | null | undefined): boolean {
  const activeCount = ingestActivePhraseCount(job);
  return isTerminalIngest(job)
    && job?.ownership_unknown === false
    && ingestPhraseCount(job) !== null
    && activeCount !== null
    && activeCount > 0;
}

export function mergeRecentIngests(
  current: IngestJob[],
  updates: IngestJob[],
  limit = 10,
): IngestJob[] {
  const jobs = new Map<number, IngestJob>();
  for (const job of current) jobs.set(job.job_id, job);
  for (const job of updates) {
    const existing = jobs.get(job.job_id);
    jobs.set(job.job_id, existing ? { ...existing, ...job } : job);
  }
  return [...jobs.values()]
    .sort((left, right) => right.job_id - left.job_id)
    .slice(0, Math.max(1, limit));
}

export function recentTerminalIngests(jobs: IngestJob[]): IngestJob[] {
  return jobs.filter(isTerminalIngest);
}

export interface IngestDeleteGate {
  tryAcquire(jobId: number): boolean;
  release(jobId: number): void;
  isLocked(): boolean;
}

export function createIngestDeleteGate(): IngestDeleteGate {
  let lockedJobId: number | null = null;
  return {
    tryAcquire(jobId) {
      if (lockedJobId !== null) return false;
      lockedJobId = jobId;
      return true;
    },
    release(jobId) {
      if (lockedJobId === jobId) lockedJobId = null;
    },
    isLocked() {
      return lockedJobId !== null;
    },
  };
}

export function canChangeIngestSelection(gate: IngestDeleteGate): boolean {
  return !gate.isLocked();
}

export function reopenRecentTerminalJob(
  jobs: IngestJob[],
  jobId: number,
  gate: IngestDeleteGate,
): IngestJob | null {
  if (!canChangeIngestSelection(gate)) return null;
  return jobs.find((job) => job.job_id === jobId && isTerminalIngest(job)) ?? null;
}

export function applyIngestDeleteResult(
  job: IngestJob,
  result: RemoveIngestCardsResponse,
): IngestJob {
  const remaining = nonNegativeCount(result.active_phrase_count);
  const phraseCount = nonNegativeCount(result.phrase_count);
  return {
    ...job,
    phrase_count: phraseCount,
    active_phrase_count: remaining,
    ownership_unknown: result.ownership_unknown,
    ownership_message: result.ownership_message,
    ownership_mode: result.ownership_mode,
    phrases: result.ownership_unknown === false && remaining === 0
      ? job.phrases?.map((phrase) => ({ ...phrase, active: false }))
      : job.phrases,
  };
}

export type IngestDeleteExecution =
  | { status: "success"; result: RemoveIngestCardsResponse & { removed_count: number; phrase_count: number; active_phrase_count: number }; job: IngestJob }
  | {
    status: "refused";
    reason: "ownership_unknown" | "invalid_counts";
    message: string;
    result: RemoveIngestCardsResponse;
    job: IngestJob;
  }
  | { status: "error"; error: unknown }
  | { status: "blocked"; reason: "busy" | "unavailable" };

export async function executeIngestCardDeletion(
  job: IngestJob,
  removeCards: (jobId: number) => Promise<RemoveIngestCardsResponse>,
  gate: IngestDeleteGate,
  onStart?: () => void,
): Promise<IngestDeleteExecution> {
  if (!canDeleteIngestCards(job)) return { status: "blocked", reason: "unavailable" };
  if (!gate.tryAcquire(job.job_id)) return { status: "blocked", reason: "busy" };
  onStart?.();
  try {
    const result = await removeCards(job.job_id);
    const updated = applyIngestDeleteResult(job, result);
    if (result.ownership_unknown !== false) {
      return {
        status: "refused",
        reason: "ownership_unknown",
        message: result.ownership_message?.trim()
          || "The backend could not verify which cards belong to this ingestion. No removal was confirmed.",
        result,
        job: updated,
      };
    }
    const removedCount = nonNegativeCount(result.removed_count);
    const phraseCount = nonNegativeCount(result.phrase_count);
    const activePhraseCount = nonNegativeCount(result.active_phrase_count);
    if (removedCount === null || phraseCount === null || activePhraseCount === null) {
      return {
        status: "refused",
        reason: "invalid_counts",
        message: "The backend did not return verified removal counts. No removal was confirmed; reopen this ingestion before trying again.",
        result,
        job: updated,
      };
    }
    return { status: "success", result: { ...result, removed_count: removedCount, phrase_count: phraseCount, active_phrase_count: activePhraseCount }, job: updated };
  } catch (error) {
    return { status: "error", error };
  } finally {
    gate.release(job.job_id);
  }
}

export interface IngestDeleteUiState {
  confirmJobId: number | null;
  deletingJobId: number | null;
  message: string | null;
  error: string | null;
}

export const INITIAL_INGEST_DELETE_UI: IngestDeleteUiState = {
  confirmJobId: null,
  deletingJobId: null,
  message: null,
  error: null,
};

export type IngestDeleteUiAction =
  | { type: "confirm"; job: IngestJob }
  | { type: "cancel" }
  | { type: "started"; jobId: number }
  | { type: "succeeded"; jobId: number; removedCount: number; historyPreserved: boolean }
  | { type: "failed"; jobId: number; error: string }
  | { type: "refused"; jobId: number; error: string }
  | { type: "selectionChanged" }
  | { type: "reset" };

function successMessage(removedCount: number, historyPreserved: boolean): string {
  const historyMessage = historyPreserved
    ? "Review history was preserved."
    : "The backend did not confirm that review history was preserved.";
  return removedCount > 0
    ? `Removed ${removedCount} card${removedCount === 1 ? "" : "s"} from study. ${historyMessage}`
    : "All cards from this ingestion were already removed.";
}

export function ingestDeleteUiReducer(
  state: IngestDeleteUiState,
  action: IngestDeleteUiAction,
): IngestDeleteUiState {
  switch (action.type) {
    case "confirm":
      if (state.deletingJobId !== null || !canDeleteIngestCards(action.job)) return state;
      return {
        confirmJobId: action.job.job_id,
        deletingJobId: null,
        message: null,
        error: null,
      };
    case "cancel":
      if (state.deletingJobId !== null) return state;
      return { ...INITIAL_INGEST_DELETE_UI };
    case "started":
      if (state.deletingJobId !== null || state.confirmJobId !== action.jobId) return state;
      return { ...state, deletingJobId: action.jobId, message: null, error: null };
    case "succeeded":
      if (state.deletingJobId !== action.jobId) return state;
      return {
        confirmJobId: null,
        deletingJobId: null,
        message: successMessage(action.removedCount, action.historyPreserved),
        error: null,
      };
    case "failed":
      if (state.deletingJobId !== action.jobId) return state;
      return {
        confirmJobId: action.jobId,
        deletingJobId: null,
        message: null,
        error: action.error,
      };
    case "refused":
      if (state.deletingJobId !== action.jobId) return state;
      return {
        confirmJobId: null,
        deletingJobId: null,
        message: null,
        error: action.error,
      };
    case "selectionChanged":
    case "reset":
      if (state.deletingJobId !== null) return state;
      return { ...INITIAL_INGEST_DELETE_UI };
  }
}
