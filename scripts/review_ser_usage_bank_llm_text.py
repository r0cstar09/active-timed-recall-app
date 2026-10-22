#!/usr/bin/env python3
"""Review a saved SER bank through Hermes and emit a textual QA report."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

try:  # package import during tests; direct import when run as a script
    from .hermes_authoring import HermesAuthoring
except ImportError:  # pragma: no cover - exercised by direct CLI execution
    from hermes_authoring import HermesAuthoring

ROOT = Path(__file__).resolve().parents[1]
BANK = ROOT / "src/data/generated/c1_verb_usage_banks.json"
OUT = ROOT / "reports/ser_usage_llm_generation/llm_quality_review_text.md"


def compact_batch(prompts: list[dict[str, Any]], batch: int) -> str:
    lines: list[str] = []
    for prompt in prompts:
        if prompt.get("batch") == batch:
            vocabulary = prompt.get("target_vocabulary", [])
            lines.append(
                f"{prompt.get('id')} | {prompt.get('tense')} | {prompt.get('construction')} | "
                f"EN: {prompt.get('prompt_en')} | ES: {prompt.get('expected_es')} | "
                f"vocab: {', '.join(map(str, vocabulary))}"
            )
    if not lines:
        raise ValueError(f"SER bank has no prompts for batch {batch}")
    return "\n".join(lines)


def review_prompt(batch: int, compact: str) -> str:
    return f"""You are Hermes acting as a concise Spanish curriculum QA reviewer.
Review SER usage-bank batch {batch}. Flag only clear fix-before-study issues: wrong or unnatural Spanish, English mismatch, wrong SER use, an obvious ESTAR/TENER/HABER error, bizarre semantics, target-vocabulary misuse, or Spanish leaked into the English prompt.
Return strict JSON only with exactly one key: {{"report":"..."}}.
The report value must be plain text in this exact format:
FIXES: NONE
OVERALL: one sentence
Or, when fixes exist:
FIXES:
- ser-usage-NNN: issue; suggested Spanish: ...
OVERALL: one sentence
Do not include markdown fences or any other JSON keys.

Prompts:
{compact}"""


def validate_review(value: Any, batch: int) -> str:
    if not isinstance(value, dict) or set(value) != {"report"}:
        raise ValueError(f"batch {batch}: review must be exactly {{report: string}}")
    report = value["report"]
    if not isinstance(report, str) or not report.strip():
        raise ValueError(f"batch {batch}: report must be a non-empty string")
    text = report.strip()
    if not text.startswith("FIXES:") or "\nOVERALL:" not in text:
        raise ValueError(f"batch {batch}: report does not use the required textual format")
    return text


def review_bank(
    *,
    authorer: HermesAuthoring | Any | None = None,
    bank_path: Path = BANK,
    out_path: Path = OUT,
) -> dict[str, Any]:
    bank = json.loads(bank_path.read_text(encoding="utf-8"))
    prompts = bank.get("verbs", {}).get("ser", {}).get("prompts")
    if not isinstance(prompts, list) or not prompts:
        raise ValueError("SER prompts are missing")
    batches = sorted({prompt.get("batch") for prompt in prompts if isinstance(prompt.get("batch"), int)})
    if not batches:
        raise ValueError("SER prompts have no integer batches")

    active_authorer = authorer if authorer is not None else HermesAuthoring()
    provenance = active_authorer.provenance()
    reports: list[tuple[int, str]] = []
    for batch in batches:
        request = review_prompt(batch, compact_batch(prompts, batch))
        value = active_authorer.generate_json(request, temperature=0.1, max_output_tokens=4000)
        reports.append((batch, validate_review(value, batch)))

    parts = [
        "# SER usage bank Hermes QA review",
        "",
        f"backend: {provenance['backend']}",
        f"provider: {provenance['provider']}",
        f"model: {provenance['model']}",
    ]
    fix_lines: list[str] = []
    for batch, report in reports:
        parts.extend(("", f"## Batch {batch}", "", report))
        fix_lines.extend(line.strip() for line in report.splitlines() if line.strip().startswith("- ser-usage-"))
    # Do not leave a partial review if any batch response is invalid.
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(parts) + "\n", encoding="utf-8")
    return {"output": str(out_path), "batches": len(reports), "fix_lines": len(fix_lines), "provenance": provenance}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    print(json.dumps(review_bank(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
