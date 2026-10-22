#!/usr/bin/env python3
"""Author an easy-first 500-item SER bank through Hermes only.

The command is import-safe and preserves the saved bank unless --replace-ser is
explicitly supplied.  A prior C1 SER bank is retained as ``ser_advanced``.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, cast

try:  # package import during tests; direct import when run as a script
    from .hermes_authoring import HermesAuthoring, duplicate_errors, exclusion_context
except ImportError:  # pragma: no cover - exercised by direct CLI execution
    from hermes_authoring import HermesAuthoring, duplicate_errors, exclusion_context

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src/data/generated/c1_verb_usage_banks.json"
REPORT = ROOT / "reports/ser_usage_leveling_report.json"
CACHE_ROOT = ROOT / "reports/ser_usage_leveled_generation/cache"
SER_FORMS = re.compile(
    r"\b(soy|eres|es|somos|sois|son|fui|fuiste|fue|fuimos|fuisteis|fueron|"
    r"era|eras|éramos|erais|eran|sea|seas|seamos|seáis|sean|fuera|fueras|"
    r"fuéramos|fuerais|fueran|sería|serías|seríamos|seríais|serían|seré|"
    r"serás|será|seremos|seréis|serán|sido|ser)\b",
    re.I,
)
REQUIRED = [
    "id", "verb", "batch", "batch_size", "level", "tense", "mood",
    "difficulty", "construction", "prompt_en", "expected_es",
    "acceptable_answer_pattern", "target_vocabulary", "grading_notes",
    "correction_hint",
]
LEVELS = [
    {"name": "easy", "start": 1, "end": 200, "batches": [1, 2, 3, 4], "description": "short present-tense identity, description, nationality, material, event time/place"},
    {"name": "medium", "start": 201, "end": 350, "batches": [5, 6, 7], "description": "source, purpose, ownership, simple cause/identity"},
    {"name": "past", "start": 351, "end": 425, "batches": [8, 9], "description": "fue, era, and ha sido in short sentences"},
    {"name": "advanced_intro", "start": 426, "end": 500, "batches": [9, 10], "description": "short subjunctive, conditional, future, and natural passive introduction"},
]


def level_for_index(index: int) -> str:
    for level in LEVELS:
        if level["start"] <= index <= level["end"]:
            return str(level["name"])
    raise ValueError(f"index outside SER bank: {index}")


def _chunks() -> list[tuple[int, int]]:
    chunks: list[tuple[int, int]] = []
    start = 1
    boundaries = {51, 101, 151, 201, 251, 301, 351, 401, 426, 451, 501}
    while start <= 500:
        count = min(10, 501 - start)
        crossing = sorted(boundary for boundary in boundaries if start < boundary < start + count)
        if crossing:
            count = crossing[0] - start
        chunks.append((start, count))
        start += count
    return chunks


def authoring_prompt(start: int, count: int) -> str:
    end = start + count - 1
    level = level_for_index(start)
    batch = (start - 1) // 50 + 1
    description = next(item["description"] for item in LEVELS if item["name"] == level)
    return f"""You are Hermes, authoring an easy-first Spanish SER curriculum for an adult learner.
Return strict JSON only: a bare array of exactly {count} distinct exercise objects.
IDs: ser-usage-{start:03d} through ser-usage-{end:03d}. Level: {level}. Focus: {description}.
Every item must use this schema:
{{"id":"ser-usage-NNN","verb":"ser","batch":{batch},"batch_size":50,"level":"{level}",
"tense":"Present|Preterite|Imperfect|Present Perfect|Present Subjunctive|Imperfect Subjunctive|Conditional|Future|Mixed",
"mood":"indicative/conditional|subjunctive|mixed","difficulty":"A1|A1/A2|A2|A2/B1|B1|B1/B2",
"construction":"short label","prompt_en":"Say: ...","expected_es":"one natural Spanish answer",
"acceptable_answer_pattern":null,"target_vocabulary":["Spanish target"],
"grading_notes":"Grade for the required SER use, correct form, agreement, and target vocabulary. Do not require accents for pass/fail.",
"correction_hint":"short learner-friendly SER explanation"}}
Hermes must author every prompt and answer. Keep them natural, speakable, age-appropriate, and genuinely distinct. Do not reveal Spanish in prompt_en. Every answer must contain SER. Keep easy items short; add complexity only at the stated level. Do not create uniqueness by adding meaningless context prefixes."""


def validate_item(value: Any, index: int) -> list[str]:
    expected_id = f"ser-usage-{index:03d}"
    if not isinstance(value, dict):
        return [f"{expected_id}: not an object"]
    errors = [f"{expected_id}: missing {field}" for field in REQUIRED if field not in value]
    if errors:
        return errors
    expected_batch = (index - 1) // 50 + 1
    if value["id"] != expected_id:
        errors.append(f"{expected_id}: wrong id {value['id']!r}")
    if value["verb"] != "ser" or value["batch"] != expected_batch or value["batch_size"] != 50:
        errors.append(f"{expected_id}: wrong verb/batch/batch_size")
    if value["level"] != level_for_index(index):
        errors.append(f"{expected_id}: wrong level {value['level']!r}")
    if not isinstance(value["prompt_en"], str) or not value["prompt_en"].startswith("Say:"):
        errors.append(f"{expected_id}: prompt_en must start with Say:")
    if not isinstance(value["expected_es"], str) or not SER_FORMS.search(value["expected_es"]):
        errors.append(f"{expected_id}: expected_es lacks SER")
    if not isinstance(value["target_vocabulary"], list) or not value["target_vocabulary"]:
        errors.append(f"{expected_id}: target_vocabulary must be non-empty")
    return errors


def validate_chunk(value: Any, start: int, count: int) -> list[str]:
    if not isinstance(value, list):
        return [f"chunk {start}: response is not an array"]
    if len(value) != count:
        return [f"chunk {start}: expected {count}, got {len(value)}"]
    errors: list[str] = []
    for offset, item in enumerate(value):
        errors.extend(validate_item(item, start + offset))
    return errors


def validate_prompts(prompts: list[dict[str, Any]]) -> None:
    if len(prompts) != 500:
        raise ValueError(f"expected 500 prompts, got {len(prompts)}")
    errors: list[str] = []
    for index, item in enumerate(prompts, 1):
        errors.extend(validate_item(item, index))
    english = [re.sub(r"\s+", " ", item["prompt_en"]).casefold() for item in prompts]
    spanish = [re.sub(r"\s+", " ", item["expected_es"]).casefold() for item in prompts]
    if len(set(english)) != 500:
        errors.append("duplicate prompt_en values")
    if len(set(spanish)) != 500:
        errors.append("duplicate expected_es values")
    expected_levels = {"easy": 200, "medium": 150, "past": 75, "advanced_intro": 75}
    if Counter(item["level"] for item in prompts) != Counter(expected_levels):
        errors.append("level distribution does not match 200/150/75/75")
    if errors:
        raise ValueError("invalid leveled SER bank: " + "; ".join(errors[:40]))


def _read_bank(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"verbs": {}}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("verbs"), dict):
        raise ValueError(f"invalid bank at {path}")
    return value


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def generate_leveled_bank(
    *,
    authorer: HermesAuthoring | Any | None = None,
    out_path: Path = OUT,
    report_path: Path = REPORT,
    cache_root: Path = CACHE_ROOT,
    replace_ser: bool = False,
) -> dict[str, Any]:
    existing = _read_bank(out_path)
    verbs: dict[str, Any] = existing["verbs"]
    if "ser" in verbs and not replace_ser:
        return {"status": "preserved", "output": str(out_path), "total_prompts": len(verbs["ser"].get("prompts", []))}

    active_authorer = authorer if authorer is not None else HermesAuthoring()
    provenance = active_authorer.provenance()
    cache_dir = cache_root / active_authorer.cache_namespace()
    prompts: list[dict[str, Any]] = []
    for start, count in _chunks():
        cache_path = cache_dir / f"ser_{start:03d}_{start + count - 1:03d}.json"
        value: Any = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else None
        errors = validate_chunk(value, start, count) if value is not None else ["not cached"]
        if not errors:
            errors = duplicate_errors(value, prompts)
        if errors:
            request = authoring_prompt(start, count) + exclusion_context(prompts)
            value = active_authorer.generate_json(request, temperature=0.65, max_output_tokens=10000)
            errors = validate_chunk(value, start, count)
            if not errors:
                errors = duplicate_errors(value, prompts)
            if errors:
                value = active_authorer.generate_json(
                    request + "\nCorrect and return the complete array. Validation errors:\n" + json.dumps(errors, ensure_ascii=False),
                    temperature=0.15,
                    max_output_tokens=10000,
                )
                errors = validate_chunk(value, start, count)
                if not errors:
                    errors = duplicate_errors(value, prompts)
            if errors:
                raise ValueError("Hermes returned an invalid leveled chunk: " + "; ".join(errors[:20]))
            _write_json(cache_path, value)
        prompts.extend(cast(list[dict[str, Any]], value))

    validate_prompts(prompts)
    old_ser = verbs.get("ser")
    if isinstance(old_ser, dict) and "c1" in str(old_ser.get("quality_note", "")).casefold() and "ser_advanced" not in verbs:
        preserved = dict(old_ser)
        preserved["verb"] = "ser_advanced"
        preserved["quality_note"] = "Advanced/C1 SER bank preserved from the prior generation; not served as the first unlocked SER bank."
        verbs["ser_advanced"] = preserved

    verbs["ser"] = {
        "verb": "ser", "english_base": "be", "category": "irregular",
        "total_prompts": 500, "batch_size": 50, "batches": 10,
        "levels": [{key: value for key, value in level.items() if key not in ("start", "end")} for level in LEVELS],
        "quality_note": "Hermes-authored leveled SER usage bank: easy batches first; prior C1 bank preserved separately when present.",
        "prompts": prompts,
        "generation": dict(provenance),
    }
    existing.update({
        "source": "hermes/ser-leveled-usage-bank",
        "count": len(verbs), "batch_size": 50, "prompts_per_verb": 500,
        "status": "ser_leveled_easy_first; prior c1 bank preserved as ser_advanced",
        "last_generation": {**provenance, "scope": "ser", "cache_namespace": active_authorer.cache_namespace(), "method": "Hermes-authored validated chunks of at most 10 items"},
    })
    existing.setdefault("generation", dict(existing["last_generation"]))
    word_counts = [len(re.findall(r"\w+", item["expected_es"], re.UNICODE)) for item in prompts]
    report = {
        "output": str(out_path), "total_prompts": 500,
        "duplicate_prompt_en": 0, "duplicate_expected_es": 0,
        "batch_counts": sorted(Counter(item["batch"] for item in prompts).items()),
        "level_counts": Counter(item["level"] for item in prompts).most_common(),
        "spanish_word_count_avg": round(sum(word_counts) / len(word_counts), 2),
        "spanish_word_count_max": max(word_counts), "provenance": provenance,
    }
    # Do not touch the main bank or report until the complete bank validates.
    _write_json(out_path, existing)
    _write_json(report_path, report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace-ser", action="store_true", help="deliberately replace the saved SER bank")
    args = parser.parse_args()
    print(json.dumps(generate_leveled_bank(replace_ser=args.replace_ser), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
