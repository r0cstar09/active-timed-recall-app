#!/usr/bin/env python3
"""Generate a SER-only 500-prompt verb usage bank with live LLM calls.

Non-deterministic content rule: Python only parses CSV, selects source vocab,
validates schema, and writes JSON. The Spanish/English sentence content is made
by the LLM batch-by-batch.
"""
from __future__ import annotations

import csv
import json
import os
import random
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
VOCAB_CSV = ROOT / "src/data/generated/c1_gap_vocabulary_collocations.csv"
OUT = ROOT / "src/data/generated/c1_verb_usage_banks.json"
REPORT_DIR = ROOT / "reports/ser_usage_llm_generation"
REPORT_DIR.mkdir(parents=True, exist_ok=True)
PROXY_URL = os.getenv("SPANISH_LLM_PROXY", "http://34.24.121.154:8787/v1/chat/completions")
MODEL = os.getenv("SPANISH_LLM_MODEL", "gemini-2.5-flash")
SER_FORMS = re.compile(r"\b(soy|eres|es|somos|sois|son|fui|fuiste|fue|fuimos|fuisteis|fueron|era|eras|éramos|erais|eran|sea|seas|seamos|seáis|sean|fuera|fueras|fuéramos|fuerais|fueran|fuese|fueses|fuésemos|fueseis|fuesen|sería|serías|seríamos|seríais|serían|seré|serás|será|seremos|seréis|serán|sido|ser)\b", re.I)

BATCH_PLANS = [
    (1, "Present indicative core: identity/classification, profession/role, origin/source with ser de, material with ser de, inherent description, event time/place. Include time/date/price-like uses where natural."),
    (2, "Present indicative advanced: definitions, ownership/belonging with ser de, authorship, ideological/organizational affiliation, cleft emphasis (lo que... es...), impersonal evaluations (es clave que...)."),
    (3, "Preterite: completed evaluation, event/cause identification, one-off role, bounded passive voice with fue/fueron + participle, completed event time/place."),
    (4, "Imperfect: past background identity, ongoing role/profession, habitual/inherent description, era de origin/material/ownership, contextual descriptions that should not use estar."),
    (5, "Present subjunctive: es importante/necesario/probable/dudoso que sea/sean; requirements for qualities, roles, identity, event location/time not yet fixed."),
    (6, "Imperfect subjunctive: si fuera/fueran, como si fuera, aunque fuera, no porque fuera; hypotheticals and counterfactual descriptions."),
    (7, "Conditional and future: sería/serían for recommendations and polite evaluations; será/serán for predictions, future roles, future event location/time."),
    (8, "Perfect forms: ha sido/han sido, había sido, habrá sido, habría sido; result up to now, prior cause, future retrospective probability, counterfactual evaluation."),
    (9, "Ser passive voice and formal registers: es/fue/será/ha sido + participle by an agent; administrative/legal/medical/workplace contexts; avoid unnatural overuse."),
    (10, "Mixed C1 review: all ser uses interleaved, especially ser vs estar traps, event location/time, origin/material, identity/cause, passive voice, subjunctive/perfect forms."),
]

SYSTEM = """You are a senior Spanish curriculum writer for an adult C1 learner.
Generate natural, useful English-to-Spanish production prompts for verb-usage practice.
The target verb is SER only. Use C1-ish but practical real-world vocabulary from the supplied CSV rows.
Do not make template filler. Do not force weird combinations. Prefer adult domains: legal, admin, health, housing, work, transport, money, family obligations, safety, tech, repairs, education.
Return strict JSON only, no markdown.
"""


def load_vocab():
    rows = []
    with VOCAB_CSV.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if all(row.get(k, "").strip() for k in ["spanish", "english", "domain", "collocations"]):
                rows.append({k: row[k].strip() for k in ["spanish", "english", "domain", "collocations"]})
    if len(rows) < 500:
        raise SystemExit(f"too few vocab rows: {len(rows)}")
    return rows


def rows_for_batch(rows, batch, n=170):
    # deterministic source selection is allowed; it only feeds LLM raw materials.
    rng = random.Random(9000 + batch)
    by_domain = defaultdict(list)
    for r in rows:
        by_domain[r["domain"]].append(r)
    priority = ["legal", "admin", "health", "housing", "work", "transport", "money", "family", "safety", "tech", "repairs", "education", "environment", "food", "clothing", "travel", "community", "errands"]
    selected = []
    domains = priority + [d for d in sorted(by_domain) if d not in priority]
    while len(selected) < n:
        progressed = False
        for d in domains:
            pool = by_domain[d]
            if not pool:
                continue
            selected.append(rng.choice(pool))
            progressed = True
            if len(selected) >= n:
                break
        if not progressed:
            break
    # de-dupe by spanish preserving order
    seen, out = set(), []
    for r in selected:
        key = r["spanish"].lower()
        if key not in seen:
            out.append(r); seen.add(key)
    return out[:n]


def call_llm(messages, temperature=0.85, max_tokens=16000):
    payload = {"model": MODEL, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
    last = None
    for attempt in range(1, 5):
        try:
            resp = requests.post(PROXY_URL, json=payload, timeout=180)
            if resp.status_code == 200:
                data = resp.json()
                return data["choices"][0]["message"]["content"]
            last = f"HTTP {resp.status_code}: {resp.text[:500]}"
        except Exception as e:
            last = repr(e)
        time.sleep(2 * attempt)
    raise RuntimeError(f"LLM call failed: {last}")


def extract_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"(\[.*\]|\{.*\})", text, re.S)
        if not m:
            raise
        return json.loads(m.group(1))


def prompt_for_batch(batch, plan, vocab_rows, start_id=None, count=50):
    start_id = start_id or ((batch - 1) * 50 + 1)
    end_id = start_id + count - 1
    vocab_block = "\n".join(
        f"- {r['spanish']} = {r['english']} [{r['domain']}]; collocations: {r['collocations']}"
        for r in vocab_rows
    )
    return f"""
Generate exactly {count} JSON objects for batch {batch}/10 of a 500-prompt SER usage bank.

Batch coverage plan: {plan}

Hard requirements:
- Every object must be original, natural, and useful for Tony to practice SER after finishing conjugations.
- Use SER as the required target; expected_es must contain the correct ser form/construction.
- The prompt_en should be an English command starting with "Say: ...".
- expected_es should be one natural Spanish answer, not multiple alternatives.
- Use at least one supplied CSV vocabulary item or a close collocation in each sentence. Many prompts can use 2.
- Do NOT reveal Spanish in prompt_en.
- Avoid deterministic-feeling repeated frames. Vary subject, register, domain, sentence length, and construction.
- Include C1-worthy contexts, but keep each prompt speakable in one sentence.
- Avoid weird semantic pairings, random adjective+noun combos, and legal/medical jargon when it would be unnatural.

JSON schema for each object:
{{
  "id": "ser-usage-001",
  "verb": "ser",
  "batch": {batch},
  "batch_size": 50,
  "tense": "Present|Preterite|Imperfect|Present Subjunctive|Imperfect Subjunctive|Conditional|Future|Present Perfect|Pluperfect|Future Perfect|Conditional Perfect|Mixed",
  "mood": "indicative/conditional|subjunctive|mixed",
  "difficulty": "B2|C1",
  "construction": "short label of ser use",
  "prompt_en": "Say: ...",
  "expected_es": "...",
  "acceptable_answer_pattern": null,
  "target_vocabulary": ["exact CSV Spanish item(s), without article if inflected naturally"],
  "grading_notes": "Grade for SER usage: correct ser form, natural construction, agreement, prepositions, and target vocabulary/collocation.",
  "correction_hint": "Brief explanation of why SER is used here."
}}

Set ids sequentially from ser-usage-{start_id:03d} to ser-usage-{end_id:03d}.
Return a bare JSON array of exactly {count} objects.

Supplied CSV vocabulary rows:
{vocab_block}
"""


def validate_prompt(p, expected_id, batch):
    required = ["id", "verb", "batch", "batch_size", "tense", "mood", "difficulty", "construction", "prompt_en", "expected_es", "acceptable_answer_pattern", "target_vocabulary", "grading_notes", "correction_hint"]
    missing = [k for k in required if k not in p]
    if missing:
        return f"{expected_id}: missing {missing}"
    if p["id"] != expected_id:
        return f"bad id {p['id']} expected {expected_id}"
    if p["verb"] != "ser" or p["batch"] != batch or p["batch_size"] != 50:
        return f"{expected_id}: bad verb/batch/batch_size"
    if not str(p["prompt_en"]).startswith("Say:"):
        return f"{expected_id}: prompt_en must start Say:"
    if not SER_FORMS.search(str(p["expected_es"])):
        return f"{expected_id}: expected_es lacks obvious ser form"
    if not isinstance(p["target_vocabulary"], list) or not p["target_vocabulary"]:
        return f"{expected_id}: missing target vocabulary list"
    return None


def repair_batch(batch, plan, arr, errors, vocab_rows, start_id, count):
    msg = f"""
You generated batch {batch}, but validation found these errors:
{json.dumps(errors[:80], ensure_ascii=False, indent=2)}

Return the entire corrected chunk as a bare JSON array of exactly {count} objects. Preserve good items where possible, fix IDs/schema, and keep content natural.
Original batch:
{json.dumps(arr, ensure_ascii=False)}
"""
    text = call_llm([{"role":"system","content":SYSTEM}, {"role":"user","content":prompt_for_batch(batch, plan, vocab_rows, start_id=start_id, count=count)}, {"role":"assistant","content":json.dumps(arr, ensure_ascii=False)}, {"role":"user","content":msg}], temperature=0.55)
    return extract_json(text)


def generate():
    rows = load_vocab()
    all_prompts = []
    raw_meta = []
    for batch, plan in BATCH_PLANS:
        # 10-item chunks keep Gemini responses well under truncation/malformed-JSON limits.
        for chunk in range(5):
            start_id = (batch - 1) * 50 + chunk * 10 + 1
            count = 10
            vocab_rows = rows_for_batch(rows, batch * 10 + chunk, n=55)
            cache_path = REPORT_DIR / f"batch_{batch:02d}_chunk_{chunk+1}_parsed.json"
            repaired_path = REPORT_DIR / f"batch_{batch:02d}_chunk_{chunk+1}_repaired.json"
            raw_path = REPORT_DIR / f"batch_{batch:02d}_chunk_{chunk+1}_raw.txt"
            if cache_path.exists():
                arr = json.loads(cache_path.read_text(encoding="utf-8"))
                print(f"using cached batch {batch} chunk {chunk+1}/5", flush=True)
            elif repaired_path.exists():
                arr = json.loads(repaired_path.read_text(encoding="utf-8"))
                print(f"using repaired batch {batch} chunk {chunk+1}/5", flush=True)
            elif raw_path.exists():
                print(f"parsing existing raw batch {batch} chunk {chunk+1}/5", flush=True)
                arr = extract_json(raw_path.read_text(encoding="utf-8"))
                if isinstance(arr, dict) and "prompts" in arr:
                    arr = arr["prompts"]
            else:
                messages = [{"role":"system","content":SYSTEM}, {"role":"user","content":prompt_for_batch(batch, plan, vocab_rows, start_id=start_id, count=count)}]
                print(f"calling LLM for batch {batch} chunk {chunk+1}/5...", flush=True)
                text = call_llm(messages, max_tokens=12000)
                raw_path.write_text(text, encoding="utf-8")
                arr = extract_json(text)
                if isinstance(arr, dict) and "prompts" in arr:
                    arr = arr["prompts"]
            errors = []
            if not isinstance(arr, list) or len(arr) != count:
                errors.append(f"batch {batch} chunk {chunk+1}: expected {count} array items got {type(arr).__name__} {len(arr) if isinstance(arr,list) else 'n/a'}")
            else:
                for i, p in enumerate(arr, start=start_id):
                    err = validate_prompt(p, f"ser-usage-{i:03d}", batch)
                    if err:
                        errors.append(err)
            if errors:
                print(f"repairing batch {batch} chunk {chunk+1}: {len(errors)} validation errors", flush=True)
                arr = repair_batch(batch, plan, arr, errors, vocab_rows, start_id, count)
                (REPORT_DIR / f"batch_{batch:02d}_chunk_{chunk+1}_repaired.json").write_text(json.dumps(arr, ensure_ascii=False, indent=2), encoding="utf-8")
            if not isinstance(arr, list) or len(arr) != count:
                raise RuntimeError(f"batch {batch} chunk {chunk+1} not {count} after repair")
            final_errors = []
            for i, p in enumerate(arr, start=start_id):
                err = validate_prompt(p, f"ser-usage-{i:03d}", batch)
                if err:
                    final_errors.append(err)
            if final_errors:
                raise RuntimeError(f"batch {batch} chunk {chunk+1} still invalid: {final_errors[:10]}")
            cache_path.write_text(json.dumps(arr, ensure_ascii=False, indent=2), encoding="utf-8")
            all_prompts.extend(arr)
            raw_meta.append({"batch": batch, "chunk": chunk+1, "plan": plan, "vocab_rows_supplied": len(vocab_rows)})

    # Global validation / light normalization of metadata only, not sentence content.
    seen_es, seen_en = set(), set()
    dupes = []
    for p in all_prompts:
        es = re.sub(r"\s+", " ", p["expected_es"].strip().lower())
        en = re.sub(r"\s+", " ", p["prompt_en"].strip().lower())
        if es in seen_es or en in seen_en:
            dupes.append(p["id"])
        seen_es.add(es); seen_en.add(en)
    if dupes:
        raise RuntimeError(f"duplicate prompt/answer ids: {dupes[:20]}")

    tense_counts = Counter(p["tense"] for p in all_prompts)
    construction_counts = Counter(p["construction"] for p in all_prompts)
    vocab_counter = Counter(v for p in all_prompts for v in p["target_vocabulary"])
    bank = {
        "source": "llm/ser-only-c1-gap-vocab-usage-bank",
        "count": 1,
        "batch_size": 50,
        "prompts_per_verb": 500,
        "status": "only_ser_llm_generated_reviewed; other verbs intentionally not generated yet",
        "generation": {
            "model": MODEL,
            "proxy_url": PROXY_URL,
            "method": "10 live LLM calls, one per 50-prompt batch; Python used only for CSV parsing, validation, and JSON assembly",
            "vocab_source": str(VOCAB_CSV),
            "batch_plans": raw_meta,
        },
        "verbs": {
            "ser": {
                "verb": "ser",
                "english_base": "be",
                "category": "irregular",
                "total_prompts": 500,
                "batch_size": 50,
                "batches": 10,
                "quality_note": "LLM-generated SER usage prompts using C1 gap vocabulary CSV; batch-sized for app presentation and reviewed by validation checks.",
                "prompts": all_prompts,
            }
        },
    }
    OUT.write_text(json.dumps(bank, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report = {
        "prompts": len(all_prompts),
        "batches": sorted(Counter(p["batch"] for p in all_prompts).items()),
        "tense_counts": tense_counts.most_common(),
        "top_constructions": construction_counts.most_common(40),
        "unique_target_vocab": len(vocab_counter),
        "top_target_vocab": vocab_counter.most_common(30),
        "output": str(OUT),
    }
    (REPORT_DIR / "validation_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    generate()
