#!/usr/bin/env python3
"""Expand fuzzy_funicular Spanish writing lessons from B1 drills to B2/C1 writing.

This script is deterministic and schema-preserving. It reads the existing
fuzzy_lessons.json, leaves lessons 1-81 untouched, fills the missing lesson 11
with a bridge/review lesson, and adds lessons 82-201.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LESSON_PATH = ROOT / "src/data/generated/fuzzy_lessons.json"
REPORT_PATH = ROOT / "reports/spanish_c1_curriculum_report.md"

CONTEXTS = [
    ("work", "the project", "el proyecto", "the client", "el cliente"),
    ("family", "the plan", "el plan", "my sister", "mi hermana"),
    ("travel", "the trip", "el viaje", "the guide", "la guía"),
    ("health", "the appointment", "la cita", "the doctor", "el médico"),
    ("housing", "the apartment", "el apartamento", "the owner", "la dueña"),
    ("study", "the course", "el curso", "the teacher", "la profesora"),
    ("money", "the budget", "el presupuesto", "the bank", "el banco"),
    ("friendship", "the conversation", "la conversación", "my friend", "mi amigo"),
    ("technology", "the app", "la aplicación", "the team", "el equipo"),
    ("community", "the meeting", "la reunión", "the neighbors", "los vecinos"),
    ("career", "the interview", "la entrevista", "the recruiter", "la reclutadora"),
    ("fitness", "the routine", "la rutina", "the trainer", "el entrenador"),
    ("shopping", "the purchase", "la compra", "the seller", "el vendedor"),
    ("immigration", "the document", "el documento", "the officer", "la funcionaria"),
    ("banking", "the transfer", "la transferencia", "the advisor", "el asesor"),
    ("restaurant", "the reservation", "la reserva", "the waiter", "el camarero"),
    ("transport", "the delay", "el retraso", "the driver", "la conductora"),
    ("education", "the assignment", "la tarea", "the student", "el estudiante"),
    ("security", "the incident", "el incidente", "the analyst", "la analista"),
    ("planning", "the deadline", "el plazo", "the coordinator", "el coordinador"),
]

DOMAIN_ES = {
    "work": "trabajo",
    "family": "familia",
    "travel": "viajes",
    "health": "salud",
    "housing": "vivienda",
    "study": "estudios",
    "money": "finanzas",
    "friendship": "amistad",
    "technology": "tecnología",
    "community": "comunidad",
    "career": "carrera profesional",
    "fitness": "entrenamiento",
    "shopping": "compras",
    "immigration": "trámites migratorios",
    "banking": "banca",
    "restaurant": "restaurantes",
    "transport": "transporte",
    "education": "educación",
    "security": "seguridad",
    "planning": "planificación",
}

B2_TOPICS = [
    ("concession", "Aunque + subjunctive vs indicative", "Use aunque + indicative for known facts and aunque + subjunctive for hypothetical or uncertain limits.", "English overuses even if/even though without marking whether the speaker treats the fact as real.", "Aunque el proyecto es difícil, podemos terminarlo. / Aunque sea difícil, vale la pena intentarlo."),
    ("condition", "Si + imperfect subjunctive + conditional", "Build realistic and counterfactual conditions with si + imperfect subjunctive, then the conditional result.", "English says if I was/were and would; Spanish must separate the condition from the result.", "Si tuviera más tiempo, revisaría el informe con calma."),
    ("purpose", "Para que + subjunctive", "Use para que + subjunctive when the subject changes and purpose depends on someone else acting.", "English uses to/so that loosely; Spanish switches to para que when a new subject appears.", "Te mando el archivo para que puedas revisarlo antes de la llamada."),
    ("time_clauses", "Cuando/en cuanto/hasta que + subjunctive for future", "Use subjunctive after future-facing time connectors, not future tense.", "English says when I will; Spanish says cuando + subjunctive.", "Te aviso en cuanto llegue a casa."),
    ("doubt", "No creo que / Dudo que + subjunctive", "Use subjunctive after negated belief, doubt, or uncertainty.", "English keeps the normal verb after I don't think; Spanish marks the idea as non-asserted.", "No creo que sea una buena solución."),
    ("evaluation", "Es importante/me preocupa que + subjunctive", "Use subjunctive after evaluations, emotion, and subjective reactions.", "English treats the second clause as a plain fact; Spanish marks the speaker's stance.", "Me preocupa que el precio haya subido tanto."),
    ("relative_unknown", "Busco alguien/algo que + subjunctive", "Use subjunctive for unknown, desired, or non-existent antecedents.", "English relative clauses do not show whether the thing/person exists.", "Busco un apartamento que permita mascotas."),
    ("reported_speech", "Reported speech with tense backshift", "Convert direct speech into natural indirect speech with que/si and tense/person/time changes.", "English that can be optional and tense shifts are looser; Spanish needs explicit structure.", "Dijo que no podría venir al día siguiente."),
    ("aspect", "Preterite vs imperfect for narrative framing", "Use imperfect for background/habit/state and preterite for completed foreground events.", "English past tense hides the difference between scene-setting and event movement.", "Llovía cuando salimos del restaurante."),
    ("perfect", "Present perfect vs preterite vs pluperfect", "Choose he hecho, hice, or había hecho depending on current relevance, finished time, or prior past action.", "English present perfect overlaps with simple past; Spanish varieties draw sharper time boundaries.", "Ya había terminado cuando me llamaron."),
    ("se_accidental", "Se me/te/le + verb for accidental events", "Use se + indirect object to soften accidental or unintentional outcomes.", "English says I lost/broke; Spanish often frames the event as something that happened to me.", "Se me perdió la tarjeta en el metro."),
    ("impersonal_se", "Se + third person for impersonal/general claims", "Use se constructions to express general rules, customs, and passive-like statements.", "English uses you/they/people; Spanish often avoids a named subject.", "En esta oficina se trabaja con mucha flexibilidad."),
    ("lo_abstract", "Lo + adjective/participle + es que", "Use lo bueno/lo difícil/lo que pasa es que to package abstract comments naturally.", "English often starts with the thing that is; Spanish packages the evaluation with lo.", "Lo difícil es que nadie explicó el cambio."),
    ("por_para", "Por vs para in arguments", "Choose por for cause/exchange/path and para for goal/deadline/recipient/viewpoint.", "English for covers too many meanings; Spanish forces the relationship.", "Lo hice por necesidad, no para impresionar a nadie."),
    ("connectors", "B2 connectors: sin embargo, aun así, por lo tanto", "Use connectors to show contrast, consequence, and continuation between sentences.", "English writing can rely on order alone; Spanish benefits from explicit discourse markers.", "El plan era arriesgado; aun así, decidimos probarlo."),
    ("register_request", "Polite requests with conditional and imperfect", "Use quería/quisiera/me gustaría/podría to make requests sound diplomatic.", "Direct English-style requests can sound abrupt in Spanish.", "Quisiera saber si sería posible cambiar la cita."),
    ("nominalization", "Nominalizing actions with el hecho de que", "Use el hecho de que + subjunctive/indicative to turn a clause into a discussable idea.", "English often uses the fact that without changing mood; Spanish still marks certainty or judgment.", "El hecho de que no responda me preocupa."),
    ("comparison", "Cuanto más/menos..., más/menos...", "Build proportional comparisons and nuanced cause-effect statements.", "English word order maps poorly to Spanish cuanto constructions.", "Cuanto más practico, menos traduzco mentalmente."),
    ("probability", "Debe de / puede que / quizá + mood", "Express probability with debe de, puede que, quizá, and mood choice.", "English maybe/probably does not force the same grammar decisions.", "Puede que hayan salido ya."),
    ("sequence", "Primero/luego/después/al final narrative sequencing", "Control chronology with clear time markers and tense consistency.", "English sequencing can be vague; Spanish needs explicit temporal anchoring.", "Primero revisé los datos; después, llamé al cliente."),
]

C1_TOPICS = [
    ("argument_structure", "Claim → reason → evidence → implication", "Build compact argumentative paragraphs with a clear thesis, support, and consequence.", "English-speaking learners often list ideas without signaling logical hierarchy in Spanish.", "A mi juicio, la medida es útil porque reduce la incertidumbre; por eso conviene aplicarla gradualmente."),
    ("counterargument", "Admitting and rebutting objections", "Use si bien, es cierto que, no obstante, and eso no significa que to handle opposing views.", "A strong C1 paragraph does not ignore objections; it frames and answers them.", "Si bien el costo inicial es alto, eso no significa que la inversión sea injustificada."),
    ("summary", "Neutral summary without copying", "Summarize a position using afirma, sostiene, señala, plantea, and reformulation.", "Learners often translate sentence by sentence instead of compressing the argument.", "El autor sostiene que la flexibilidad mejora la productividad, aunque advierte que exige coordinación."),
    ("paraphrase", "Paraphrasing with synonyms and syntax changes", "Rewrite the same idea with different structure while preserving meaning and register.", "C1 control means you can express the same thought without copying the original wording.", "La propuesta no elimina el problema; más bien, lo desplaza a otra etapa."),
    ("formal_email", "Formal email: purpose, context, request, closing", "Write concise formal messages with courteous framing and clear asks.", "Literal English emails can sound too blunt or too casual in Spanish.", "Me pongo en contacto con usted para solicitar una aclaración sobre la factura adjunta."),
    ("complaint", "Diplomatic complaint and remedy request", "Describe a problem, provide evidence, and request a concrete solution without sounding aggressive.", "English directness can become rude; Spanish often softens the demand while staying firm.", "Le agradecería que revisaran el cargo y me indicaran cómo proceder."),
    ("opinion", "Balanced opinion paragraph", "State an opinion with nuance, limits, examples, and a final implication.", "C1 writing avoids absolute claims unless they are defended.", "No diría que sea la única solución, pero sí una medida razonable en este contexto."),
    ("register_shift", "Casual → neutral → formal register shifts", "Rewrite the same message for a friend, colleague, or institution.", "Vocabulary and politeness strategies must change with audience.", "¿Me echas una mano? / ¿Podrías ayudarme? / Le agradecería su colaboración."),
    ("cohesion", "Reference chains and avoiding repetition", "Use este/ese/dicho/lo anterior/esta medida to connect ideas without repeating nouns.", "English repetition can sound clumsy in Spanish formal writing.", "Esta medida no resolvería todo, pero sí reduciría el riesgo inicial."),
    ("precision", "Hedging and precision: al parecer, tiende a, no necesariamente", "Avoid overclaiming by using precise qualifiers and probability markers.", "C1 writing often needs controlled uncertainty, not just strong opinions.", "La tendencia parece positiva, aunque no necesariamente garantiza resultados duraderos."),
    ("cause_effect", "Causal chains with debido a, dado que, de ahí que", "Link causes and consequences across sentences with appropriate mood.", "English because/so becomes repetitive; Spanish offers denser causal connectors.", "El plazo se redujo de forma inesperada; de ahí que tuviéramos que priorizar."),
    ("concession_c1", "Complex concession with por mucho que / aun cuando", "Use advanced concession to hold two ideas in tension.", "Learners often overuse aunque and miss more precise C1 options.", "Por mucho que mejore la aplicación, seguirá haciendo falta práctica constante."),
    ("hypothesis", "Hypothesis and speculation in past and present", "Use conditional perfect, pluperfect subjunctive, quizá, and probablemente to speculate.", "English speculation maps poorly to Spanish compound tenses.", "Si lo hubieran explicado antes, habríamos evitado la confusión."),
    ("editing", "Self-editing: remove Englishy phrasing", "Identify literal translations and rewrite them as natural Spanish.", "C1 depends on revision habits, not only first-draft grammar.", "No: hacer una decisión. Sí: tomar una decisión."),
    ("style", "Sentence rhythm: combining and splitting", "Control sentence length with subordination, punctuation, and connectors.", "Advanced writing needs rhythm: not every idea should be a separate short sentence.", "La idea es prometedora, pero, si no se mide bien, puede crear más trabajo del que ahorra."),
    ("data_commentary", "Commenting on trends and evidence", "Describe increases, decreases, contrasts, and cautious interpretations.", "Learners need verbs beyond subir/bajar and claims beyond es bueno/malo.", "Los resultados apuntan a una mejora moderada, aunque la muestra sigue siendo limitada."),
    ("narrative_voice", "Reflective narrative with evaluation", "Tell what happened, why it mattered, and what changed afterward.", "C1 narration includes interpretation, not only a sequence of events.", "Aquella conversación me obligó a replantearme cómo estaba estudiando."),
    ("synthesis", "Synthesis of two viewpoints", "Combine two positions into a fair, concise synthesis with your own conclusion.", "Do not just summarize A then B; explain the relationship between them.", "Ambas posturas coinciden en el problema, pero discrepan sobre el papel de la regulación."),
    ("recommendation", "Recommendation memo", "Diagnose a problem and recommend next steps with justification and caveats.", "C1 workplace writing requires action-oriented structure.", "Recomendaría empezar con una prueba pequeña, siempre que se definan métricas claras."),
    ("rewrite_feedback", "Revision from feedback", "Take critical feedback and produce a cleaner second version.", "The writing loop must train revision, not just answer generation.", "La versión revisada aclara el motivo, reduce la repetición y suaviza el tono."),
]

CONNECTORS = ["sin embargo", "aun así", "por lo tanto", "de hecho", "en cambio", "por eso", "además", "no obstante", "en ese sentido", "al fin y al cabo"]


def sec(instructions: str, prompts: list[str], answers: list[str] | None = None) -> dict:
    return {"instructions": instructions, "prompts": prompts, "answers": answers or []}


def contexts_for(n: int):
    return [CONTEXTS[(n + i) % len(CONTEXTS)] for i in range(20)]


def make_lesson(number: int, level: str, stage: str, topic: tuple[str, str, str, str, str]) -> dict:
    slug, name, logic, trap, example = topic
    ctxs = contexts_for(number)
    connector = CONNECTORS[number % len(CONNECTORS)]
    pattern_id = f"{stage}_{slug}_{number}".upper().replace("-", "_")
    title_prefix = "Spanish C1 Writing" if level == "C1" else "Spanish B2 Bridge"
    title = f"{title_prefix} {number}: {name}"

    controlled_prompts, controlled_answers = [], []
    for i, (domain, en_obj, es_obj, en_actor, es_actor) in enumerate(ctxs[:20], 1):
        if level == "C1":
            controlled_prompts.append(f"[Lesson {number} · {name}] Write a two-sentence Spanish mini-paragraph in a {domain} context. Use the target pattern and add '{connector}' or an equivalent connector to add nuance.")
            controlled_answers.append(f"En el ámbito de {DOMAIN_ES.get(domain, domain)}, {example} {connector.capitalize()}, conviene revisar el contexto antes de sacar una conclusión.")
        else:
            controlled_prompts.append(f"[Lesson {number} · {name}] Write one natural Spanish sentence in a {domain} context that uses the target pattern.")
            controlled_answers.append(f"En el ámbito de {DOMAIN_ES.get(domain, domain)}, {example}")

    mutation_prompts, mutation_answers = [], []
    for i, (domain, en_obj, es_obj, en_actor, es_actor) in enumerate(ctxs[:15], 1):
        mutation_prompts.append(f"[Lesson {number} · {name}] Base: {es_obj.capitalize()} necesita una decisión cuidadosa. -> make it more nuanced in a {domain} context and add '{connector}'.")
        mutation_answers.append(f"{es_obj.capitalize()} necesita una decisión cuidadosa; {connector}, sería mejor escuchar otras opiniones antes de actuar.")

    contrast_prompts, contrast_answers = [], []
    for i, (domain, en_obj, es_obj, en_actor, es_actor) in enumerate(ctxs[:10], 1):
        good = f"{es_obj.capitalize()} no es perfecto; {connector}, puede ser útil si se aplica con cuidado."
        bad = f"{es_obj.capitalize()} no es perfecto y pero puede ser útil con cuidado."
        contrast_prompts.append(f"[Lesson {number} · {name}] Choose the more natural C1/B2 version for {en_obj} in a {domain} context. ({bad} vs {good})")
        contrast_answers.append(good)

    writing_prompts = []
    for i, (domain, en_obj, es_obj, en_actor, es_actor) in enumerate(ctxs[:15], 1):
        if level == "C1":
            writing_prompts.append(
                f"[Lesson {number} · {name}] Write 80-120 words in Spanish about {en_obj} in a {domain} situation. Include: a claim, one reason, one concession, one concrete recommendation, and at least two discourse markers. Keep the tone controlled and natural."
            )
        else:
            writing_prompts.append(
                f"[Lesson {number} · {name}] Write 3-4 connected Spanish sentences about {en_obj} in a {domain} situation. Use the target pattern, one connector, and one contrast or consequence."
            )

    reverse_prompts, reverse_answers = [], []
    for i, (domain, en_obj, es_obj, en_actor, es_actor) in enumerate(ctxs[:10], 1):
        reverse_prompts.append(f"[Lesson {number} · {name}] In a {domain} context: {en_obj.capitalize()} may not solve everything, but it can reduce the first risk if people apply it carefully.")
        reverse_answers.append(f"{es_obj.capitalize()} quizá no lo resuelva todo, pero puede reducir el primer riesgo si la gente lo aplica con cuidado.")

    if level == "C1":
        formula = [
            "claim + because/so that + consequence",
            "concession: si bien / aunque / no obstante",
            "precision: no necesariamente / tiende a / al parecer",
            "recommendation: recomendaría / convendría / sería preferible",
            "revision habit: draft → check register → reduce repetition → strengthen connector logic",
        ]
        common_errors = [
            {"mistake": "Pienso que es bueno y tiene cosas buenas.", "why_it_happens": "The claim is vague and repetitive.", "correct_spanish": "Considero que la medida es útil, aunque su efecto depende de cómo se aplique."},
            {"mistake": "Pero sin embargo", "why_it_happens": "Two contrast connectors are stacked awkwardly.", "correct_spanish": "Sin embargo, todavía hay un riesgo importante."},
            {"mistake": "Es una buena decisión porque sí", "why_it_happens": "The reason is not developed.", "correct_spanish": "Es una decisión razonable porque reduce la incertidumbre inicial."},
            {"mistake": "Yo recomiendo que tú haces", "why_it_happens": "Recommendation with que needs subjunctive.", "correct_spanish": "Recomiendo que lo hagas con más calma."},
            {"mistake": "En mi opinión personal propia", "why_it_happens": "The phrase is redundant.", "correct_spanish": "A mi juicio / En mi opinión."},
        ]
    else:
        formula = [
            "main clause + connector + second clause",
            "subjunctive where uncertainty, purpose, evaluation, or non-existence is active",
            "indicative where the speaker asserts the fact",
            "conditional for polite, hypothetical, or softened claims",
            "one sentence = one function; paragraph = connected functions",
        ]
        common_errors = [
            {"mistake": "Aunque sea difícil, lo terminamos ayer.", "why_it_happens": "Subjunctive is used even though the fact is known and completed.", "correct_spanish": "Aunque fue difícil, lo terminamos ayer."},
            {"mistake": "Para que él puede revisar", "why_it_happens": "Purpose clause with a new subject needs subjunctive.", "correct_spanish": "Para que él pueda revisar."},
            {"mistake": "No creo que es correcto", "why_it_happens": "Negated belief needs subjunctive.", "correct_spanish": "No creo que sea correcto."},
            {"mistake": "Cuando voy mañana", "why_it_happens": "Future time clause takes subjunctive.", "correct_spanish": "Cuando vaya mañana."},
            {"mistake": "Quiero un lugar que permite perros", "why_it_happens": "Unknown desired place takes subjunctive.", "correct_spanish": "Quiero un lugar que permita perros."},
        ]

    return {
        "id": f"lesson-{number}",
        "number": number,
        "title": title,
        "difficulty": level,
        "patternId": pattern_id,
        "tags": ["spanish", "writing-drills", "c1-track", stage.lower(), slug, "paragraph-writing" if level == "C1" else "b2-bridge"],
        "sourceFiles": ["generated/c1-writing-curriculum"],
        "targetPattern": name,
        "englishTrap": trap,
        "spanishLogic": logic,
        "formula": formula,
        "naturalExamples": [
            example,
            f"{connector.capitalize()}, conviene matizar la idea antes de sacar una conclusión.",
            "No se trata de elegir una solución perfecta, sino de reducir el riesgo principal.",
            "Si bien la propuesta tiene límites, puede servir como punto de partida.",
            "Recomendaría revisarlo con calma para evitar una decisión apresurada.",
        ],
        "sections": {
            "controlled": sec("Produce controlled sentences or mini-paragraphs using the target pattern.", controlled_prompts, controlled_answers),
            "mutation": sec("Rewrite the base sentence with more nuance, better connector logic, or a different register.", mutation_prompts, mutation_answers),
            "contrast": sec("Choose the more natural version and notice why the other one sounds Englishy or underdeveloped.", contrast_prompts, contrast_answers),
            "writing": sec("Write connected Spanish. These prompts are intentionally open-ended and should be graded by the LLM grader.", writing_prompts, []),
            "reverse": sec("Translate the meaning into natural Spanish without copying English structure.", reverse_prompts, reverse_answers),
        },
        "commonErrors": common_errors,
    }


def lesson_11() -> dict:
    return make_lesson(11, "B1-B2", "BRIDGE", ("review_connectors", "Connector review: because, although, therefore", "Use connectors to join ideas instead of writing isolated sentence fragments.", "English learners often stack short sentences without showing the relationship between them.", "Quería salir temprano; sin embargo, tuve que esperar la llamada."))


def validate(data: dict) -> list[str]:
    problems = []
    lessons = data["lessons"]
    required_sections = ["controlled", "mutation", "contrast", "writing", "reverse"]
    ids = [l["number"] for l in lessons]
    if len(ids) != len(set(ids)):
        problems.append("duplicate lesson numbers")
    if data.get("count") != len(lessons):
        problems.append(f"count mismatch: {data.get('count')} != {len(lessons)}")
    for l in lessons:
        for key in ["id","number","title","difficulty","patternId","tags","targetPattern","englishTrap","spanishLogic","formula","naturalExamples","sections","commonErrors"]:
            if key not in l:
                problems.append(f"{l.get('id')} missing {key}")
        for name in required_sections:
            secd = l.get("sections", {}).get(name)
            if not secd:
                problems.append(f"{l.get('id')} missing section {name}")
                continue
            prompts, answers = secd.get("prompts", []), secd.get("answers", [])
            if not isinstance(prompts, list) or not prompts:
                problems.append(f"{l.get('id')} {name} has no prompts")
            if name != "writing" and len(prompts) != len(answers):
                problems.append(f"{l.get('id')} {name} prompt/answer mismatch {len(prompts)}/{len(answers)}")
            if name == "writing" and answers not in ([], None) and len(answers) not in (0, len(prompts)):
                problems.append(f"{l.get('id')} writing partial answers")
    return problems


def main() -> None:
    original = json.loads(LESSON_PATH.read_text(encoding="utf-8"))
    existing = {int(l["number"]): l for l in original["lessons"]}
    existing[11] = lesson_11()

    specs = []
    # 70 B2 bridge lessons: repeat B2 topics with different contexts/lesson numbers.
    for number in range(82, 152):
        specs.append((number, "B2", "B2_BRIDGE", B2_TOPICS[(number - 82) % len(B2_TOPICS)]))
    # 50 C1 composition lessons.
    for number in range(152, 202):
        specs.append((number, "C1", "C1_COMPOSITION", C1_TOPICS[(number - 152) % len(C1_TOPICS)]))

    for number, level, stage, topic in specs:
        existing[number] = make_lesson(number, level, stage, topic)

    lessons = [existing[n] for n in sorted(existing.keys(), reverse=True)]
    source_repo = original.get("sourceRepo", "r0cstar09/fuzzy-funicular").split("+c1-writing-curriculum", 1)[0]
    data = {"sourceRepo": f"{source_repo}+c1-writing-curriculum", "count": len(lessons), "lessons": lessons}
    problems = validate(data)
    if problems:
        raise SystemExit("Validation failed:\n" + "\n".join(problems[:50]))

    LESSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    level_counts = Counter(l["difficulty"] for l in lessons)
    prompt_total = sum(len(s["prompts"]) for l in lessons for s in l["sections"].values())
    answer_total = sum(len(s["answers"]) for l in lessons for s in l["sections"].values())
    missing = sorted(set(range(min(existing), max(existing) + 1)) - set(existing))
    REPORT_PATH.write_text(f"""# Spanish C1 Writing Curriculum Expansion Report

Generated: {datetime.now().isoformat(timespec='seconds')}

## Result

- Lessons now: {len(lessons)}
- Lesson range: {min(existing)}–{max(existing)}
- Missing lesson numbers: {missing or 'none'}
- Total prompts: {prompt_total}
- Answer-keyed prompt slots: {answer_total}
- Level distribution: {dict(level_counts)}

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
""", encoding="utf-8")

    print(f"wrote {LESSON_PATH}")
    print(f"wrote {REPORT_PATH}")
    print(f"lessons={len(lessons)} prompts={prompt_total} answers={answer_total} levels={dict(level_counts)} missing={missing}")

if __name__ == "__main__":
    main()
