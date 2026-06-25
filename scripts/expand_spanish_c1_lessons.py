#!/usr/bin/env python3
"""Build a stronger B2->C1 Spanish writing curriculum for the lesson notebook.

The first 81 imported lessons are preserved. Lesson 11 is filled if absent.
Lessons 82-151 become B2 writing-control bridges. Lessons 152-201 become
C1 composition lessons. The generated sections keep the app's existing section
keys, but the prompts no longer imitate the original fuzzy-funicular categories;
they train noticing, rewriting, diagnosis, composition, and transfer.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LESSON_PATH = ROOT / "src/data/generated/fuzzy_lessons.json"
REPORT_PATH = ROOT / "reports/spanish_c1_curriculum_report.md"

DOMAIN_CONTEXTS = [
    ("work", "a missed deadline", "un plazo incumplido", "a manager", "un jefe"),
    ("family", "a difficult decision", "una decisión difícil", "a relative", "un familiar"),
    ("travel", "a delayed trip", "un viaje retrasado", "a passenger", "un pasajero"),
    ("health", "a change in routine", "un cambio de rutina", "a doctor", "una médica"),
    ("housing", "a rent increase", "una subida del alquiler", "a landlord", "una propietaria"),
    ("study", "an exam result", "un resultado de examen", "a teacher", "una profesora"),
    ("money", "a tight budget", "un presupuesto ajustado", "a client", "un cliente"),
    ("friendship", "a tense conversation", "una conversación tensa", "a friend", "un amigo"),
    ("technology", "a confusing app", "una aplicación confusa", "a support team", "un equipo de soporte"),
    ("community", "a neighborhood problem", "un problema del barrio", "a neighbor", "una vecina"),
    ("career", "a job offer", "una oferta de trabajo", "a recruiter", "una reclutadora"),
    ("fitness", "an inconsistent habit", "un hábito irregular", "a coach", "un entrenador"),
    ("shopping", "a defective product", "un producto defectuoso", "a seller", "una vendedora"),
    ("immigration", "a missing document", "un documento pendiente", "an official", "una funcionaria"),
    ("banking", "an unexpected fee", "un cargo inesperado", "an adviser", "un asesor"),
    ("restaurant", "a poor service experience", "una mala experiencia de servicio", "a waiter", "un camarero"),
    ("transport", "an unreliable route", "una ruta poco fiable", "a driver", "una conductora"),
    ("education", "a confusing assignment", "una tarea confusa", "a student", "un estudiante"),
    ("security", "a small incident", "un incidente menor", "an analyst", "una analista"),
    ("planning", "a risky plan", "un plan arriesgado", "a coordinator", "un coordinador"),
]

CONNECTORS = [
    "sin embargo", "aun así", "por lo tanto", "de hecho", "en cambio",
    "por eso", "además", "no obstante", "en ese sentido", "al fin y al cabo",
    "dicho esto", "por una parte", "por otra parte", "de ahí que", "a medida que",
]

B2_SKILLS = [
    ("subjunctive_assertion", "Indicative vs subjunctive: asserted fact or non-asserted idea", "Decide whether the speaker presents the idea as fact, doubt, desire, emotion, purpose, or future condition.", "English lets many subordinate clauses look identical; Spanish forces the speaker's stance into the verb mood.", "No creo que sea tarde, pero sé que tenemos poco margen."),
    ("future_time", "Future time clauses without future tense", "Use cuando, en cuanto, hasta que, antes de que, and después de que with subjunctive for future events.", "English says 'when I will'; Spanish normally says 'cuando + subjunctive'.", "Te avisaré en cuanto tenga una respuesta."),
    ("purpose_subject_change", "Purpose clauses with subject change", "Use para que/a fin de que + subjunctive when one person acts so another can do something.", "English 'to/so that' hides whether the subject changed.", "Lo escribí con claridad para que el equipo pudiera revisarlo rápido."),
    ("specificity", "Specific vs non-specific people/things", "Use indicative for known existing referents and subjunctive for desired, unknown, or non-existent ones.", "English relative clauses do not mark whether the thing exists.", "Busco una solución que sea sencilla, no la solución que usamos ayer."),
    ("hypothetical_condition", "Si + imperfect subjunctive + conditional", "Build realistic counterfactuals and polite hypotheticals without mixing tenses.", "English 'if I was/were' often tempts learners into present or conditional inside the si-clause.", "Si tuviera más datos, tomaría una decisión más firme."),
    ("past_hypothesis", "Si hubiera + participle, habría + participle", "Explain what would have happened under a different past condition.", "English past hypotheticals are long; Spanish needs tight compound-tense control.", "Si lo hubiéramos sabido antes, habríamos cambiado el plan."),
    ("reported_speech", "Reported speech and tense backshift", "Turn direct quotes/questions into indirect speech with changed person, time markers, and tense.", "English often drops 'that'; Spanish needs que/si and consistent deictic shifts.", "Dijo que no podría venir al día siguiente."),
    ("preterite_imperfect", "Preterite vs imperfect for narrative control", "Use imperfect for background, habits, and states; preterite for bounded events that move the story.", "English simple past hides scene-setting vs event movement.", "Estaba lloviendo cuando salimos del restaurante."),
    ("perfect_system", "Present perfect, preterite, and pluperfect", "Choose between current relevance, completed past time, and earlier past action.", "English present perfect overlaps with simple past more than Spanish does in many registers.", "Ya había terminado el informe cuando me llamaron."),
    ("accidental_se", "Accidental se and responsibility", "Use se me/te/le to frame unplanned events naturally without overusing active blame.", "English 'I lost/broke' can sound too accusatory or literal in Spanish.", "Se me borró el archivo antes de enviarlo."),
    ("impersonal_passive_se", "Impersonal/passive se for general claims", "Use se + third person to describe rules, customs, and process steps without naming an agent.", "English uses people/you/they too often.", "En esa oficina se trabaja con bastante autonomía."),
    ("lo_abstract", "Lo + adjective/participle/que for abstract comments", "Package evaluations with lo bueno, lo difícil, lo que pasa es que, and lo importante.", "English 'the thing is' maps poorly unless you learn the lo structure.", "Lo importante es que el mensaje quede claro."),
    ("por_para_argument", "Por vs para inside arguments", "Use por for cause, exchange, path, and motive; para for purpose, recipient, deadline, and viewpoint.", "English 'for' hides the logical relationship.", "Lo hice por necesidad, no para impresionar a nadie."),
    ("connector_logic", "Connector logic beyond y/pero/porque", "Choose connectors that express contrast, consequence, concession, continuation, or reformulation.", "English writing can lean on sentence order; Spanish needs explicit discourse signals.", "La idea es útil; no obstante, habría que aplicarla con cuidado."),
    ("polite_requests", "Polite requests and softeners", "Use quería, quisiera, me gustaría, agradecería, podría, and sería posible for tactful requests.", "Direct English-style requests can sound abrupt.", "Quisiera saber si sería posible cambiar la fecha."),
    ("nominalization", "Nominalizing clauses with el hecho de que", "Turn a full clause into a discussable issue while preserving mood.", "English 'the fact that' does not solve the Spanish mood choice.", "El hecho de que no responda me preocupa."),
    ("proportional_comparison", "Cuanto más/menos..., más/menos...", "Build proportional relationships and nuanced cause-effect statements.", "Word-for-word English ordering breaks this structure.", "Cuanto más practico, menos traduzco mentalmente."),
    ("probability", "Probability: debe de, puede que, quizá, seguramente", "Express probability with the right mood and degree of certainty.", "Maybe/probably in English does not force the same grammatical choices.", "Puede que hayan salido ya, aunque no estoy seguro."),
    ("sequence", "Sequencing events without monotony", "Use primero, luego, más tarde, al final, mientras tanto, and una vez que to control chronology.", "Repeated entonces makes writing sound childish.", "Primero revisé los datos; después, llamé al cliente."),
    ("cause_effect", "Causal chains with debido a, dado que, ya que, de ahí que", "Link causes and consequences across clauses without repeating porque.", "English because/so becomes repetitive and flat.", "El plazo se redujo; de ahí que tuviéramos que priorizar."),
    ("concession", "Concession with aunque, si bien, aun cuando", "Hold two ideas in tension and show whether the concession is factual or hypothetical.", "Learners overuse pero and lose nuance.", "Si bien la propuesta tiene límites, puede servir como punto de partida."),
    ("reformulation", "Reformulation: es decir, o sea, mejor dicho, en otras palabras", "Clarify or correct an idea without starting over.", "Advanced writing often improves through reformulation, not more vocabulary.", "No fue un fracaso; mejor dicho, fue una prueba incompleta."),
    ("emphasis", "Emphasis and focus: lo que..., fue/era", "Move the focus of a sentence without sounding translated.", "English cleft structures map only partly to Spanish.", "Lo que más me preocupó fue la falta de comunicación."),
    ("pronoun_reference", "Pronoun/reference chains", "Use este, eso, dicha medida, lo anterior, and el primero/la segunda to avoid repetition.", "Repeating the same noun in every sentence sounds clumsy.", "Dicha decisión no resolvió todo, pero sí redujo el riesgo."),
    ("relative_precision", "Relative clauses for precision", "Use donde, cuyo, lo cual, que, quien, and el/la cual in controlled ways.", "English 'which/that/whose' choices do not transfer cleanly.", "Fue una decisión difícil, lo cual explica la demora."),
    ("register_neutral", "Neutral register for everyday adult writing", "Avoid chatty, childish, or overly dramatic phrasing in practical messages.", "Literal translations can sound either too blunt or too informal.", "Me parece una opción razonable, aunque convendría revisar los detalles."),
    ("formal_openings", "Formal openings and closings", "Open, frame, request, and close an email with the right level of distance.", "English email habits often sound too casual in Spanish.", "Me pongo en contacto con usted para solicitar una aclaración."),
    ("complaint_tone", "Firm but diplomatic complaints", "Describe a problem, evidence, and remedy without sounding aggressive.", "Directness must be softened without making the request vague.", "Le agradecería que revisaran el cargo y me indicaran cómo proceder."),
    ("summarizing", "Summarizing without copying", "Compress someone else's position using sostiene, señala, plantea, destaca, and advierte.", "Copying phrases is not the same as summarizing.", "El autor sostiene que la flexibilidad mejora el rendimiento, aunque exige coordinación."),
    ("opinion_limits", "Opinion with limits and conditions", "State a view, then qualify it with scope, exception, or condition.", "C1-ish writing avoids absolute claims unless they are defended.", "No diría que sea la única solución, pero sí una medida razonable."),
    ("lexical_precision", "Lexical precision: evitar bueno/malo/cosa/hacer", "Replace vague words with specific verbs and nouns.", "A lot of learner writing stalls at general vocabulary.", "La medida reduce el riesgo inicial, aunque no elimina el problema de fondo."),
    ("sentence_rhythm", "Sentence rhythm: combine, split, punctuate", "Control sentence length with subordination, semicolons, and connector placement.", "Short translated sentences create a choppy rhythm.", "La idea es prometedora, pero, si no se mide bien, puede crear más trabajo."),
    ("editing_pass", "Self-editing for Englishy Spanish", "Find literal phrases and rewrite them with natural Spanish collocations.", "First drafts often carry English syntax even when grammar is correct.", "No tomé una decisión rápidamente; preferí pensarlo con calma."),
    ("data_commentary_b2", "Basic trend commentary", "Describe increases, decreases, comparisons, and cautious interpretations.", "Subir/bajar is not enough for serious commentary.", "Los resultados apuntan a una mejora moderada."),
    ("paragraph_cohesion", "Paragraph cohesion and topic sentences", "Make each sentence serve a role: topic, support, concession, consequence, or recommendation.", "Learners often list related sentences without a paragraph spine.", "La prioridad debería ser reducir la confusión inicial."),
]

C1_GENRES = [
    ("argument_mini_essay", "Mini-essay argument with thesis and implication", "Build a compact argument: thesis, reason, evidence, concession, implication.", "Listing opinions is not C1; the reader must see the logic.", "A mi juicio, la medida es razonable porque reduce la incertidumbre inicial."),
    ("counterargument", "Counterargument and rebuttal", "Represent an opposing view fairly, then limit or refute it.", "A weak essay ignores objections; a stronger one absorbs them.", "Es cierto que el coste inicial es alto; aun así, la inversión puede justificarse."),
    ("synthesis_two_views", "Synthesis of two viewpoints", "Combine two positions and explain their relationship before giving your conclusion.", "Do not summarize A, then B, then abruptly state your opinion.", "Ambas posturas coinciden en el problema, pero discrepan sobre el método."),
    ("neutral_summary", "Neutral summary of an article or opinion", "Report someone else's argument without copying or adding your own stance too early.", "C1 writing separates summary from evaluation.", "El texto plantea que la flexibilidad mejora la productividad, aunque exige coordinación."),
    ("paraphrase", "Paraphrase with changed syntax and vocabulary", "Say the same thing with different structure, register, and lexical choices.", "C1 control means meaning survives without copying the source sentence.", "La propuesta no elimina el problema; más bien, lo desplaza a otra etapa."),
    ("formal_email", "Formal email: context, request, next step", "Write precise institutional emails with courtesy and a concrete ask.", "English directness can sound abrupt in Spanish correspondence.", "Le agradecería que me confirmara si el documento es suficiente."),
    ("complaint_remedy", "Complaint with evidence and remedy", "Explain the issue, attach evidence, request a specific correction, and preserve tone.", "Being polite is not the same as being vague.", "Solicito que revisen el cargo y me indiquen el procedimiento para corregirlo."),
    ("recommendation_memo", "Recommendation memo", "Diagnose a problem, propose steps, justify them, and mention risks.", "Workplace C1 writing is action-oriented, not just descriptive.", "Recomendaría empezar con una prueba pequeña y métricas claras."),
    ("data_interpretation", "Data/trend interpretation", "Describe changes cautiously and avoid overclaiming from limited evidence.", "C1 commentary distinguishes what the data shows from what it might imply.", "Los datos apuntan a una mejora moderada, aunque la muestra sigue siendo limitada."),
    ("problem_solution", "Problem-solution paragraph", "Define the problem, explain cause, propose response, and state expected effect.", "A solution paragraph fails if the problem is vague.", "El principal obstáculo no es la falta de interés, sino la ausencia de seguimiento."),
    ("reflective_narrative", "Reflective narrative with interpretation", "Narrate what happened, why it mattered, and what changed afterward.", "C1 narration includes evaluation, not just chronology.", "Aquella conversación me obligó a replantearme cómo estaba estudiando."),
    ("register_shift", "Register shift: casual, neutral, formal", "Rewrite the same message for a friend, a colleague, and an institution.", "Audience changes vocabulary, pronouns, politeness, and sentence shape.", "¿Me echas una mano? / ¿Podrías ayudarme? / Le agradecería su colaboración."),
    ("diplomatic_disagreement", "Diplomatic disagreement", "Disagree clearly without sounding hostile or evasive.", "C1 disagreement is firm and socially controlled.", "Entiendo el argumento, pero no comparto del todo la conclusión."),
    ("hedging_precision", "Hedging and precision", "Use al parecer, tiende a, no necesariamente, en parte, hasta cierto punto.", "Advanced writing avoids pretending that every claim is absolute.", "La tendencia parece positiva, aunque no necesariamente garantiza resultados duraderos."),
    ("cohesion_reference", "Cohesion with reference chains", "Use this/that/above-mentioned ideas naturally: esta medida, lo anterior, dicho enfoque.", "Repeating nouns creates learner-like writing.", "Dicho enfoque no resolvería todo, pero sí reduciría el riesgo inicial."),
    ("causal_complexity", "Complex causal explanation", "Show multiple causes, mediating factors, and consequences.", "Because/so is too flat for C1 explanations.", "La demora no se debió a un solo factor, sino a una combinación de fallos."),
    ("concession_complex", "Complex concession and limitation", "Use si bien, por mucho que, aun cuando, pese a que, and eso no implica que.", "Nuance comes from holding tension without contradiction.", "Por mucho que mejore la herramienta, seguirá haciendo falta criterio humano."),
    ("hypothesis_speculation", "Hypothesis and speculation", "Use conditional, future of probability, and compound subjunctive for plausible interpretations.", "Speculation must sound controlled, not random.", "Es posible que la decisión se haya tomado con información incompleta."),
    ("style_compression", "Compression: say more with fewer words", "Remove filler, redundancy, and vague intensifiers while keeping nuance.", "Long does not mean advanced.", "La versión final aclara el motivo y elimina repeticiones innecesarias."),
    ("style_expansion", "Expansion: develop an underbuilt idea", "Turn a thin claim into a supported paragraph with example and implication.", "Learners often state true things without developing them.", "La práctica constante ayuda, pero solo si se convierte en retroalimentación útil."),
    ("source_integration", "Integrating source information", "Use según, de acuerdo con, el texto señala, and a cautious response.", "Source-based writing needs attribution and distance.", "Según el informe, el cambio fue gradual; no obstante, conviene interpretarlo con prudencia."),
    ("comparison_evaluation", "Compare two options and choose", "Evaluate two alternatives using criteria, tradeoffs, and a justified recommendation.", "A simple pros/cons list is not enough.", "La primera opción es más rápida, mientras que la segunda ofrece mayor estabilidad."),
    ("definition_scope", "Define a concept and set its scope", "Define what you mean, exclude what you do not mean, and apply the concept.", "C1 arguments often fail because key terms stay vague.", "Por autonomía no me refiero a aislamiento, sino a responsabilidad con margen de decisión."),
    ("narrative_argument", "Narrative used as evidence", "Use a short story to support a claim without letting the story take over.", "Anecdotes need interpretation.", "Esa experiencia ilustra por qué la claridad inicial evita conflictos posteriores."),
    ("revision_response", "Revision after feedback", "Revise a draft based on criticism: clarify, soften, reorder, and strengthen.", "C1 growth comes from second drafts, not just first attempts.", "La versión revisada reduce la ambigüedad y mejora la transición final."),
]

RUBRIC = "Rubric: natural Spanish, target structure used correctly, clear logic, appropriate register, and no literal English syntax."


def contexts_for(number: int, n: int) -> list[tuple[str, str, str, str, str]]:
    return [DOMAIN_CONTEXTS[(number + i) % len(DOMAIN_CONTEXTS)] for i in range(n)]


def section(title: str, instructions: str, prompts: list[str], answers: list[str] | None = None) -> dict:
    return {"title": title, "instructions": instructions, "prompts": prompts, "answers": answers or []}


def clean_stage(stage: str) -> str:
    return stage.lower().replace("_", "-")


def make_b2_lesson(number: int) -> dict:
    skill = B2_SKILLS[(number - 82) % len(B2_SKILLS)]
    cycle = (number - 82) // len(B2_SKILLS) + 1
    slug, name, logic, trap, example = skill
    connector = CONNECTORS[number % len(CONNECTORS)]
    ctx = contexts_for(number, 8)
    title = f"Spanish B2→C1 Bridge {number}: {name}" if cycle == 1 else f"Spanish B2→C1 Integration {number}: {name} in connected writing"

    noticing_prompts, noticing_answers = [], []
    for domain, en_obj, es_obj, en_actor, es_actor in ctx[:6]:
        noticing_prompts.append(f"[{number} · Noticing] In a {domain} context, write 2 Spanish sentences about {en_obj}. Sentence 1 should be plain and grammatical. Sentence 2 should explicitly use: {name}. Then add one sentence explaining why the mood/tense/connector choice is correct.")
        noticing_answers.append(f"Model path: {example} Then explain the speaker stance/function, not just the translation. {RUBRIC}")

    rewrite_prompts, rewrite_answers = [], []
    for domain, en_obj, es_obj, en_actor, es_actor in ctx[:8]:
        rewrite_prompts.append(f"[{number} · Rewrite] Upgrade this literal draft into natural adult Spanish for a {domain} situation: 'I think that {en_obj} is a thing that is important because people need it and it is good.' Use {name} and one connector such as '{connector}'.")
        rewrite_answers.append(f"One good direction: 'Considero que {es_obj} es relevante, {connector}, conviene analizarlo con más cuidado antes de decidir.' Adapt as needed. {RUBRIC}")

    diagnosis_prompts, diagnosis_answers = [], []
    for domain, en_obj, es_obj, en_actor, es_actor in ctx[:6]:
        bad = f"Creo que {es_obj} es importante pero sin embargo la gente necesita hacer una decisión rápido."
        good = f"Creo que {es_obj} es importante; sin embargo, conviene tomar la decisión con calma."
        diagnosis_prompts.append(f"[{number} · Diagnose] In this {domain} example, identify at least two problems in the weak sentence and rewrite it. Weak: {bad}")
        diagnosis_answers.append(f"Better: {good} Problems: connector stacking/punctuation, Englishy 'hacer una decisión', vague logic, and register. {RUBRIC}")

    writing_prompts = []
    for domain, en_obj, es_obj, en_actor, es_actor in contexts_for(number + 3, 5):
        writing_prompts.append(f"[{number} · Paragraph] Write 90-120 words in Spanish about {en_obj} in a {domain} situation. Include: topic sentence, one concrete detail, {name}, one concession or limitation, and a final practical recommendation. Avoid translating English sentence order.")

    transfer_prompts, transfer_answers = [], []
    for domain, en_obj, es_obj, en_actor, es_actor in contexts_for(number + 7, 6):
        transfer_prompts.append(f"[{number} · Transfer] Translate into natural Spanish, not word-for-word: In the {domain} situation, {en_obj} may seem simple, but it will not be useful unless {en_actor} explains the limits clearly.")
        transfer_answers.append(f"Possible answer: En la situación de {domain}, {es_obj} puede parecer sencillo, pero no será útil a menos que {es_actor} explique los límites con claridad. {RUBRIC}")

    return {
        "id": f"lesson-{number}",
        "number": number,
        "title": title,
        "difficulty": "B2",
        "patternId": f"B2_C1_BRIDGE_{slug}_{number}".upper(),
        "tags": ["spanish", "writing", "b2-c1-bridge", clean_stage(slug), "paragraph-control"],
        "sourceFiles": ["generated/c1-writing-curriculum-v2"],
        "targetPattern": name,
        "englishTrap": trap,
        "spanishLogic": logic,
        "formula": [
            "Notice the grammatical choice and name the function",
            "Rewrite literal English into natural Spanish",
            "Diagnose one grammar issue and one style/register issue",
            "Build a paragraph with topic → support → nuance → recommendation",
            "Transfer meaning from English without copying English syntax",
        ],
        "naturalExamples": [example, f"{connector.capitalize()}, conviene matizar la idea.", "No se trata solo de ser correcto, sino de sonar natural.", "La decisión depende del contexto y de la información disponible."],
        "sections": {
            "controlled": section("Concept & noticing", "Train the grammar decision before writing long paragraphs.", noticing_prompts, noticing_answers),
            "mutation": section("Rewrite & upgrade", "Turn weak literal drafts into adult Spanish.", rewrite_prompts, rewrite_answers),
            "contrast": section("Error diagnosis", "Find the problem, explain it briefly, then rewrite.", diagnosis_prompts, diagnosis_answers),
            "writing": section("Paragraph task", "Open-ended paragraph writing. The LLM grader should judge clarity, grammar, register, and C1 trajectory.", writing_prompts, []),
            "reverse": section("Translation & transfer", "Translate meaning naturally without copying English structure.", transfer_prompts, transfer_answers),
        },
        "commonErrors": [
            {"mistake": "Choosing subjunctive/indicative by English translation only.", "why_it_happens": "English hides speaker stance.", "correct_spanish": "Choose by function: fact, doubt, purpose, future condition, evaluation, or non-specific reference."},
            {"mistake": "Overusing pero/porque/y.", "why_it_happens": "The logic is left implicit.", "correct_spanish": "Use connectors that match the relationship: sin embargo, por lo tanto, de hecho, no obstante."},
            {"mistake": "Writing correct but childish sentences.", "why_it_happens": "The sentence has grammar but no register control.", "correct_spanish": "Add precision, soften overclaims, and connect ideas."},
        ],
    }


def make_c1_lesson(number: int) -> dict:
    genre = C1_GENRES[(number - 152) % len(C1_GENRES)]
    cycle = (number - 152) // len(C1_GENRES) + 1
    slug, name, logic, trap, example = genre
    connector = CONNECTORS[number % len(CONNECTORS)]
    title = f"Spanish C1 Composition {number}: {name}" if cycle == 1 else f"Spanish C1 Performance {number}: {name} under constraints"
    ctx = contexts_for(number, 8)

    model_prompts, model_answers = [], []
    for domain, en_obj, es_obj, en_actor, es_actor in ctx[:5]:
        model_prompts.append(f"[{number} · Model analysis] Draft a 3-sentence Spanish model for {name} about {en_obj} in a {domain} context. Label each sentence function in English: claim/context, support, nuance/consequence.")
        model_answers.append(f"Model direction: {example} Add one supporting sentence and one nuanced consequence. Functions must be explicit. {RUBRIC}")

    revision_prompts, revision_answers = [], []
    weak_drafts = [
        "Pienso que esto es muy bueno y muy importante porque ayuda a la gente y tiene muchas cosas positivas.",
        "Estoy escribiendo para decir que tengo un problema y quiero que ustedes lo arreglen pronto porque no es bueno.",
        "Hay dos opiniones y las dos son interesantes pero mi opinión es que una es mejor porque sí.",
        "El gráfico sube y baja y eso significa que la situación es buena para todos.",
        "Fue una experiencia mala y aprendí muchas cosas importantes sobre la vida.",
        "La solución es hacer más comunicación y tener mejor organización en el futuro.",
    ]
    for i, draft in enumerate(weak_drafts):
        domain, en_obj, es_obj, en_actor, es_actor = ctx[i % len(ctx)]
        revision_prompts.append(f"[{number} · Revision] Rewrite this weak draft into C1-level Spanish for a {domain} context using {name}. Keep the meaning but improve precision, cohesion, and register: {draft}")
        revision_answers.append(f"Good revision should: remove vague words, add a concrete relation between ideas, use controlled register, and include a connector such as '{connector}'. {RUBRIC}")

    diagnosis_prompts, diagnosis_answers = [], []
    for domain, en_obj, es_obj, en_actor, es_actor in ctx[:5]:
        diagnosis_prompts.append(f"[{number} · Rhetorical diagnosis] Write a short Spanish critique of this paragraph plan for {en_obj}: 'Sentence 1: my opinion. Sentence 2: another opinion. Sentence 3: conclusion.' Explain what is missing, then propose a better 4-sentence structure for {name}.")
        diagnosis_answers.append("Expected critique: missing context, support/evidence, concession, and implication. Better structure: context/problem → claim → support/example → concession or recommendation. " + RUBRIC)

    writing_prompts = []
    for domain, en_obj, es_obj, en_actor, es_actor in contexts_for(number + 4, 6):
        writing_prompts.append(f"[{number} · C1 writing] Write 140-180 words in Spanish about {en_obj} in a {domain} situation. Genre/focus: {name}. Requirements: clear opening, developed reasoning, at least one concession, one precise connector chain, register appropriate to the audience, and a final sentence that adds implication rather than repetition.")

    transfer_prompts, transfer_answers = [], []
    for domain, en_obj, es_obj, en_actor, es_actor in contexts_for(number + 9, 5):
        transfer_prompts.append(f"[{number} · Transfer] Translate/adapt this into natural C1 Spanish: Although {en_obj} may look like a minor issue, it reveals a deeper problem: people are making decisions without enough context, so the next step should be cautious but concrete.")
        transfer_answers.append(f"Possible answer: Aunque {es_obj} parezca un asunto menor, revela un problema de fondo: se están tomando decisiones sin suficiente contexto; por eso, el siguiente paso debería ser prudente pero concreto. {RUBRIC}")

    return {
        "id": f"lesson-{number}",
        "number": number,
        "title": title,
        "difficulty": "C1",
        "patternId": f"C1_COMPOSITION_{slug}_{number}".upper(),
        "tags": ["spanish", "writing", "c1", "composition", clean_stage(slug), "revision"],
        "sourceFiles": ["generated/c1-writing-curriculum-v2"],
        "targetPattern": name,
        "englishTrap": trap,
        "spanishLogic": logic,
        "formula": [
            "Plan the rhetorical function before writing",
            "Use evidence/example, not just opinion",
            "Add concession or limitation to avoid overclaiming",
            "Control register for audience and genre",
            "Revise for cohesion, precision, and sentence rhythm",
        ],
        "naturalExamples": [example, f"{connector.capitalize()}, conviene interpretar la situación con prudencia.", "No se trata de escribir más, sino de organizar mejor la relación entre las ideas.", "La conclusión debe añadir una consecuencia, no repetir la tesis."],
        "sections": {
            "controlled": section("Model & structure", "Draft short models and label the function of each sentence.", model_prompts, model_answers),
            "mutation": section("Revision workshop", "Rewrite weak drafts into precise, cohesive C1 Spanish.", revision_prompts, revision_answers),
            "contrast": section("Rhetorical diagnosis", "Critique weak paragraph plans and replace them with stronger structures.", diagnosis_prompts, diagnosis_answers),
            "writing": section("Full C1 composition", "Open-ended C1 writing. The LLM grader should evaluate argument, register, cohesion, grammar, and revision quality.", writing_prompts, []),
            "reverse": section("C1 transfer", "Translate/adapt complex English meaning into natural Spanish without calquing syntax.", transfer_prompts, transfer_answers),
        },
        "commonErrors": [
            {"mistake": "Writing a list of opinions instead of an argument.", "why_it_happens": "The paragraph has no rhetorical spine.", "correct_spanish": "Use claim → support → concession → implication."},
            {"mistake": "Overclaiming with siempre, todos, nunca, obviamente.", "why_it_happens": "English emphasis replaces Spanish precision.", "correct_spanish": "Use tiende a, puede, no necesariamente, en parte, hasta cierto punto."},
            {"mistake": "Making formal writing sound like chat.", "why_it_happens": "Register was not planned before drafting.", "correct_spanish": "Choose audience first, then pronouns, verbs, openings, and level of directness."},
            {"mistake": "Keeping first-draft repetition.", "why_it_happens": "No revision pass for reference chains.", "correct_spanish": "Use esta medida, dicho enfoque, lo anterior, este problema, esa posibilidad."},
        ],
    }


def lesson_11() -> dict:
    base = make_b2_lesson(111)
    base.update({
        "id": "lesson-11",
        "number": 11,
        "title": "Spanish Bridge 11: Connector logic for adult sentences",
        "difficulty": "B1-B2",
        "patternId": "BRIDGE_CONNECTOR_LOGIC_11",
    })
    return base


def validate(data: dict) -> list[str]:
    problems: list[str] = []
    lessons = data.get("lessons", [])
    required_sections = ["controlled", "mutation", "contrast", "writing", "reverse"]
    numbers = [l.get("number") for l in lessons]
    if data.get("count") != len(lessons):
        problems.append(f"count mismatch: {data.get('count')} != {len(lessons)}")
    if len(numbers) != len(set(numbers)):
        problems.append("duplicate lesson numbers")
    if sorted(numbers) != list(range(min(numbers), max(numbers) + 1)):
        missing = sorted(set(range(min(numbers), max(numbers) + 1)) - set(numbers))
        problems.append(f"missing lesson numbers: {missing}")
    for l in lessons:
        for key in ["id", "number", "title", "difficulty", "patternId", "tags", "targetPattern", "englishTrap", "spanishLogic", "formula", "naturalExamples", "sections", "commonErrors"]:
            if key not in l:
                problems.append(f"{l.get('id')} missing {key}")
        for name in required_sections:
            sec = l.get("sections", {}).get(name)
            if not sec:
                problems.append(f"{l.get('id')} missing section {name}")
                continue
            prompts = sec.get("prompts", [])
            answers = sec.get("answers", [])
            if not isinstance(prompts, list) or not prompts:
                problems.append(f"{l.get('id')} {name} has no prompts")
            if name != "writing" and len(prompts) != len(answers):
                problems.append(f"{l.get('id')} {name} prompt/answer mismatch {len(prompts)}/{len(answers)}")
            if name == "writing" and answers not in ([], None) and len(answers) not in (0, len(prompts)):
                problems.append(f"{l.get('id')} writing partial answers")
    return problems


def main() -> None:
    original = json.loads(LESSON_PATH.read_text(encoding="utf-8"))
    existing: dict[int, dict] = {}
    for lesson in original["lessons"]:
        n = int(lesson["number"])
        if n <= 81:
            existing[n] = lesson
    existing[11] = lesson_11()

    for number in range(82, 152):
        existing[number] = make_b2_lesson(number)
    for number in range(152, 202):
        existing[number] = make_c1_lesson(number)

    lessons = [existing[n] for n in sorted(existing.keys(), reverse=True)]
    source_repo = original.get("sourceRepo", "r0cstar09/fuzzy-funicular").split("+c1-writing-curriculum", 1)[0]
    data = {"sourceRepo": f"{source_repo}+c1-writing-curriculum-v2", "count": len(lessons), "lessons": lessons}
    problems = validate(data)
    if problems:
        raise SystemExit("Validation failed:\n" + "\n".join(problems[:80]))

    LESSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    level_counts = Counter(l["difficulty"] for l in lessons)
    prompt_total = sum(len(s["prompts"]) for l in lessons for s in l["sections"].values())
    answer_total = sum(len(s["answers"]) for l in lessons for s in l["sections"].values())
    section_titles = sorted({s.get("title", name) for l in lessons if l["number"] >= 82 for name, s in l["sections"].items()})
    REPORT_PATH.write_text(f"""# Spanish C1 Writing Curriculum Expansion Report

Generated: {datetime.now().isoformat(timespec='seconds')}

## Result

- Lessons now: {len(lessons)}
- Lesson range: {min(existing)}–{max(existing)}
- Missing lesson numbers: none
- Total prompts: {prompt_total}
- Answer-keyed prompt slots/rubrics: {answer_total}
- Level distribution: {dict(level_counts)}

## Second-pass curriculum upgrade

The first generated pass was schema-compatible but too repetitive and too close to the original controlled-recombination/pattern-mutation drill model. This pass keeps app compatibility while changing lessons 82–201 into a stronger B2→C1 writing curriculum:

- Lessons 82–151: B2→C1 bridge lessons focused on mood/tense control, sentence rhythm, connector logic, register, diagnosis, and paragraph cohesion.
- Lessons 152–201: C1 composition lessons focused on argument, counterargument, synthesis, formal email, complaint, recommendation memos, data commentary, reflection, register shifts, hedging, source integration, comparison, and revision.
- New section model for generated lessons: {', '.join(section_titles)}.
- Open writing prompts are intentionally answerless so the backend LLM grader evaluates the full response.
- Non-writing answer slots are model directions/rubrics, not single exact answers; this is deliberate because B2/C1 writing has multiple valid outputs.

## Human review still recommended

- These lessons are deterministic generated curriculum content, not native-teacher-authored textbook material.
- C1 progress depends on actually completing the full composition/revision sections and using LLM feedback to revise.
- If grading is too strict or too lenient for long-form tasks, tune the backend lesson grading rubric rather than simplifying the prompts.
""", encoding="utf-8")

    print(f"wrote {LESSON_PATH}")
    print(f"wrote {REPORT_PATH}")
    print(f"lessons={len(lessons)} prompts={prompt_total} answers={answer_total} levels={dict(level_counts)}")


if __name__ == "__main__":
    main()
