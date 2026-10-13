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
