#!/usr/bin/env python3
"""Create a leveled SER usage bank: easy first, old C1 preserved as ser_advanced."""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src/data/generated/c1_verb_usage_banks.json"
REPORT = ROOT / "reports/ser_usage_leveling_report.json"

prompts: list[dict[str, Any]] = []
seen_en: set[str] = set()
seen_es: set[str] = set()

SER_FORMS = ("soy", "eres", "es", "somos", "son", "fue", "fueron", "era", "eran", "ha sido", "han sido", "sea", "sean", "sería", "serían", "será", "serán", "fuera")

def mood(tense: str) -> str:
    return "subjunctive" if "Subjunctive" in tense else "indicative/conditional"

def level_for_index(i: int) -> str:
    if i <= 200:
        return "easy"
    if i <= 350:
        return "medium"
    if i <= 425:
        return "past"
    return "advanced_intro"

def add(tense: str, difficulty: str, construction: str, prompt_en: str, expected_es: str, vocab: list[str], hint: str) -> bool:
    prompt_en = "Say: " + prompt_en.strip().rstrip(".") + "."
    expected_es = expected_es.strip().rstrip(".") + "."
    if prompt_en in seen_en or expected_es in seen_es:
        return False
    if not any(f in expected_es.lower() for f in SER_FORMS):
        raise ValueError(f"No SER form in: {expected_es}")
    seen_en.add(prompt_en); seen_es.add(expected_es)
    i = len(prompts) + 1
    prompts.append({
        "id": f"ser-usage-{i:03d}",
        "verb": "ser",
        "batch": (i - 1) // 50 + 1,
        "batch_size": 50,
        "level": level_for_index(i),
        "tense": tense,
        "mood": mood(tense),
        "difficulty": difficulty,
        "construction": construction,
        "prompt_en": prompt_en,
        "expected_es": expected_es,
        "acceptable_answer_pattern": None,
        "target_vocabulary": vocab,
        "grading_notes": "Grade for the required SER use, correct form, agreement, and target vocabulary. Do not require accents for pass/fail.",
        "correction_hint": hint,
    })
    return True


def lower_first_for_context(text: str) -> str:
    """Lowercase after context commas without turning English 'I' into 'i'."""
    return text if text.startswith("I ") else text[0].lower() + text[1:]


names = [
    ("Ana", "Ana", "f"), ("Luis", "Luis", "m"), ("Marta", "Marta", "f"), ("Carlos", "Carlos", "m"), ("Sofía", "Sofía", "f"),
    ("Diego", "Diego", "m"), ("Elena", "Elena", "f"), ("Pedro", "Pedro", "m"), ("Lucía", "Lucía", "f"), ("Miguel", "Miguel", "m"),
]
professions = [
    ("a doctor", "doctor", "doctora", "profession", "doctor"), ("a teacher", "maestro", "maestra", "profession", "maestro"),
    ("a nurse", "enfermero", "enfermera", "profession", "enfermera"), ("a mechanic", "mecánico", "mecánica", "profession", "mecánico"),
    ("a driver", "conductor", "conductora", "profession", "conductor"), ("a cook", "cocinero", "cocinera", "profession", "cocinera"),
    ("a student", "estudiante", "estudiante", "identity", "estudiante"), ("a singer", "cantante", "cantante", "profession", "cantante"),
    ("an artist", "artista", "artista", "profession", "artista"), ("a cashier", "cajero", "cajera", "profession", "cajera"),
]
descriptions = [
    ("tall", "alto", "description", "alto"), ("short", "bajo", "description", "bajo"),
    ("kind", "amable", "description", "amable"), ("smart", "inteligente", "description", "inteligente"),
    ("serious", "serio", "description", "serio"), ("funny", "gracioso", "description", "gracioso"),
    ("young", "joven", "description", "joven"), ("strong", "fuerte", "description", "fuerte"),
]
fem_descriptions = {"alto":"alta", "bajo":"baja", "serio":"seria", "gracioso":"graciosa"}
nationalities = [("Mexican", "mexicano", "mexicana", "México"), ("Colombian", "colombiano", "colombiana", "Colombia"), ("Spanish", "español", "española", "España"), ("Chilean", "chileno", "chilena", "Chile"), ("Peruvian", "peruano", "peruana", "Perú")]
people = [("My brother", "Mi hermano", "m"), ("My sister", "Mi hermana", "f"), ("My cousin", "Mi primo", "m"), ("My aunt", "Mi tía", "f"), ("The boy", "El niño", "m"), ("The girl", "La niña", "f"), ("The doctor", "La doctora", "f"), ("The teacher", "El maestro", "m")]
materials = [("table", "mesa", "la", "wood", "madera"), ("chair", "silla", "la", "plastic", "plástico"), ("door", "puerta", "la", "metal", "metal"), ("glass", "vaso", "el", "glass", "vidrio"), ("shirt", "camisa", "la", "cotton", "algodón"), ("jacket", "chaqueta", "la", "leather", "cuero"), ("box", "caja", "la", "cardboard", "cartón"), ("ring", "anillo", "el", "gold", "oro"), ("spoon", "cuchara", "la", "silver", "plata"), ("bag", "bolsa", "la", "paper", "papel")]
events = [("meeting", "reunión", "la"), ("class", "clase", "la"), ("party", "fiesta", "la"), ("appointment", "cita", "la"), ("concert", "concierto", "el"), ("exam", "examen", "el"), ("game", "partido", "el"), ("wedding", "boda", "la"), ("call", "llamada", "la"), ("interview", "entrevista", "la")]
times = [("at eight", "a las ocho"), ("at nine", "a las nueve"), ("at ten", "a las diez"), ("tomorrow", "mañana"), ("on Saturday", "el sábado"), ("on Sunday", "el domingo"), ("today", "hoy"), ("tonight", "esta noche")]
locations = [("in the park", "en el parque"), ("at school", "en la escuela"), ("at home", "en casa"), ("in the office", "en la oficina"), ("at the hotel", "en el hotel"), ("in room two", "en la sala dos"), ("at the station", "en la estación"), ("at the clinic", "en la clínica")]

# Easy: 200 unique short present-tense prompts.
add("Present", "A1", "identity", "I am a student", "Soy estudiante", ["estudiante"], "Use soy for your identity.")
add("Present", "A1", "identity", "I am Tony", "Soy Tony", ["Tony"], "Use soy for your name or identity.")
add("Present", "A1", "profession", "You are a teacher", "Eres maestro", ["maestro"], "Use eres for you are.")
pairs = [(i, j, names[i], professions[j]) for i in range(len(names)) for j in range(len(professions))]
pairs.sort(key=lambda item: (item[0] * 7 + item[1] * 3) % 101)
for _i, _j, name_row, prof_row in pairs:
    if len(prompts) >= 55:
        break
    en_name, es_name, gender = name_row
    en_prof, es_prof_m, es_prof_f, cons, vocab = prof_row
    es_prof = es_prof_f if gender == "f" else es_prof_m
    add("Present", "A1/A2", cons, f"{en_name} is {en_prof}", f"{es_name} es {es_prof}", [vocab], "Use ser for identity or profession.")
for en_person, es_person, gender in people:
    for en_adj, es_adj, cons, vocab in descriptions:
        adj = fem_descriptions.get(es_adj, es_adj) if gender == "f" else es_adj
        add("Present", "A1/A2", cons, f"{en_person} is {en_adj}", f"{es_person} es {adj}", [vocab], "Use ser for a basic description.")
        if len(prompts) >= 95: break
    if len(prompts) >= 95: break
for en_person, es_person, gender in people:
    for en_nat, nat_m, nat_f, country in nationalities:
        add("Present", "A1/A2", "nationality", f"{en_person} is {en_nat}", f"{es_person} es {nat_f if gender == 'f' else nat_m}", [country], "Use ser for nationality.")
        if len(prompts) >= 125: break
    if len(prompts) >= 125: break
for en_obj, es_obj, article, en_mat, es_mat in materials:
    add("Present", "A1/A2", "material", f"The {en_obj} is made of {en_mat}", f"{article.capitalize()} {es_obj} es de {es_mat}", [es_obj, es_mat], "Use ser de for material.")
    add("Present", "A2", "negative material", f"The {en_obj} is not made of {en_mat}", f"{article.capitalize()} {es_obj} no es de {es_mat}", [es_obj, es_mat], "Use no es de for negative material.")
for en_event, es_event, article in events:
    for en_time, es_time in times:
        add("Present", "A1/A2", "event time", f"The {en_event} is {en_time}", f"{article.capitalize()} {es_event} es {es_time}", [es_event], "Use ser for when an event happens.")
        if len(prompts) >= 175: break
    if len(prompts) >= 175: break
for en_event, es_event, article in events:
    for en_loc, es_loc in locations:
        add("Present", "A2", "event location", f"The {en_event} is {en_loc}", f"{article.capitalize()} {es_event} es {es_loc}", [es_event], "Use ser for where an event takes place.")
        if len(prompts) >= 200: break
    if len(prompts) >= 200: break
assert len(prompts) == 200

# Medium: 150 short practical present and simple identification/cause/source/purpose.
medium = [
    ("The problem is the price", "El problema es el precio", "identity/cause", ["problema", "precio"]),
    ("The problem is the battery", "El problema es la batería", "identity/cause", ["problema", "batería"]),
    ("The answer is simple", "La respuesta es sencilla", "description", ["respuesta"]),
    ("The best option is the bus", "La mejor opción es el autobús", "choice", ["opción", "autobús"]),
    ("The main reason is the rain", "La razón principal es la lluvia", "cause", ["razón", "lluvia"]),
    ("The call is from the clinic", "La llamada es de la clínica", "source", ["llamada", "clínica"]),
    ("The message is from Ana", "El mensaje es de Ana", "source", ["mensaje"]),
    ("The gift is for my sister", "El regalo es para mi hermana", "recipient", ["regalo", "hermana"]),
    ("This key is for the front door", "Esta llave es para la puerta principal", "purpose", ["llave", "puerta"]),
    ("My job is to help patients", "Mi trabajo es ayudar a los pacientes", "role/purpose", ["trabajo", "pacientes"]),
    ("The plan is for tomorrow", "El plan es para mañana", "planned time", ["plan"]),
    ("The important thing is to arrive early", "Lo importante es llegar temprano", "lo importante es", ["llegar"]),
    ("The easy part is reading", "La parte fácil es leer", "identification", ["leer"]),
    ("The hard part is speaking", "La parte difícil es hablar", "identification", ["hablar"]),
    ("This book is mine", "Este libro es mío", "ownership", ["libro"]),
    ("This backpack is yours", "Esta mochila es tuya", "ownership", ["mochila"]),
]
while len(prompts) < 350:
    en, es, cons, vocab = medium[len(prompts) % len(medium)]
    if not add("Present", "A2/B1", cons, en, es, vocab, "Use ser to identify, define, show source, purpose, or ownership."):
        # Add a tiny natural context to keep prompts unique without increasing difficulty.
        contexts = [
            ("Today", "Hoy"), ("For me", "Para mí"), ("In class", "En clase"), ("At home", "En casa"),
            ("At work", "En el trabajo"), ("Right now", "Ahora mismo"), ("In this case", "En este caso"),
            ("For Ana", "Para Ana"), ("For Luis", "Para Luis"), ("This morning", "Esta mañana"),
        ]
        en_ctx, es_ctx = contexts[(len(prompts) // len(medium)) % len(contexts)]
        add("Present", "A2/B1", cons, f"{en_ctx}, {lower_first_for_context(en)}", f"{es_ctx}, {es[0].lower() + es[1:]}", vocab, "Use ser to identify, define, show source, purpose, or ownership.")

# Past/present-perfect: 75 short prompts.
past = [
    ("The meeting was yesterday", "La reunión fue ayer", "Preterite", "event date", ["reunión"]),
    ("The class was useful", "La clase fue útil", "Preterite", "completed evaluation", ["clase"]),
    ("The exam was difficult", "El examen fue difícil", "Preterite", "completed evaluation", ["examen"]),
    ("The party was at my house", "La fiesta fue en mi casa", "Preterite", "event location", ["fiesta", "casa"]),
    ("That was a good idea", "Eso fue una buena idea", "Preterite", "past identification", ["idea"]),
    ("My grandfather was a farmer", "Mi abuelo era agricultor", "Imperfect", "past role", ["abuelo", "agricultor"]),
    ("The house was small", "La casa era pequeña", "Imperfect", "past description", ["casa"]),
    ("The streets were quiet", "Las calles eran tranquilas", "Imperfect", "past description", ["calles"]),
    ("The doctor was kind", "La doctora era amable", "Imperfect", "past description", ["doctora"]),
    ("This week has been busy", "Esta semana ha sido ocupada", "Present Perfect", "present perfect evaluation", ["semana"]),
    ("The trip has been long", "El viaje ha sido largo", "Present Perfect", "present perfect evaluation", ["viaje"]),
    ("The service has been good", "El servicio ha sido bueno", "Present Perfect", "present perfect evaluation", ["servicio"]),
]
while len(prompts) < 425:
    en, es, tense, cons, vocab = past[len(prompts) % len(past)]
    if not add(tense, "B1", cons, en, es, vocab, "Use fue for completed events, era for background descriptions, or ha sido for an evaluation up to now."):
        contexts = [("For me", "Para mí"), ("Yesterday", "Ayer"), ("Last week", "La semana pasada"), ("Honestly", "Sinceramente"), ("At first", "Al principio"), ("In my opinion", "En mi opinión"), ("For Ana", "Para Ana")]
        en_ctx, es_ctx = contexts[(len(prompts) // len(past)) % len(contexts)]
        add(tense, "B1", cons, f"{en_ctx}, {lower_first_for_context(en)}", f"{es_ctx}, {es[0].lower() + es[1:]}", vocab, "Use fue for completed events, era for background descriptions, or ha sido for an evaluation up to now.")

# Advanced intro: 75 short later constructions, not C1/legal/admin.
adv = [
    ("It is important that the room be large", "Es importante que la habitación sea amplia", "Present Subjunctive", "requirement + sea", ["habitación"]),
    ("It is better that the answer be short", "Es mejor que la respuesta sea corta", "Present Subjunctive", "evaluation + sea", ["respuesta"]),
    ("I want the meeting to be quick", "Quiero que la reunión sea rápida", "Present Subjunctive", "wish + sea", ["reunión"]),
    ("I need the plan to be clear", "Necesito que el plan sea claro", "Present Subjunctive", "need + sea", ["plan"]),
    ("It would be better to leave early", "Sería mejor salir temprano", "Conditional", "sería mejor", ["salir"]),
    ("It would be a good idea", "Sería una buena idea", "Conditional", "conditional identification", ["idea"]),
    ("Tomorrow will be another day", "Mañana será otro día", "Future", "future identification", ["día"]),
    ("The party will be at my house", "La fiesta será en mi casa", "Future", "future event location", ["fiesta", "casa"]),
    ("If I were rich, I would travel", "Si fuera rico, viajaría", "Imperfect Subjunctive", "si fuera", ["viajar"]),
    ("If it were easy, everyone would do it", "Si fuera fácil, todos lo harían", "Imperfect Subjunctive", "si fuera", ["fácil"]),
    ("The report was written by Ana", "El informe fue escrito por Ana", "Preterite", "simple passive voice", ["informe"]),
]
while len(prompts) < 500:
    en, es, tense, cons, vocab = adv[len(prompts) % len(adv)]
    if not add(tense, "B1/B2", cons, en, es, vocab, "This introduces a later SER construction in a short sentence."):
        contexts = [("In this case", "En este caso"), ("For me", "Para mí"), ("Today", "Hoy"), ("In class", "En clase"), ("At work", "En el trabajo"), ("For Ana", "Para Ana"), ("Tomorrow", "Mañana")]
        en_ctx, es_ctx = contexts[(len(prompts) // len(adv)) % len(contexts)]
        add(tense, "B1/B2", cons, f"{en_ctx}, {lower_first_for_context(en)}", f"{es_ctx}, {es[0].lower() + es[1:]}", vocab, "This introduces a later SER construction in a short sentence.")

assert len(prompts) == 500
for i, p in enumerate(prompts, 1):
    assert p["id"] == f"ser-usage-{i:03d}"
    assert p["batch"] == (i - 1) // 50 + 1

existing: dict[str, Any] = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"verbs": {}}
verbs = cast(dict[str, Any], existing.setdefault("verbs", {}))
old_ser = verbs.get("ser")
if isinstance(old_ser, dict) and old_ser.get("quality_note", "").lower().find("c1") >= 0 and "ser_advanced" not in verbs:
    adv_bank = dict(old_ser)
    adv_bank["verb"] = "ser_advanced"
    adv_bank["quality_note"] = "Advanced/C1 SER bank preserved from the original C1 gap-vocabulary generation; not served as the first unlocked ser usage bank."
    verbs["ser_advanced"] = adv_bank

verbs["ser"] = {
    "verb": "ser",
    "english_base": "be",
    "category": "irregular",
    "total_prompts": 500,
    "batch_size": 50,
    "batches": 10,
    "levels": [
        {"name": "easy", "batches": [1, 2, 3, 4], "description": "short present-tense identity, description, nationality, material, event time/place"},
        {"name": "medium", "batches": [5, 6, 7], "description": "source, purpose, ownership, simple cause/identity"},
        {"name": "past", "batches": [8, 9], "description": "fue, era, ha sido in short sentences"},
        {"name": "advanced_intro", "batches": [9, 10], "description": "short subjunctive/conditional/future/passive intro"},
    ],
    "quality_note": "Leveled SER usage bank: easy batches first; old C1 bank preserved separately as ser_advanced.",
    "prompts": prompts,
}
existing.update({
    "source": "curated/ser-leveled-usage-bank",
    "count": len(verbs),
    "batch_size": 50,
    "prompts_per_verb": 500,
    "status": "ser_leveled_easy_first; c1 bank preserved as ser_advanced",
})
OUT.write_text(json.dumps(existing, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

word_counts = [len(p["expected_es"].replace(".", "").replace(",", "").split()) for p in prompts]
report = {
    "output": str(OUT),
    "total_prompts": len(prompts),
    "duplicate_prompt_en": len(prompts) - len({p["prompt_en"] for p in prompts}),
    "duplicate_expected_es": len(prompts) - len({p["expected_es"] for p in prompts}),
    "batch_counts": sorted(Counter(p["batch"] for p in prompts).items()),
    "level_counts": Counter(p["level"] for p in prompts).most_common(),
    "tense_counts": Counter(p["tense"] for p in prompts).most_common(),
    "spanish_word_count_avg": round(sum(word_counts) / len(word_counts), 2),
    "spanish_word_count_max": max(word_counts),
    "first_15": [{"id": p["id"], "prompt_en": p["prompt_en"], "expected_es": p["expected_es"], "level": p["level"]} for p in prompts[:15]],
}
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
