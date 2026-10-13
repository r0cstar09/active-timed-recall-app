import type { CurationDraft, TranscriptSegment } from "./curationTypes";

export interface ClipSplitSuggestion {
  afterSegmentIndex: number;
  leftSpanish: string;
  rightSpanish: string;
  /** Absolute source time. Caption timing is only a suggestion; the learner listens and chooses the cut. */
  suggestedSourceTime: number;
}

export interface SplitEligibilityContext {
  busy: boolean;
  changed: boolean;
  stale: boolean;
}

export interface SplitEligibility {
  allowed: boolean;
  reason: string | null;
}

const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const clamped = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function normalizeClipText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Map a saved clip's relative player position to absolute source seconds. */
export function sourceTimeFromClipPosition(
  clipStart: number,
  clipPosition: number,
  clipDuration: number,
): number {
  const duration = Number.isFinite(clipDuration) ? Math.max(0, clipDuration) : 0;
  const position = Number.isFinite(clipPosition) ? clamped(clipPosition, 0, duration) : 0;
  return rounded(clipStart + position);
}

/** Map absolute source seconds back to the saved clip player's relative position. */
export function clipPositionFromSourceTime(
  clipStart: number,
  sourceTime: number,
  clipDuration: number,
): number {
  const duration = Number.isFinite(clipDuration) ? Math.max(0, clipDuration) : 0;
  const position = Number.isFinite(sourceTime) ? sourceTime - clipStart : 0;
  return rounded(clamped(position, 0, duration));
}

/**
 * Offer caption-line boundaries only when the complete saved Spanish still maps
 * exactly to those lines. The next line's START is the timing suggestion: caption
 * windows can overlap, so the previous line's end is not a speaker handoff.
 */
export function createLineSplitSuggestions(
  draft: CurationDraft,
  transcript: TranscriptSegment[],
): ClipSplitSuggestion[] {
  const wanted = new Set(draft.segment_indices);
  const segments = transcript.filter((segment) => wanted.has(segment.index));
  if (segments.length < 2) return [];
  const completeText = normalizeClipText(segments.map((segment) => segment.text).join(" "));
  if (completeText !== normalizeClipText(draft.spanish)) return [];

  const suggestions: ClipSplitSuggestion[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const suggestedSourceTime = segments[index].start;
    if (!Number.isFinite(suggestedSourceTime)
      || suggestedSourceTime <= draft.start_time
      || suggestedSourceTime >= draft.end_time) continue;
    const leftSpanish = normalizeClipText(segments.slice(0, index).map((segment) => segment.text).join(" "));
    const rightSpanish = normalizeClipText(segments.slice(index).map((segment) => segment.text).join(" "));
    if (!leftSpanish || !rightSpanish
      || normalizeClipText(`${leftSpanish} ${rightSpanish}`) !== normalizeClipText(draft.spanish)) continue;
    suggestions.push({
      afterSegmentIndex: segments[index - 1].index,
      leftSpanish,
      rightSpanish,
      suggestedSourceTime: rounded(suggestedSourceTime),
    });
  }
  return suggestions;
}

export type TextPartition =
  | { ok: true; leftSpanish: string; rightSpanish: string }
  | { ok: false; error: string };

/** Partition at a learner-selected text cursor without dropping or inventing words. */
export function partitionSpanishAtCursor(source: string, cursor: number): TextPartition {
  const boundedCursor = Math.trunc(cursor);
  if (!Number.isFinite(cursor) || boundedCursor <= 0 || boundedCursor >= source.length) {
    return { ok: false, error: "Place the cursor between the two Spanish parts, not at either end." };
  }
  const before = source[boundedCursor - 1] ?? "";
  const after = source[boundedCursor] ?? "";
  if (/^[\p{L}\p{N}]$/u.test(before) && /^[\p{L}\p{N}]$/u.test(after)) {
    return { ok: false, error: "Place the cursor between words; a word cannot be divided across clips." };
  }
  const leftSpanish = source.slice(0, boundedCursor).trim();
  const rightSpanish = source.slice(boundedCursor).trim();
  if (!leftSpanish || !rightSpanish) {
    return { ok: false, error: "Both Spanish parts must contain spoken words." };
  }
  if (normalizeClipText(`${leftSpanish} ${rightSpanish}`) !== normalizeClipText(source)) {
    return { ok: false, error: "Choose a whitespace boundary so every Spanish word and punctuation mark is preserved." };
  }
  return { ok: true, leftSpanish, rightSpanish };
}

export function splitDraftEligibility(
  draft: CurationDraft,
  context: SplitEligibilityContext,
): SplitEligibility {
  if (draft.repair_phrase_id) return { allowed: false, reason: "Repair drafts cannot be split." };
  if (draft.status === "added") return { allowed: false, reason: "Clips already in the library cannot be split here." };
  if (context.busy || draft.status === "queued" || draft.status === "preparing") {
    return { allowed: false, reason: "Wait for the current preparation or save to finish." };
  }
  if (context.changed) return { allowed: false, reason: "Save or discard unsaved edits before splitting." };
  if (context.stale) return { allowed: false, reason: "This draft changed on the server; reload it before splitting." };
  if (draft.status !== "ready" && draft.status !== "needs_review") {
    return { allowed: false, reason: "Prepare the clip before splitting it." };
  }
  if (!draft.audio_url) return { allowed: false, reason: "A playable prepared preview is required before splitting." };
  return { allowed: true, reason: null };
}
