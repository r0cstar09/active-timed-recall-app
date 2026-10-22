export interface SelectionTranslationIntent {
  requestKey: string;
  jobId?: number;
  importId: number;
  sourceText: string;
  contextBefore: string;
  contextAfter: string;
  selectedIndices?: number[];
  transcriptText?: string;
  english?: string;
  lastAutomaticEnglish?: string;
  learnerEdited?: boolean;
}

export function selectionTranslationIntentMatches(
  intent: SelectionTranslationIntent | null,
  value: Pick<SelectionTranslationIntent, "importId" | "sourceText" | "contextBefore" | "contextAfter">,
): boolean {
  return !!intent
    && intent.importId === value.importId
    && intent.sourceText === value.sourceText
    && intent.contextBefore === value.contextBefore
    && intent.contextAfter === value.contextAfter;
}

export function parseSelectionTranslationIntent(raw: string | null): SelectionTranslationIntent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SelectionTranslationIntent>;
    return typeof value.requestKey === "string" && value.requestKey.length >= 8
      && Number.isSafeInteger(value.importId) && (value.importId ?? 0) > 0
      && typeof value.sourceText === "string"
      && typeof value.contextBefore === "string"
      && typeof value.contextAfter === "string"
      && (value.selectedIndices === undefined || (Array.isArray(value.selectedIndices)
        && value.selectedIndices.length > 0 && value.selectedIndices.every((index) => Number.isSafeInteger(index) && index >= 0)
        && new Set(value.selectedIndices).size === value.selectedIndices.length))
      && (value.transcriptText === undefined || typeof value.transcriptText === "string")
      && (value.english === undefined || typeof value.english === "string")
      && (value.lastAutomaticEnglish === undefined || typeof value.lastAutomaticEnglish === "string")
      && (value.learnerEdited === undefined || typeof value.learnerEdited === "boolean")
      && (value.jobId === undefined || (Number.isSafeInteger(value.jobId) && (value.jobId ?? 0) > 0))
      ? value as SelectionTranslationIntent
      : null;
  } catch { return null; }
}

/** Restore only against the same transcript, preserving partial-span text. */
export function restorableSelectionTranslationIntent(
  intent: SelectionTranslationIntent | null,
  importId: number,
  transcript: Array<{ index: number; text: string }>,
): SelectionTranslationIntent | null {
  if (!intent || intent.importId !== importId || !intent.selectedIndices?.length || !intent.sourceText.trim()) return null;
  const lines = transcript.filter((line) => intent.selectedIndices!.includes(line.index));
  if (lines.length !== intent.selectedIndices.length || lines.map((line) => line.text).join(" ") !== intent.transcriptText) return null;
  const first = transcript.indexOf(lines[0]);
  const last = transcript.indexOf(lines[lines.length - 1]);
  if ((transcript[first - 1]?.text ?? "") !== intent.contextBefore || (transcript[last + 1]?.text ?? "") !== intent.contextAfter) return null;
  return intent;
}

export interface SelectionTranslationGuard {
  requestId: number;
  latestRequestId: number;
  requestedSpanish: string;
  currentSpanish: string;
  currentEnglish: string;
  lastAutomaticEnglish: string;
  learnerEdited?: boolean;
}

/** A response owns only its current source and never learner-authored English. */
export function shouldApplySelectionTranslation(guard: SelectionTranslationGuard): boolean {
  return !guard.learnerEdited
    && guard.requestId === guard.latestRequestId
    && guard.requestedSpanish === guard.currentSpanish.trim()
    && guard.currentEnglish === guard.lastAutomaticEnglish;
}

export interface SelectionEnglishSourceChange {
  english: string;
  lastAutomaticEnglish: string;
  learnerEdited: boolean;
}

/** Preserve learner-authored English when the selected Spanish span changes. */
export function selectionEnglishAfterSourceChange(
  currentEnglish: string,
  lastAutomaticEnglish: string,
  cachedEnglish: string,
  learnerOwned = false,
): SelectionEnglishSourceChange {
  const learnerEdited = learnerOwned || currentEnglish !== lastAutomaticEnglish;
  return learnerEdited
    ? { english: currentEnglish, lastAutomaticEnglish, learnerEdited }
    : { english: cachedEnglish, lastAutomaticEnglish: cachedEnglish, learnerEdited };
}

/** Cached line meanings cannot satisfy a new/partial selection's save gate. */
export function selectionTranslationCanSave(value: {
  spanish: string;
  english: string;
  translationSource: string;
  status: "idle" | "loading" | "ready" | "failed";
  learnerEdited: boolean;
}): boolean {
  return !!value.spanish.trim() && !!value.english.trim()
    && value.translationSource === value.spanish.trim()
    && (value.status === "ready" || (value.status === "failed" && value.learnerEdited));
}
