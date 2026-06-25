# Spanish C1 Writing Curriculum Expansion Report

Generated: 2026-06-25T11:30:18

## Result

- Lessons now: 201
- Lesson range: 1–201
- Missing lesson numbers: none
- Total prompts: 14070
- Answer-keyed prompt slots: 11055
- Level distribution: {'C1': 50, 'B2': 70, 'B1': 39, 'A2-B1': 28, 'A1-A2': 11, 'B1-B2': 1, 'A2': 2}

## Curriculum shape

- Lesson 11 filled as a B1→B2 connector bridge.
- Lessons 82–151 add 70 B2 bridge lessons focused on advanced mood, aspect, tense, connectors, register, and sentence-to-paragraph control.
- Lessons 152–201 add 50 C1 composition lessons focused on argument, counterargument, summary, paraphrase, formal email, complaint, opinion, register shifts, cohesion, hedging, causal chains, hypothesis, editing, data commentary, synthesis, and recommendation writing.

## Schema notes

The existing app schema is preserved: id, number, title, difficulty, patternId, tags, targetPattern, englishTrap, spanishLogic, formula, naturalExamples, sections, commonErrors. Sections remain controlled/mutation/contrast/writing/reverse. Open writing prompts intentionally have empty answer arrays so the backend LLM grader evaluates them.

## Human review still recommended

- The new material is deterministic generated curriculum content, not native-teacher-reviewed prose.
- C1 open-writing tasks should be tried in the app and tuned based on Tony's actual misses.
- If the LLM grader is too strict/loose for paragraph tasks, adjust the backend grading rubric rather than weakening the prompts.
