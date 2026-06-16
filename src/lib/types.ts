/**
 * Domain types for the FastAPI learning engine.
 *
 * The session/grading types below mirror the REAL backend contract. The
 * ingest/library/stats types are still treated as assumed (no contract given
 * yet) and are isolated so they can be adjusted independently.
 */

// ── Sessions & grading (REAL contract) ─────────────────────────────────────

export type SessionMode = "learn" | "review" | "practice" | "misses" | "cloze" | "english_to_spanish" | "audio_shadow";
export type PromptType = "learn" | "english" | "context" | "cloze" | "audio" | "minimal" | "miss" | "english_to_spanish" | "audio_shadow";
export type ItemResult = "pass" | "fail" | "partial" | "pending";
export type FsrsRating = 1 | 2 | 3 | 4;

export interface LearningCard {
  english_meaning?: string;
  spanish_logic?: string;
  english_trap?: string;
  grammar_focus?: string;
  examples?: string[];
}

export interface SchedulingInfo {
  affects_fsrs: boolean;
  due_at?: string | null;
  prompt_stage: number;
  time_limit_seconds: number;
}

export interface SessionItem {
  sprint_item_id: number;
  phrase_id: number;
  position: number;
  prompt: string;
  prompt_type: PromptType;
  mode?: SessionMode;
  spanish: string;
  target_spanish?: string;
  english: string;
  english_meaning?: string;
  context_clue?: string | null;
  cloze_prompt: string;
  source_audio_url: string;
  learning_card?: LearningCard;
  scheduling?: SchedulingInfo;
  recording_id?: number;
  result?: ItemResult;
  score?: number;
  feedback?: string;
  error_type?: string | null;
  user_transcript_segment?: string;
  fsrs_rating?: FsrsRating;
  timed_out?: boolean;
  response_seconds?: number;
}

export interface SessionSummary {
  total: number;
  passed: number;
  failed: number;
  partial: number;
  score: number;
  overtime_count: number;
}

export interface Session {
  session_id: number;
  items: SessionItem[];
  summary?: SessionSummary;
  status?: string;
  mode?: SessionMode;
  affects_fsrs?: boolean;
  seconds_per_card?: number;
}

/** Returned by POST /api/sessions/:id/recording. */
export interface RecordingResponse {
  recording_id: number;
}

/** Returned by POST /api/sessions/:id/grade. */
export interface GradeResponse {
  job_id: string | number;
}

export type JobState = "queued" | "processing" | "complete" | "failed";

export interface Job {
  job_id: number;
  status: JobState;
  result: unknown | null;
  error_message: string | null;
}

export function isJobComplete(j: Job): boolean {
  return j.status === "complete";
}
export function isJobFailed(j: Job): boolean {
  return j.status === "failed";
}

/** Metadata sent alongside each recording upload. */
export interface RecordingMeta {
  mimeType: string;
  promptShownAt: string; // ISO 8601
  answeredAt: string; // ISO 8601
  responseSeconds: number;
  timedOut: boolean;
  filename: string;
}

// ── Sources / phrases / cards (REAL contract) ──────────────────────────────

/** A source without aggregate counts (e.g. on create / detail). */
export interface SourceRaw {
  id: number;
  source_type: string;
  source_url: string;
  source_video_id: string | null;
  title: string | null;
  channel: string | null;
  language: string | null;
  transcript_status: string | null;
  audio_status: string | null;
  created_at: string;
}

/** A source with phrase aggregates (e.g. on GET /api/sources). */
export interface Source extends SourceRaw {
  phrase_count: number;
  active_count: number;
}

export interface Phrase {
  id: number;
  source_id: number;
  spanish: string;
  english: string;
  context_clue: string | null;
  cloze_prompt: string;
  audio_path: string;
  active: boolean;
}

export type CardState = "new" | "learning" | "review" | "relearning";

export interface Card {
  phrase_id: number;
  spanish: string;
  english: string;
  context_clue: string | null;
  cloze_prompt: string;
  audio_url: string;
  due_at: string;
  state: CardState;
  reps: number;
  lapses: number;
}

/** Dashboard counts derived client-side from /api/cards + /api/sources. */
export interface DashboardStats {
  dueCount: number;
  newCount: number;
  learningCount: number;
  reviewCount: number;
  totalCards: number;
  sourceCount: number;
}

/** A treated-as-ready status set for source ingestion polling (assumed). */
export function isStatusReady(status: string | null): boolean {
  if (!status) return false;
  return ["done", "complete", "completed", "ready", "ok", "success"].includes(
    status.toLowerCase(),
  );
}
export function isStatusFailed(status: string | null): boolean {
  if (!status) return false;
  return ["error", "failed", "failure"].includes(status.toLowerCase());
}
