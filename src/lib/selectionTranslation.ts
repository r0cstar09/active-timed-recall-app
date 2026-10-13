export interface SelectionTranslationGuard {
  requestId: number;
  latestRequestId: number;
  requestedSpanish: string;
  currentSpanish: string;
  currentEnglish: string;
  lastAutomaticEnglish: string;
}

/**
 * A delayed automatic translation may update only the same Spanish selection,
 * and only while the learner has not replaced the last automatic English.
 */
export function shouldApplySelectionTranslation(guard: SelectionTranslationGuard): boolean {
  return guard.requestId === guard.latestRequestId
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
): SelectionEnglishSourceChange {
  const learnerEdited = currentEnglish !== lastAutomaticEnglish;
  return learnerEdited
    ? { english: currentEnglish, lastAutomaticEnglish, learnerEdited }
    : { english: cachedEnglish, lastAutomaticEnglish: cachedEnglish, learnerEdited };
}
