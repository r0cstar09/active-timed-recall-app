# Spanish Maintenance Authoring Policy

## Authority

All newly created Spanish curriculum sentences, exercise prompts, model answers, translations, examples, corrections, and suggested replacement text must be authored through the backend `content_generation.generate_json` Hermes route.

Maintenance scripts resolve that route from `SPANISH_AUTHORING_BACKEND_DIR` when explicitly set, otherwise from `/home/rootadmin/hermes-spanish/current`. They fail closed if `content_generation.py`, its route, or truthful provenance is unavailable. They must not call a legacy checkout, direct model HTTP endpoint, proxy, Google-family provider, or deterministic sentence template as a fallback.

## Preservation

Saved lesson and usage-bank content is immutable by default. Generation commands require an explicit replacement flag before changing existing content. Replacing one bank or lesson must preserve unrelated verbs, lessons, and an existing `ser_advanced` bank. Existing legacy provenance is historical and must never be relabeled as Hermes output.

## Generation and validation

- Use strict JSON and bounded requests.
- Record backend, provider, and model from the active Hermes route.
- Namespace reusable caches by the complete authoring route; never consume an unnamespaced legacy cache.
- Include accepted earlier prompts/answers in later batch requests and reject cross-batch duplicates before proceeding, including cached chunks.
- Attach new provenance to the replaced verb/lesson and scope the last-run metadata. Preserve historical root provenance rather than relabeling retained material as Hermes-authored.
- Validate IDs, schema, counts, levels/batches, required Spanish forms, and duplicate prompt/answer text before writing the main output.
- Treat curriculum outlines and saved examples as context only, never as output fallback.
- Complete every requested batch before writing a report or main content file; an invalid or failed batch leaves saved content unchanged.

## Reviews

Editorial reviews also use Hermes. Review responses use strict JSON with a single `report` string so the existing human-readable Markdown report remains available without accepting free-form transport output.
