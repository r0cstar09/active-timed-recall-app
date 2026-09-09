export type CurationImportStatus = "queued" | "loading" | "ready" | "failed";
export type CurationDraftStatus =
  | "draft"
  | "queued"
  | "preparing"
  | "ready"
  | "needs_review"
  | "failed"
  | "added";

export interface TranscriptSegment {
  index: number;
  text: string;
  start: number;
  end: number;
}

export interface CurationDraft {
  id: number;
  import_id: number;
  segment_indices: number[];
  spanish: string;
  english: string;
  start_time: number;
  end_time: number;
  revision: number;
  status: CurationDraftStatus;
  approved: boolean;
  warning: string | null;
  error_message: string | null;
  audio_url: string | null;
  repair_phrase_id: number | null;
  phrase_id: number | null;
  existing_phrase_id: number | null;
  existing_active: boolean | null;
  manual_timing: boolean;
  created_at: string;
  updated_at: string;
}

export interface CurationImport {
  id: number;
  source_id: number | null;
  source_url: string;
  video_id: string;
  title: string | null;
  status: CurationImportStatus;
  error_message: string | null;
  transcript: TranscriptSegment[];
  drafts: CurationDraft[];
  source_audio_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftSelection {
  segment_indices: number[];
  spanish: string;
}

export interface DraftRevisionRef {
  id: number;
  revision: number;
}

export interface DraftPatch {
  revision: number;
  spanish?: string;
  english?: string;
  start_time?: number;
  end_time?: number;
  approved?: boolean;
}

export interface PromoteResult {
  draft_id: number;
  phrase_id: number;
  action: "added" | "already_added" | "duplicate" | "repaired";
  active: boolean;
}

export interface PromoteResponse {
  results: PromoteResult[];
  drafts: CurationDraft[];
}

/**
 * Existing cards are not part of the new curation schema, but the Library uses
 * this compatibility shape for both GET /api/cards?active=1 and active=0.
 */
export interface CurationLibraryCard {
  phrase_id: number;
  spanish: string;
  english: string;
  context_clue?: string | null;
  cloze_prompt?: string | null;
  audio_url: string;
  due_at?: string | null;
  state?: string | null;
  reps?: number;
  lapses?: number;
  active?: boolean;
  source_id?: number | null;
  source_type?: string | null;
  source_url?: string | null;
  repair_available?: boolean;
}
