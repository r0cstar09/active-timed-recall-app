# Core 60 verb selector

## Scope
Presentation-only ordering for `/verbs`, using the exact 60 infinitives and order supplied by Tony from *Quantitative Corpus Analysis of the Sixty Most Frequent Spanish Verbs*. This is a learner-selected curriculum; no claim is made that its exact ranks apply universally across corpora.

## Ordering contract
1. Every verb with saved `completed=1` from `/api/study/verb-progress` goes first, including completed verbs outside the Core 60. Preserve catalog order within this section.
2. Remaining Core 60 entries follow the supplied rank, without duplicates of completed verbs.
3. All remaining catalog entries follow, preserving existing relative order.

`src/lib/verbSelection.ts` owns the pure projection. Both the API catalog and the bundled fallback pass through it. No backend catalog rebuild, data migration, threshold recalculation, lesson generation, FSRS change, or progress reset is needed. The raw catalog, conjugation categories, assignments, and user-selected infinitive remain intact.

## UI
Native `optgroup` sections provide actual accessible group boundaries. A visible three-section legend shows counts, a Core 60 counter/progress bar shows saved conjugation completion, and each core option retains its original rank. Completion/usage distinctions are explicit. Catalog outages use the existing bundled fallback; missing progress is an explicit retryable error rather than a false zero-completion result. Missing core entries in a future partial catalog are named and never marked complete.

## Checks
- `npm run test:verbs`: exact independently transcribed 60, completion priority, core ordering, stable remainder, all/none/partial/custom catalog, progress update, object/input immutability, stored legacy completion respected.
- `scripts/test_verb_selector_browser.py`: fixture-only browser behavior with production mutations blocked. Run on the browser worker or CI, not the VPS.
- Standard app regression/build and public immutable-asset gates remain mandatory.

Historical email `rotationCount` is not a daily study schedule or a frequency ranking; the selector now says `Core 60 focus` instead of presenting this field as daily work.
