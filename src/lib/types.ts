/**
 * Shared domain types for the learning-engine backend.
 *
 * These mirror the *assumed* FastAPI contract. If the real backend differs,
 * adjust these types and the mapping in `api.ts` — nothing else in the UI
 * references raw response shapes.
 */

export type IngestStatus = "queued" | "processing" | "done" | "error";

export interface IngestJob {
  jobId: string;
  status: IngestStatus;
  /** Populated once status === "done". */
  videoId?: string;
  title?: string;
  sentenceCount?: number;
  /** Progress 0..1 if the backend reports it. */
  progress?: number;
  error?: string;
}

export interface Video {
  id: string;
  title: string;
  youtubeUrl: string;
  thumbnailUrl?: string;
  sentenceCount: number;
  cardCount: number;
  createdAt: string;
}

/** A single recall card. `targetText` is the Spanish answer (revealed after recall). */
export interface Card {
  id: string;
  videoId: string;
  videoTitle?: string;
  /** Cue shown to the learner during recall (e.g. translation / context). */
  promptText: string;
  /** The Spanish sentence to recall — hidden until reveal. */
  targetText: string;
  /** URL to the sliced native source audio for this sentence. */
  nativeAudioUrl: string;
  /** Seconds allotted for the active recall phase. */
  recallSeconds: number;
  dueAt?: string;
  /** Scheduling state from the FSRS-like scheduler. */
  state?: "new" | "learning" | "review" | "relearning";
}

export interface SessionPayload {
  sessionId: string;
  cards: Card[];
}

export type GradeStatus = "grading" | "graded" | "error";
export type GradeResult = "pass" | "fail";

export interface Attempt {
  attemptId: string;
  cardId: string;
  status: GradeStatus;
  /** Populated once status === "graded". */
  result?: GradeResult;
  /** 0..1 similarity / confidence if provided. */
  score?: number;
  expectedTranscript?: string;
  userTranscript?: string;
  /** Human-readable correction feedback (may contain markup-free text). */
  correction?: string;
  /** URL to the learner's uploaded recording. */
  userAudioUrl?: string;
  nativeAudioUrl?: string;
  error?: string;
}

/** A failed card surfaced on the correction-review screen. */
export interface CorrectionCard {
  cardId: string;
  attemptId: string;
  videoTitle?: string;
  expectedTranscript: string;
  userTranscript: string;
  correction?: string;
  userAudioUrl?: string;
  nativeAudioUrl: string;
  failedAt?: string;
}

export interface Stats {
  dueCount: number;
  newCount: number;
  learningCount: number;
  totalCards: number;
  videoCount: number;
}

/** Self-grade rating forwarded to the FSRS-like scheduler. */
export type ReviewRating = "again" | "hard" | "good" | "easy";
