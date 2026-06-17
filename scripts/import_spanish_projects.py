#!/usr/bin/env python3
"""Generate static frontend data from Tony's local Spanish repos.

Source repos:
- /home/rootadmin/Spanish-daily-verb-project
- /home/rootadmin/fuzzy-funicular

Run from active-timed-recall-app root after pulling those repos.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERB_REPO = Path('/home/rootadmin/Spanish-daily-verb-project')
FUZZY_REPO = Path('/home/rootadmin/fuzzy-funicular')
OUT = ROOT / 'src' / 'data' / 'generated'


def write_json(name: str, data) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def load_json(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def all_verbs(rotation: list[str], by_category: dict[str, list[str]]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for verb in rotation:
        if verb not in seen:
            seen.add(verb)
            ordered.append(verb)
    for verbs in by_category.values():
        for verb in verbs:
            if verb not in seen:
                seen.add(verb)
                ordered.append(verb)
    return ordered


def build_verbs() -> None:
    sys.path.insert(0, str(VERB_REPO))
    from tenses import TENSES  # type: ignore
    from verb_selector import PRONOUNS  # type: ignore
    from translations import get_english_translation, get_english_base  # type: ignore

    rotation = load_json(VERB_REPO / 'verbs.json')
    by_category = load_json(VERB_REPO / 'verbs_by_category.json')
    hints = load_json(VERB_REPO / 'verb_usage_hints.json')

    data = []
    rotation_set = set(rotation)
    for verb in all_verbs(rotation, by_category):
        category = next((k for k, vals in by_category.items() if verb in vals), 'uncategorized')
        assignments = []
        for tense in TENSES:
            for idx, pronoun in enumerate(PRONOUNS):
                assignments.append({
                    'pronoun': pronoun,
                    'tense': tense,
                    'translation': get_english_translation(verb, idx, tense),
                })
        data.append({
            'verb': verb,
            'englishBase': get_english_base(verb),
            'category': category,
            'inDailyRotation': verb in rotation_set,
            'usageHint': hints.get(verb, ''),
            'assignments': assignments,
        })

    write_json('verbs.json', {
        'sourceRepo': 'r0cstar09/Spanish-daily-verb-project',
        'count': len(data),
        'rotationCount': len(rotation_set),
        'tenses': TENSES,
        'pronouns': PRONOUNS,
        'verbs': data,
    })


def lesson_number(path: Path) -> int:
    m = re.search(r'lesson-(\d+)', str(path))
    return int(m.group(1)) if m else -1


def first_list(obj: dict, keys: list[str]) -> list[str]:
    for key in keys:
        v = obj.get(key)
        if isinstance(v, list):
            return [str(x) for x in v]
    return []


def build_lessons() -> None:
    lessons = []
    mismatches: list[str] = []
    for json_path in sorted((FUZZY_REPO / 'lessons').glob('lesson-*/lesson.json'), key=lesson_number, reverse=True):
        raw = load_json(json_path)
        lesson = raw.get('lesson', {}) if isinstance(raw.get('lesson'), dict) else {}
        cognitive = lesson.get('cognitive_shift', {}) if isinstance(lesson.get('cognitive_shift'), dict) else {}
        controlled = lesson.get('controlled_recombination', {}) if isinstance(lesson.get('controlled_recombination'), dict) else {}
        mutation = lesson.get('pattern_mutation', {}) if isinstance(lesson.get('pattern_mutation'), dict) else {}
        contrast = lesson.get('contrastive_discrimination', {}) if isinstance(lesson.get('contrastive_discrimination'), dict) else {}
        reverse = lesson.get('reverse_conceptual_expression', {}) if isinstance(lesson.get('reverse_conceptual_expression'), dict) else {}
        writing = lesson.get('guided_personal_writing', {}) if isinstance(lesson.get('guided_personal_writing'), dict) else {}
        answer_key = lesson.get('answer_key', {}) if isinstance(lesson.get('answer_key'), dict) else {}

        lesson_md = json_path.with_name('lesson.md')
        title = f"Lesson {lesson_number(json_path)}"
        if lesson_md.exists():
            for line in lesson_md.read_text(encoding='utf-8', errors='ignore').splitlines():
                if line.startswith('#'):
                    title = line.lstrip('#').strip() or title
                    break

        lessons.append({
            'id': json_path.parent.name,
            'number': lesson_number(json_path),
            'title': title,
            'difficulty': raw.get('difficulty', ''),
            'patternId': raw.get('pattern_id', ''),
            'tags': raw.get('tags', []),
            'sourceFiles': raw.get('source_files', []),
            'targetPattern': raw.get('target_pattern', ''),
            'englishTrap': cognitive.get('english_trap', ''),
            'spanishLogic': cognitive.get('spanish_logic', ''),
            'formula': cognitive.get('target_pattern_formula', []),
            'naturalExamples': cognitive.get('natural_examples', []),
            'sections': {
                'controlled': {
                    'instructions': controlled.get('instructions', ''),
                    'prompts': first_list(controlled, ['prompts_en', 'prompts']),
                    'answers': answer_key.get('controlled_recombination', []),
                },
                'mutation': {
                    'instructions': mutation.get('instructions', ''),
                    'prompts': first_list(mutation, ['drills', 'prompts']),
                    'answers': answer_key.get('pattern_mutation', []),
                },
                'contrast': {
                    'instructions': contrast.get('instructions', ''),
                    'prompts': first_list(contrast, ['prompts']),
                    'answers': answer_key.get('contrastive_discrimination', []),
                },
                'writing': {
                    'instructions': writing.get('instructions', ''),
                    'prompts': first_list(writing, ['prompts']),
                    'answers': answer_key.get('guided_personal_writing', []),
                },
                'reverse': {
                    'instructions': reverse.get('instructions', ''),
                    'prompts': first_list(reverse, ['prompts_en', 'prompts']),
                    'answers': answer_key.get('reverse_conceptual_expression', []),
                },
            },
            'commonErrors': lesson.get('common_errors', []),
        })

        # Prompts and answers are aligned by index downstream (the grader and
        # the answer-key reveal both look up answers[idx]). If the source arrays
        # disagree in length, prompts silently get the wrong (or empty) expected
        # answer, so surface it loudly at generation time.
        for name, sec in lessons[-1]['sections'].items():
            prompts, answers = sec['prompts'], sec['answers']
            if prompts and answers and len(prompts) != len(answers):
                mismatches.append(
                    f"{lessons[-1]['id']}/{name}: {len(prompts)} prompts vs {len(answers)} answers"
                )

    if mismatches:
        print(f'[warn] {len(mismatches)} lesson section(s) have prompt/answer length mismatches:')
        for line in mismatches:
            print(f'  - {line}')

    write_json('fuzzy_lessons.json', {
        'sourceRepo': 'r0cstar09/fuzzy-funicular',
        'count': len(lessons),
        'lessons': lessons,
    })


if __name__ == '__main__':
    build_verbs()
    build_lessons()
    print(f'Wrote generated Spanish data to {OUT}')
