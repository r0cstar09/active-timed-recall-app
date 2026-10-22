#!/usr/bin/env python3
"""Author a 500-prompt C1 SER usage bank through Hermes only.

Existing output is preserved unless ``--replace-ser`` is supplied.  Cached
chunks are namespaced by the truthful Hermes route, so historical outputs from
other providers cannot be reused or relabeled.
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, cast

try:  # package import during tests; direct import when run as a script
    from .hermes_authoring import HermesAuthoring, duplicate_errors, exclusion_context
except ImportError:  # pragma: no cover - exercised by direct CLI execution
    from hermes_authoring import HermesAuthoring, duplicate_errors, exclusion_context

ROOT = Path(__file__).resolve().parents[1]
VOCAB_CSV = ROOT / "src/data/generated/c1_gap_vocabulary_collocations.csv"
OUT = ROOT / "src/data/generated/c1_verb_usage_banks.json"
REPORT_DIR = ROOT / "reports/ser_usage_llm_generation"
SER_FORMS = re.compile(
    r"\b(soy|eres|es|somos|sois|son|fui|fuiste|fue|fuimos|fuisteis|fueron|"
    r"era|eras|éramos|erais|eran|sea|seas|seamos|seáis|sean|fuera|fueras|"
    r"fuéramos|fuerais|fueran|fuese|fueses|fuésemos|fueseis|fuesen|sería|"
    r"serías|seríamos|seríais|serían|seré|serás|será|seremos|seréis|serán|"
    r"sido|ser)\b",
    re.I,
)

BATCH_PLANS = [
    (1, "Present indicative: identity, role, origin, material, description, and event time/place."),
    (2, "Advanced present: definitions, belonging, authorship, affiliation, clefts, and impersonal evaluations."),
    (3, "Preterite: completed evaluation, cause/identity, bounded passive, and completed event time/place."),
    (4, "Imperfect: background identity, ongoing role, inherent description, origin/material/ownership."),
    (5, "Present subjunctive: evaluations and requirements for qualities, roles, identity, event place/time."),
    (6, "Imperfect subjunctive: si fuera, como si fuera, aunque fuera, and counterfactual descriptions."),
    (7, "Conditional and future: recommendations, predictions, future roles, and event location/time."),
    (8, "Perfect forms: ha sido, había sido, habrá sido, and habría sido."),
    (9, "Natural SER passive voice in administrative, legal, health, and workplace registers."),
    (10, "Mixed C1 review, including SER/ESTAR traps, event location/time, identity/cause, and perfect forms."),
]

REQUIRED_FIELDS = [
    "id", "verb", "batch", "batch_size", "tense", "mood", "difficulty",
    "construction", "prompt_en", "expected_es", "acceptable_answer_pattern",
    "target_vocabulary", "grading_notes", "correction_hint",
]


def load_vocab(path: Path = VOCAB_CSV) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            keys = ("spanish", "english", "domain", "collocations")
            if all(row.get(key, "").strip() for key in keys):
                rows.append({key: row[key].strip() for key in keys})
    if len(rows) < 500:
        raise ValueError(f"too few vocabulary rows: {len(rows)}")
    return rows


def rows_for_batch(rows: list[dict[str, str]], seed: int, n: int = 55) -> list[dict[str, str]]:
    """Select source material deterministically; Hermes authors the sentences."""
    rng = random.Random(9000 + seed)
    by_domain: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        by_domain[row["domain"]].append(row)
    selected: list[dict[str, str]] = []
    domains = sorted(by_domain)
    while len(selected) < n:
        for domain in domains:
            selected.append(rng.choice(by_domain[domain]))
            if len(selected) >= n:
                break
    seen: set[str] = set()
    unique: list[dict[str, str]] = []
    for row in selected:
        key = row["spanish"].casefold()
        if key not in seen:
            seen.add(key)
            unique.append(row)
    return unique[:n]


def prompt_for_chunk(
    batch: int,
    plan: str,
    vocab_rows: list[dict[str, str]],
    start_id: int,
    count: int,
) -> str:
    vocab = "\n".join(
        f"- {row['spanish']} = {row['english']} [{row['domain']}]; collocations: {row['collocations']}"
        for row in vocab_rows
    )
    return f"""You are Hermes, authoring Spanish curriculum for an adult learner.
Return strict JSON only: a bare array of exactly {count} original English-to-Spanish SER exercises.
Coverage: {plan}
IDs must be sequential from ser-usage-{start_id:03d} through ser-usage-{start_id + count - 1:03d}.
Every item must use this exact schema and constants where shown:
{{"id":"ser-usage-NNN","verb":"ser","batch":{batch},"batch_size":50,
"tense":"...","mood":"indicative/conditional|subjunctive|mixed","difficulty":"B2|C1",
"construction":"short label","prompt_en":"Say: ...","expected_es":"one natural Spanish answer",
"acceptable_answer_pattern":null,"target_vocabulary":["Spanish item"],
"grading_notes":"Grade for SER usage: correct ser form, natural construction, agreement, prepositions, and target vocabulary/collocation.",
"correction_hint":"brief explanation of why SER is used"}}
Do not put Spanish in prompt_en. Each answer must contain a correct form/construction of SER and use at least one supplied vocabulary item or close inflection/collocation. Vary subjects, register, domains, length, and construction. Avoid filler, repeated frames, bizarre combinations, and unnatural passive voice.
Source vocabulary:
{vocab}"""


def validate_prompt(item: Any, expected_id: str, batch: int) -> list[str]:
    if not isinstance(item, dict):
        return [f"{expected_id}: item is not an object"]
    errors = [f"{expected_id}: missing {key}" for key in REQUIRED_FIELDS if key not in item]
    if errors:
        return errors
    if item["id"] != expected_id:
        errors.append(f"bad id {item['id']!r}; expected {expected_id}")
    if item["verb"] != "ser" or item["batch"] != batch or item["batch_size"] != 50:
        errors.append(f"{expected_id}: bad verb/batch/batch_size")
    if not isinstance(item["prompt_en"], str) or not item["prompt_en"].startswith("Say:"):
        errors.append(f"{expected_id}: prompt_en must start with Say:")
    if not isinstance(item["expected_es"], str) or not SER_FORMS.search(item["expected_es"]):
        errors.append(f"{expected_id}: expected_es lacks a recognizable SER form")
    if not isinstance(item["target_vocabulary"], list) or not item["target_vocabulary"]:
        errors.append(f"{expected_id}: target_vocabulary must be a non-empty list")
    return errors


def validate_chunk(value: Any, start_id: int, count: int, batch: int) -> list[str]:
    if not isinstance(value, list):
        return [f"batch {batch}: response is not an array"]
    if len(value) != count:
        return [f"batch {batch}: expected {count} items, got {len(value)}"]
    errors: list[str] = []
    for offset, item in enumerate(value):
        errors.extend(validate_prompt(item, f"ser-usage-{start_id + offset:03d}", batch))
    return errors


def validate_bank_prompts(prompts: list[dict[str, Any]]) -> None:
    if len(prompts) != 500:
        raise ValueError(f"expected 500 prompts, got {len(prompts)}")
    errors: list[str] = []
    for index, item in enumerate(prompts, 1):
        errors.extend(validate_prompt(item, f"ser-usage-{index:03d}", (index - 1) // 50 + 1))
    normalized_en = [re.sub(r"\s+", " ", item["prompt_en"].strip()).casefold() for item in prompts]
    normalized_es = [re.sub(r"\s+", " ", item["expected_es"].strip()).casefold() for item in prompts]
    if len(set(normalized_en)) != len(normalized_en):
        errors.append("duplicate English prompts")
    if len(set(normalized_es)) != len(normalized_es):
        errors.append("duplicate Spanish answers")
    if errors:
        raise ValueError("invalid SER bank: " + "; ".join(errors[:30]))


def _load_existing(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"verbs": {}}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("verbs"), dict):
        raise ValueError(f"invalid existing bank: {path}")
    return value


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def generate(
    *,
    authorer: HermesAuthoring | Any | None = None,
    vocab_path: Path = VOCAB_CSV,
    out_path: Path = OUT,
    report_dir: Path = REPORT_DIR,
    replace_ser: bool = False,
) -> dict[str, Any]:
    existing = _load_existing(out_path)
    if "ser" in existing["verbs"] and not replace_ser:
        return {"status": "preserved", "output": str(out_path), "prompts": len(existing["verbs"]["ser"].get("prompts", []))}

    active_authorer = authorer if authorer is not None else HermesAuthoring()
    provenance = active_authorer.provenance()
    cache_dir = report_dir / "cache" / active_authorer.cache_namespace()
    rows = load_vocab(vocab_path)
    prompts: list[dict[str, Any]] = []
    batch_meta: list[dict[str, Any]] = []

    for batch, plan in BATCH_PLANS:
        for chunk in range(5):
            start_id = (batch - 1) * 50 + chunk * 10 + 1
            vocab_rows = rows_for_batch(rows, batch * 10 + chunk)
            request = prompt_for_chunk(batch, plan, vocab_rows, start_id, 10) + exclusion_context(prompts)
            cache_path = cache_dir / f"batch_{batch:02d}_chunk_{chunk + 1}.json"
            value = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else None
            errors = validate_chunk(value, start_id, 10, batch) if value is not None else ["not cached"]
            if not errors:
                errors = duplicate_errors(value, prompts)
            if errors:
                value = active_authorer.generate_json(request, temperature=0.75, max_output_tokens=12000)
                errors = validate_chunk(value, start_id, 10, batch)
                if not errors:
                    errors = duplicate_errors(value, prompts)
                if errors:
                    repair = active_authorer.generate_json(
                        request + "\nYour prior response failed validation. Return the entire corrected array. Errors:\n" + json.dumps(errors, ensure_ascii=False),
                        temperature=0.2,
                        max_output_tokens=12000,
                    )
                    value = repair
                    errors = validate_chunk(value, start_id, 10, batch)
                    if not errors:
                        errors = duplicate_errors(value, prompts)
                if errors:
                    raise ValueError("Hermes returned an invalid chunk: " + "; ".join(errors[:20]))
                _write_json(cache_path, value)
            prompts.extend(cast(list[dict[str, Any]], value))
            batch_meta.append({"batch": batch, "chunk": chunk + 1, "plan": plan, "vocab_rows_supplied": len(vocab_rows)})

    validate_bank_prompts(prompts)
    verbs = existing["verbs"]
    verbs["ser"] = {
        "verb": "ser", "english_base": "be", "category": "irregular",
        "total_prompts": 500, "batch_size": 50, "batches": 10,
        "quality_note": "Hermes-authored C1 SER usage prompts using the C1 gap-vocabulary source.",
        "prompts": prompts,
        "generation": dict(provenance),
    }
    existing.update({
        "source": "hermes/ser-only-c1-gap-vocab-usage-bank",
        "count": len(verbs), "batch_size": 50, "prompts_per_verb": 500,
        "status": "ser_hermes_authored; unrelated verb banks preserved",
        "last_generation": {
            **provenance,
            "scope": "ser",
            "cache_namespace": active_authorer.cache_namespace(),
            "method": "Hermes-authored validated 10-item chunks",
            "vocab_source": str(vocab_path),
            "batch_plans": batch_meta,
        },
    })
    existing.setdefault("generation", dict(existing["last_generation"]))
    report = {
        "prompts": len(prompts),
        "batches": sorted(Counter(item["batch"] for item in prompts).items()),
        "unique_target_vocab": len({word for item in prompts for word in item["target_vocabulary"]}),
        "output": str(out_path),
        "provenance": provenance,
    }
    # Main output/report writes occur only after complete global validation.
    _write_json(out_path, existing)
    _write_json(report_dir / "validation_report.json", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace-ser", action="store_true", help="deliberately replace the saved SER bank")
    args = parser.parse_args()
    print(json.dumps(generate(replace_ser=args.replace_ser), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
