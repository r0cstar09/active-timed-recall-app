#!/usr/bin/env python3
"""Expand the B2→C1 writing curriculum with Hermes-authored lessons.

Saved lessons are preserved by default.  ``--replace-generated`` deliberately
re-authors lessons 82–201 (or selected ``--lesson`` numbers) through the shared
Hermes-only route.  There is no template-content fallback.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # package import during tests; direct import when run as a script
    from .hermes_authoring import HermesAuthoring
except ImportError:  # pragma: no cover - exercised by direct CLI execution
    from hermes_authoring import HermesAuthoring

ROOT = Path(__file__).resolve().parents[1]
LESSON_PATH = ROOT / "src/data/generated/fuzzy_lessons.json"
REPORT_PATH = ROOT / "reports/spanish_c1_curriculum_report.md"
REQUIRED_SECTIONS = ("controlled", "mutation", "contrast", "writing", "reverse")

# These are curriculum outlines and context only.  They are never emitted as a
# fallback: Hermes authors every new example, exercise prompt, and answer.
B2_SKILLS = [
    ("subjunctive_assertion", "Indicative vs subjunctive: asserted fact or non-asserted idea", "Choose mood from speaker stance, not English form."),
    ("future_time", "Future time clauses without future tense", "Use future time conjunctions with the subjunctive."),
    ("purpose_subject_change", "Purpose clauses with subject change", "Use para que/a fin de que when subjects differ."),
    ("specificity", "Specific vs non-specific people and things", "Mood signals whether a referent is known to exist."),
    ("hypothetical_condition", "Si + imperfect subjunctive + conditional", "Build controlled present/future counterfactuals."),
    ("past_hypothesis", "Si hubiera + participle, habría + participle", "Build past counterfactuals with consistent compound tenses."),
    ("reported_speech", "Reported speech and tense backshift", "Shift person, time reference, and tense consistently."),
    ("preterite_imperfect", "Preterite vs imperfect for narrative control", "Separate background/habit from bounded events."),
    ("perfect_system", "Present perfect, preterite, and pluperfect", "Separate current relevance, completed time, and prior past."),
    ("accidental_se", "Accidental se and responsibility", "Frame genuinely unplanned events idiomatically."),
    ("impersonal_passive_se", "Impersonal/passive se for general claims", "Describe rules and processes without an unnecessary agent."),
    ("lo_abstract", "Lo + adjective/participle/que for abstract comments", "Package evaluations with natural lo constructions."),
    ("por_para_argument", "Por vs para inside arguments", "Mark cause, purpose, recipient, deadline, and viewpoint precisely."),
    ("connector_logic", "Connector logic beyond y/pero/porque", "Make contrast, consequence, concession, and reformulation explicit."),
    ("polite_requests", "Polite requests and softeners", "Control distance with conditional and imperfect softeners."),
    ("nominalization", "Nominalizing clauses with el hecho de que", "Turn propositions into topics while preserving mood."),
    ("proportional_comparison", "Cuanto más/menos..., más/menos...", "Express proportional relationships with Spanish word order."),
    ("probability", "Probability and degrees of certainty", "Match probability markers with mood and certainty."),
    ("sequence", "Sequencing events without monotony", "Control chronology with varied sequencing devices."),
    ("cause_effect", "Causal chains beyond porque", "Link causes and consequences across clauses."),
    ("concession", "Concession with aunque, si bien, aun cuando", "Hold factual or hypothetical ideas in tension."),
    ("reformulation", "Reformulation and self-correction", "Clarify or narrow an idea without restarting."),
    ("emphasis", "Emphasis and focus structures", "Use Spanish focus structures without calquing English clefts."),
    ("pronoun_reference", "Pronoun and reference chains", "Avoid clumsy repetition while keeping references clear."),
    ("relative_precision", "Relative clauses for precision", "Choose relative forms according to function and register."),
    ("register_neutral", "Neutral register for adult writing", "Avoid childish, chatty, or needlessly dramatic phrasing."),
    ("formal_openings", "Formal openings and closings", "Frame institutional correspondence at the right distance."),
    ("complaint_tone", "Firm but diplomatic complaints", "State evidence and remedy clearly without aggression."),
    ("summarizing", "Summarizing without copying", "Compress a source position with attribution and distance."),
    ("opinion_limits", "Opinion with limits and conditions", "Qualify claims by scope, exception, and condition."),
    ("lexical_precision", "Lexical precision beyond vague words", "Replace vague evaluative language with specific verbs and nouns."),
    ("sentence_rhythm", "Sentence rhythm: combine, split, punctuate", "Control pace through syntax and punctuation."),
    ("editing_pass", "Self-editing for English-influenced Spanish", "Replace literal syntax with natural collocations."),
    ("data_commentary_b2", "Basic trend commentary", "Describe trends cautiously and specifically."),
    ("paragraph_cohesion", "Paragraph cohesion and topic sentences", "Give each sentence a clear rhetorical role."),
]

C1_GENRES = [
    ("argument_mini_essay", "Mini-essay argument with thesis and implication", "Build thesis, reason, evidence, concession, and implication."),
    ("counterargument", "Counterargument and rebuttal", "Represent opposition fairly before limiting or refuting it."),
    ("synthesis_two_views", "Synthesis of two viewpoints", "Explain relationships between positions before concluding."),
    ("neutral_summary", "Neutral summary of an article or opinion", "Separate source summary from evaluation."),
    ("paraphrase", "Paraphrase with changed syntax and vocabulary", "Preserve meaning while changing structure and register."),
    ("formal_email", "Formal email: context, request, next step", "Write courteous institutional messages with a concrete ask."),
    ("complaint_remedy", "Complaint with evidence and remedy", "Request a specific correction without sacrificing tone."),
    ("recommendation_memo", "Recommendation memo", "Diagnose, propose steps, justify them, and acknowledge risk."),
    ("data_interpretation", "Data and trend interpretation", "Separate observations from cautious implications."),
    ("problem_solution", "Problem-solution paragraph", "Define the problem, explain causes, and connect response to effect."),
    ("reflective_narrative", "Reflective narrative with interpretation", "Narrate events and explain what changed afterward."),
    ("register_shift", "Register shift: casual, neutral, formal", "Adapt pronouns, vocabulary, and directness to audience."),
    ("diplomatic_disagreement", "Diplomatic disagreement", "Disagree clearly without hostility or evasion."),
    ("hedging_precision", "Hedging and precision", "Limit claims without making them empty."),
    ("cohesion_reference", "Cohesion with reference chains", "Use varied, unambiguous reference expressions."),
    ("causal_complexity", "Complex causal explanation", "Show interacting causes, mediators, and consequences."),
    ("concession_complex", "Complex concession and limitation", "Maintain nuanced tension without contradiction."),
    ("hypothesis_speculation", "Hypothesis and speculation", "Use conditional, probability future, and compound subjunctive precisely."),
    ("style_compression", "Compression: say more with fewer words", "Remove filler while preserving nuance."),
    ("style_expansion", "Expansion: develop an underbuilt idea", "Add support, example, and implication to a thin claim."),
    ("source_integration", "Integrating source information", "Attribute source claims and respond with appropriate distance."),
    ("comparison_evaluation", "Compare two options and choose", "Use criteria and tradeoffs to justify a recommendation."),
    ("definition_scope", "Define a concept and set its scope", "Define, exclude, and apply a key term."),
    ("narrative_argument", "Narrative used as evidence", "Use a brief story as interpreted evidence, not a digression."),
    ("revision_response", "Revision after feedback", "Clarify, soften, reorder, and strengthen a draft from critique."),
]

DOMAIN_CONTEXTS = [
    "workplace deadline", "family decision", "delayed travel", "health routine", "housing cost",
    "exam result", "tight budget", "friendship conflict", "confusing software", "neighborhood issue",
    "job offer", "fitness habit", "defective purchase", "immigration document", "bank fee",
    "restaurant service", "public transport", "education assignment", "security incident", "project plan",
]

SECTION_COUNTS = {
    "B2": {"controlled": 6, "mutation": 8, "contrast": 6, "writing": 5, "reverse": 6},
    "C1": {"controlled": 5, "mutation": 6, "contrast": 5, "writing": 6, "reverse": 5},
}


def outline_for(number: int) -> tuple[str, str, str, str]:
    if 82 <= number <= 151:
        slug, name, logic = B2_SKILLS[(number - 82) % len(B2_SKILLS)]
        return "B2", slug, name, logic
    if 152 <= number <= 201:
        slug, name, logic = C1_GENRES[(number - 152) % len(C1_GENRES)]
        return "C1", slug, name, logic
    raise ValueError("Hermes expansion only authors lessons 82–201")


def authoring_prompt(number: int) -> str:
    difficulty, slug, name, logic = outline_for(number)
    counts = SECTION_COUNTS[difficulty]
    contexts = [DOMAIN_CONTEXTS[(number + offset) % len(DOMAIN_CONTEXTS)] for offset in range(10)]
    return f"""You are Hermes, the sole author of new Spanish curriculum content.
Author lesson {number}, difficulty {difficulty}, focus "{name}" ({slug}). Curriculum logic: {logic}
Adult contexts to draw from naturally: {json.dumps(contexts)}.
Return strict JSON only with exactly this shape:
{{
  "naturalExamples": [exactly 4 original natural Spanish sentences],
  "sections": {{
    "controlled": {{"title":"...","instructions":"...","prompts":[exactly {counts['controlled']} strings],"answers":[exactly {counts['controlled']} strings]}},
    "mutation": {{"title":"...","instructions":"...","prompts":[exactly {counts['mutation']} strings],"answers":[exactly {counts['mutation']} strings]}},
    "contrast": {{"title":"...","instructions":"...","prompts":[exactly {counts['contrast']} strings],"answers":[exactly {counts['contrast']} strings]}},
    "writing": {{"title":"...","instructions":"...","prompts":[exactly {counts['writing']} strings],"answers":[]}},
    "reverse": {{"title":"...","instructions":"...","prompts":[exactly {counts['reverse']} strings],"answers":[exactly {counts['reverse']} strings]}}
  }},
  "commonErrors": [at least 3 objects shaped {{"mistake":"...","why_it_happens":"...","correct_spanish":"..."}}]
}}
Hermes must author every example, exercise prompt, and answer; do not emit template placeholders. Keep the five section keys exactly. Prompts should train noticing/modeling, rewriting, diagnosis/contrast, extended writing, and English-to-natural-Spanish transfer respectively. Answers must be useful model answers or specific rubrics, never generic "answers vary". Make each prompt distinct and prefix it with "[{number} · <short task label>]". Do not duplicate prompts or natural examples. B2 work should bridge toward connected adult writing; C1 work should demand reasoning, cohesion, register, and revision. Open writing is intentionally answerless."""


def _string_list(value: Any, expected: int, label: str, problems: list[str]) -> None:
    if not isinstance(value, list) or len(value) != expected or not all(isinstance(item, str) and item.strip() for item in value):
        problems.append(f"{label} must contain exactly {expected} non-empty strings")


def validate_authored_payload(number: int, payload: Any) -> list[str]:
    problems: list[str] = []
    if not isinstance(payload, dict):
        return [f"lesson-{number}: response is not an object"]
    difficulty, _, _, _ = outline_for(number)
    _string_list(payload.get("naturalExamples"), 4, f"lesson-{number} naturalExamples", problems)
    sections = payload.get("sections")
    if not isinstance(sections, dict) or set(sections) != set(REQUIRED_SECTIONS):
        problems.append(f"lesson-{number}: section keys must be {list(REQUIRED_SECTIONS)}")
        return problems
    all_prompts: list[str] = []
    for name in REQUIRED_SECTIONS:
        section = sections.get(name)
        if not isinstance(section, dict):
            problems.append(f"lesson-{number} {name}: section is not an object")
            continue
        if not isinstance(section.get("title"), str) or not section["title"].strip():
            problems.append(f"lesson-{number} {name}: missing title")
        if not isinstance(section.get("instructions"), str) or not section["instructions"].strip():
            problems.append(f"lesson-{number} {name}: missing instructions")
        count = SECTION_COUNTS[difficulty][name]
        _string_list(section.get("prompts"), count, f"lesson-{number} {name} prompts", problems)
        answer_count = 0 if name == "writing" else count
        _string_list(section.get("answers"), answer_count, f"lesson-{number} {name} answers", problems)
        if isinstance(section.get("prompts"), list):
            all_prompts.extend(item for item in section["prompts"] if isinstance(item, str))
    normalized = [re.sub(r"\s+", " ", item).strip().casefold() for item in all_prompts]
    if len(normalized) != len(set(normalized)):
        problems.append(f"lesson-{number}: duplicate prompts")
    errors = payload.get("commonErrors")
    if not isinstance(errors, list) or len(errors) < 3:
        problems.append(f"lesson-{number}: commonErrors must have at least 3 entries")
    else:
        for index, item in enumerate(errors):
            if not isinstance(item, dict) or any(not isinstance(item.get(key), str) or not item[key].strip() for key in ("mistake", "why_it_happens", "correct_spanish")):
                problems.append(f"lesson-{number}: invalid commonErrors[{index}]")
    return problems


def build_lesson(number: int, payload: dict[str, Any]) -> dict[str, Any]:
    difficulty, slug, name, logic = outline_for(number)
    cycle = (number - (82 if difficulty == "B2" else 152)) // (len(B2_SKILLS) if difficulty == "B2" else len(C1_GENRES)) + 1
    title_prefix = "Spanish B2→C1 Bridge" if difficulty == "B2" and cycle == 1 else "Spanish B2→C1 Integration" if difficulty == "B2" else "Spanish C1 Composition" if cycle == 1 else "Spanish C1 Performance"
    return {
        "id": f"lesson-{number}", "number": number, "title": f"{title_prefix} {number}: {name}",
        "difficulty": difficulty,
        "patternId": f"{'B2_C1_BRIDGE' if difficulty == 'B2' else 'C1_COMPOSITION'}_{slug}_{number}".upper(),
        "tags": ["spanish", "writing", "hermes-authored", difficulty.casefold(), slug.replace("_", "-")],
        "sourceFiles": ["generated/hermes-c1-writing-curriculum-v3"],
        "targetPattern": name,
        "englishTrap": "Do not select Spanish structure by word-for-word English translation.",
        "spanishLogic": logic,
        "formula": ["Notice and name the function", "Rewrite for natural Spanish", "Diagnose grammar and register", "Build connected reasoning", "Revise and transfer meaning"],
        "naturalExamples": payload["naturalExamples"],
        "sections": payload["sections"],
        "commonErrors": payload["commonErrors"],
    }


def author_lesson(number: int, authorer: HermesAuthoring | Any) -> dict[str, Any]:
    request = authoring_prompt(number)
    payload = authorer.generate_json(request, temperature=0.55, max_output_tokens=20000)
    problems = validate_authored_payload(number, payload)
    if problems:
        payload = authorer.generate_json(
            request + "\nReturn the entire corrected object. Validation errors:\n" + json.dumps(problems, ensure_ascii=False),
            temperature=0.15,
            max_output_tokens=20000,
        )
        problems = validate_authored_payload(number, payload)
    if problems:
        raise ValueError("Hermes returned an invalid lesson: " + "; ".join(problems[:30]))
    return build_lesson(number, payload)


def validate(data: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    lessons = data.get("lessons")
    if not isinstance(lessons, list) or not lessons:
        return ["lessons must be a non-empty list"]
    numbers = [int(lesson["number"]) for lesson in lessons if isinstance(lesson, dict) and isinstance(lesson.get("number"), int)]
    if data.get("count") != len(lessons):
        problems.append(f"count mismatch: {data.get('count')} != {len(lessons)}")
    if len(numbers) != len(set(numbers)):
        problems.append("duplicate lesson numbers")
    if not numbers or sorted(numbers) != list(range(min(numbers), max(numbers) + 1)):
        problems.append("lesson numbers are not contiguous")
    required = ("id", "number", "title", "difficulty", "patternId", "tags", "targetPattern", "englishTrap", "spanishLogic", "formula", "naturalExamples", "sections", "commonErrors")
    for lesson in lessons:
        if not isinstance(lesson, dict):
            problems.append("lesson is not an object")
            continue
        for key in required:
            if key not in lesson:
                problems.append(f"{lesson.get('id')} missing {key}")
        sections = lesson.get("sections", {})
        for name in REQUIRED_SECTIONS:
            section = sections.get(name) if isinstance(sections, dict) else None
            if not isinstance(section, dict):
                problems.append(f"{lesson.get('id')} missing section {name}")
                continue
            prompts, answers = section.get("prompts"), section.get("answers")
            if not isinstance(prompts, list) or not prompts:
                problems.append(f"{lesson.get('id')} {name} has no prompts")
            if not isinstance(answers, list):
                problems.append(f"{lesson.get('id')} {name} answers is not a list")
            elif name != "writing" and isinstance(prompts, list) and len(prompts) != len(answers):
                problems.append(f"{lesson.get('id')} {name} prompt/answer mismatch")
            elif name == "writing" and answers:
                problems.append(f"{lesson.get('id')} writing must remain answerless")
    return problems


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def expand_curriculum(
    *,
    authorer: HermesAuthoring | Any | None = None,
    lesson_path: Path = LESSON_PATH,
    report_path: Path = REPORT_PATH,
    replace_generated: bool = False,
    lesson_numbers: list[int] | None = None,
) -> dict[str, Any]:
    original = json.loads(lesson_path.read_text(encoding="utf-8"))
    if not replace_generated:
        return {"status": "preserved", "output": str(lesson_path), "lessons": original.get("count", len(original.get("lessons", [])))}

    selected = sorted(set(lesson_numbers if lesson_numbers is not None else range(82, 202)))
    if not selected or any(number < 82 or number > 201 for number in selected):
        raise ValueError("replacement lesson numbers must be within 82–201")
    active_authorer = authorer if authorer is not None else HermesAuthoring()
    provenance = active_authorer.provenance()
    by_number = {int(lesson["number"]): lesson for lesson in original["lessons"]}
    authored: list[dict[str, Any]] = []
    for number in selected:
        lesson = author_lesson(number, active_authorer)
        lesson["authoring"] = dict(provenance)
        by_number[number] = lesson
        authored.append(lesson)

    data = dict(original)
    data["lessons"] = [by_number[number] for number in sorted(by_number, reverse=True)]
    data["count"] = len(data["lessons"])
    base_repo = str(original.get("sourceRepo", "r0cstar09/fuzzy-funicular")).split("+c1-writing-curriculum", 1)[0].split("+hermes-c1-writing-curriculum", 1)[0]
    data["sourceRepo"] = f"{base_repo}+hermes-c1-writing-curriculum-v3"
    data["last_authoring"] = {**provenance, "lesson_numbers": selected, "method": "one validated Hermes call per replacement lesson, with at most one repair"}
    data.setdefault("authoring", dict(data["last_authoring"]))
    problems = validate(data)
    normalized_prompts = [
        re.sub(r"\s+", " ", prompt).strip().casefold()
        for lesson in authored for section in lesson["sections"].values() for prompt in section["prompts"]
    ]
    if len(normalized_prompts) != len(set(normalized_prompts)):
        problems.append("duplicate prompt text across newly authored lessons")
    if problems:
        raise ValueError("Validation failed: " + "; ".join(problems[:80]))

    prompt_total = sum(len(section["prompts"]) for lesson in data["lessons"] for section in lesson["sections"].values())
    report = f"""# Spanish C1 Writing Curriculum Expansion Report

Generated: {datetime.now(timezone.utc).isoformat(timespec='seconds')}

- Saved lessons preserved unless explicitly selected: yes
- Hermes-authored lessons replaced: {len(selected)}
- Lesson numbers replaced: {', '.join(map(str, selected))}
- Lessons now: {len(data['lessons'])}
- Total prompts: {prompt_total}
- Authoring backend/provider/model: {provenance['backend']} / {provenance['provider']} / {provenance['model']}
- Validation: passed before output write
"""
    # Both writes are deferred until every selected lesson and the full file pass validation.
    _write_json(lesson_path, data)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report, encoding="utf-8")
    return {"status": "written", "output": str(lesson_path), "lessons": len(data["lessons"]), "replaced": selected, "provenance": provenance}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace-generated", action="store_true", help="deliberately author replacement content")
    parser.add_argument("--lesson", action="append", type=int, dest="lessons", help="replace one lesson (repeatable; default 82–201)")
    args = parser.parse_args()
    result = expand_curriculum(replace_generated=args.replace_generated, lesson_numbers=args.lessons)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
