import assert from "node:assert/strict";
import test from "node:test";
import {
  selectionEnglishAfterSourceChange,
  shouldApplySelectionTranslation,
  selectionTranslationCanSave,
} from "../src/lib/selectionTranslation.ts";

test("automatic selection translation accepts only the latest matching Spanish request", () => {
  const base = {
    latestRequestId: 7,
    requestedSpanish: "Te lo habría dicho.",
    currentSpanish: "Te lo habría dicho.",
    currentEnglish: "",
    lastAutomaticEnglish: "",
  };
  assert.equal(shouldApplySelectionTranslation({ ...base, requestId: 7 }), true);
  assert.equal(shouldApplySelectionTranslation({ ...base, requestId: 6 }), false);
  assert.equal(
    shouldApplySelectionTranslation({ ...base, requestId: 7, currentSpanish: "Ya te lo dije." }),
    false,
  );
});

test("automatic translation never overwrites an English meaning edited by the learner", () => {
  const base = {
    requestId: 8,
    latestRequestId: 8,
    requestedSpanish: "Dímelo.",
    currentSpanish: "Dímelo.",
    lastAutomaticEnglish: "Tell it to me.",
  };
  assert.equal(
    shouldApplySelectionTranslation({ ...base, currentEnglish: "Tell me that." }),
    false,
  );
  assert.equal(
    shouldApplySelectionTranslation({ ...base, currentEnglish: "Tell it to me." }),
    true,
  );
});

test("saving requires current exact translation or explicit English after failure", () => {
  const base = { spanish: "Dímelo.", english: "Tell me.", translationSource: "Dímelo.", status: "ready", learnerEdited: false };
  assert.equal(selectionTranslationCanSave(base), true);
  for (const status of ["idle", "loading", "failed"]) {
    assert.equal(selectionTranslationCanSave({ ...base, status }), false);
  }
  assert.equal(selectionTranslationCanSave({ ...base, spanish: "Ya te lo dije." }), false);
  assert.equal(selectionTranslationCanSave({ ...base, english: " " }), false);
  assert.equal(selectionTranslationCanSave({ ...base, status: "loading", learnerEdited: true }), false);
  assert.equal(selectionTranslationCanSave({ ...base, status: "failed", learnerEdited: true }), true);
});

test("explicit learner ownership survives equality with the previous automatic value", () => {
  assert.equal(shouldApplySelectionTranslation({ requestId: 1, latestRequestId: 1, requestedSpanish: "Hola", currentSpanish: "Hola", currentEnglish: "Hello", lastAutomaticEnglish: "Hello", learnerEdited: true }), false);
  assert.equal(selectionEnglishAfterSourceChange("Hello", "Hello", "Hello there", true).english, "Hello");
});

test("expanding or replacing the Spanish span preserves learner-authored English", () => {
  assert.deepEqual(
    selectionEnglishAfterSourceChange("My own meaning", "Automatic meaning", "Cached combined meaning"),
    {
      english: "My own meaning",
      lastAutomaticEnglish: "Automatic meaning",
      learnerEdited: true,
    },
  );
  assert.deepEqual(
    selectionEnglishAfterSourceChange("Automatic meaning", "Automatic meaning", "Cached combined meaning"),
    {
      english: "Cached combined meaning",
      lastAutomaticEnglish: "Cached combined meaning",
      learnerEdited: false,
    },
  );
});
