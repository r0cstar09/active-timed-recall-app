import { useEffect, useMemo, useState } from "react";
import { api, type StudyGradeResponse, type VerbCatalog, type VerbCatalogAssignment, type VerbProgress, type VerbPromptProgress } from "../../lib/api";

type Assignment = VerbCatalogAssignment;
type VerbData = VerbCatalog;
type UsageDrill = {
  id: string;
  focus: string;
  promptEn: string;
  expectedEs?: string;
};

const emptyData: VerbData = {
  sourceRepo: "",
  count: 0,
  rotationCount: 0,
  tenses: [],
  pronouns: [],
  verbs: [],
};

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function rowKey(row: Assignment, idx: number) {
  return `${idx}-${row.tense}-${row.pronoun}`;
}

function progressKey(verb: string, row: Assignment) {
  return `${verb}::${row.tense}::${row.pronoun}`;
}

function resultClass(result?: string) {
  if (result === "pass") return "alert alert-ok";
  if (result === "partial") return "alert";
  if (result === "fail") return "alert alert-danger";
  return "alert";
}

const CURATED_USAGE_DRILLS: Record<string, UsageDrill[]> = {
  ser: [
    { id: "ser-identity", focus: "ser + noun/adj", promptEn: "I am a responsible person.", expectedEs: "Soy una persona responsable." },
    { id: "ser-de", focus: "ser de", promptEn: "She is from Mexico.", expectedEs: "Ella es de México." },
  ],
  estar: [
    { id: "estar-location", focus: "estar + location", promptEn: "We are at home.", expectedEs: "Estamos en casa." },
    { id: "estar-gerund", focus: "estar + gerund", promptEn: "They are studying now.", expectedEs: "Están estudiando ahora." },
  ],
  tener: [
    { id: "tener-que", focus: "tener que + infinitive", promptEn: "I have to finish this today.", expectedEs: "Tengo que terminar esto hoy." },
    { id: "tener-ganas", focus: "tener ganas de", promptEn: "We feel like going out tonight.", expectedEs: "Tenemos ganas de salir esta noche." },
  ],
  hacer: [
    { id: "hacer-tiempo", focus: "hace + time + que", promptEn: "I have been studying Spanish for two years.", expectedEs: "Hace dos años que estudio español." },
    { id: "hacer-falta", focus: "hacer falta", promptEn: "We need more time.", expectedEs: "Nos hace falta más tiempo." },
  ],
  ir: [
    { id: "ir-a-inf", focus: "ir a + infinitive", promptEn: "I am going to call you tomorrow.", expectedEs: "Voy a llamarte mañana." },
    { id: "irse", focus: "irse", promptEn: "They are leaving early.", expectedEs: "Se van temprano." },
  ],
  poder: [
    { id: "poder-inf", focus: "poder + infinitive", promptEn: "I cannot explain it well.", expectedEs: "No puedo explicarlo bien." },
    { id: "no-poder-con", focus: "no poder con", promptEn: "I can't handle so much pressure.", expectedEs: "No puedo con tanta presión." },
  ],
  querer: [
    { id: "querer-inf", focus: "querer + infinitive", promptEn: "She wants to learn faster.", expectedEs: "Quiere aprender más rápido." },
    { id: "querer-que-subj", focus: "querer que + subjunctive", promptEn: "I want you to listen carefully.", expectedEs: "Quiero que escuches con atención." },
  ],
  decir: [
    { id: "decir-a", focus: "decir algo a alguien", promptEn: "I told him the truth.", expectedEs: "Le dije la verdad." },
    { id: "decir-que", focus: "decir que", promptEn: "She said she was tired.", expectedEs: "Dijo que estaba cansada." },
  ],
  dar: [
    { id: "dar-a", focus: "dar algo a alguien", promptEn: "I gave the book to my friend.", expectedEs: "Le di el libro a mi amigo." },
    { id: "darse-cuenta", focus: "darse cuenta de que", promptEn: "I realized I had made a mistake.", expectedEs: "Me di cuenta de que había cometido un error." },
  ],
  poner: [
    { id: "ponerse-adj", focus: "ponerse + adjective", promptEn: "He got nervous during the meeting.", expectedEs: "Se puso nervioso durante la reunión." },
    { id: "ponerse-a", focus: "ponerse a + infinitive", promptEn: "We started working immediately.", expectedEs: "Nos pusimos a trabajar enseguida." },
  ],
  saber: [
    { id: "saber-inf", focus: "saber + infinitive", promptEn: "I know how to cook rice.", expectedEs: "Sé cocinar arroz." },
    { id: "saber-de", focus: "saber de", promptEn: "She knows a lot about history.", expectedEs: "Sabe mucho de historia." },
  ],
  salir: [
    { id: "salir-de", focus: "salir de", promptEn: "I left work late.", expectedEs: "Salí tarde del trabajo." },
    { id: "salir-con", focus: "salir con", promptEn: "He is dating a friend from school.", expectedEs: "Sale con una amiga de la escuela." },
  ],
  volver: [
    { id: "volver-a-inf", focus: "volver a + infinitive", promptEn: "I read the message again.", expectedEs: "Volví a leer el mensaje." },
    { id: "volver-de", focus: "volver de", promptEn: "We came back from the trip yesterday.", expectedEs: "Volvimos del viaje ayer." },
  ],
  seguir: [
    { id: "seguir-gerund", focus: "seguir + gerund", promptEn: "I am still learning Spanish.", expectedEs: "Sigo aprendiendo español." },
    { id: "seguir-a", focus: "seguir a alguien", promptEn: "They followed the teacher.", expectedEs: "Siguieron al profesor." },
  ],
  quedar: [
    { id: "quedar-con", focus: "quedar con", promptEn: "I am meeting Ana tomorrow.", expectedEs: "Quedo con Ana mañana." },
    { id: "quedar-en", focus: "quedar en + infinitive", promptEn: "We agreed to talk later.", expectedEs: "Quedamos en hablar más tarde." },
  ],
  dejar: [
    { id: "dejar-de", focus: "dejar de + infinitive", promptEn: "I stopped drinking coffee.", expectedEs: "Dejé de tomar café." },
    { id: "dejar-que", focus: "dejar que + subjunctive", promptEn: "Let him explain the problem.", expectedEs: "Deja que explique el problema." },
  ],
  llegar: [
    { id: "llegar-a-place", focus: "llegar a", promptEn: "We arrived at the station early.", expectedEs: "Llegamos temprano a la estación." },
    { id: "llegar-a-inf", focus: "llegar a + infinitive", promptEn: "I managed to understand the main idea.", expectedEs: "Llegué a entender la idea principal." },
  ],
  pensar: [
    { id: "pensar-en", focus: "pensar en", promptEn: "I am thinking about the future.", expectedEs: "Estoy pensando en el futuro." },
    { id: "pensar-inf", focus: "pensar + infinitive", promptEn: "We plan to leave early.", expectedEs: "Pensamos salir temprano." },
  ],
  pedir: [
    { id: "pedir-obj", focus: "pedir algo", promptEn: "I asked for more time.", expectedEs: "Pedí más tiempo." },
    { id: "pedir-que-subj", focus: "pedir que + subjunctive", promptEn: "She asked us to wait outside.", expectedEs: "Nos pidió que esperáramos afuera." },
  ],
  tratar: [
    { id: "tratar-de", focus: "tratar de + infinitive", promptEn: "I tried to explain the situation.", expectedEs: "Traté de explicar la situación." },
    { id: "tratarse-de", focus: "tratarse de", promptEn: "It is about an important problem.", expectedEs: "Se trata de un problema importante." },
  ],
  conseguir: [
    { id: "conseguir-inf", focus: "conseguir + infinitive", promptEn: "I managed to finish on time.", expectedEs: "Conseguí terminar a tiempo." },
    { id: "conseguir-obj", focus: "conseguir + object", promptEn: "We got the tickets yesterday.", expectedEs: "Conseguimos las entradas ayer." },
  ],
  comenzar: [
    { id: "comenzar-a", focus: "comenzar a + infinitive", promptEn: "They began to work early.", expectedEs: "Comenzaron a trabajar temprano." },
    { id: "comenzar-por", focus: "comenzar por", promptEn: "We started by reviewing the errors.", expectedEs: "Comenzamos por repasar los errores." },
  ],
  resultar: [
    { id: "resultar-adj", focus: "resultar + adjective", promptEn: "The exercise turned out to be difficult.", expectedEs: "El ejercicio resultó difícil." },
    { id: "resultar-que", focus: "resultar que", promptEn: "It turns out that he already knew.", expectedEs: "Resulta que ya lo sabía." },
  ],
  considerar: [
    { id: "considerar-que", focus: "considerar que", promptEn: "I consider that this option is better.", expectedEs: "Considero que esta opción es mejor." },
    { id: "considerar-obj-adj", focus: "considerar + object + adjective", promptEn: "They consider the plan risky.", expectedEs: "Consideran arriesgado el plan." },
  ],
  formar: [
    { id: "formar-parte", focus: "formar parte de", promptEn: "This forms part of the process.", expectedEs: "Esto forma parte del proceso." },
    { id: "formar-a", focus: "formar a alguien", promptEn: "The company trains new employees.", expectedEs: "La empresa forma a nuevos empleados." },
  ],
  lograr: [
    { id: "lograr-inf", focus: "lograr + infinitive", promptEn: "I managed to finish the project.", expectedEs: "Logré terminar el proyecto." },
    { id: "lograr-que-subj", focus: "lograr que + subjunctive", promptEn: "I got them to listen to me.", expectedEs: "Logré que me escucharan." },
  ],
  alcanzar: [
    { id: "alcanzar-obj", focus: "alcanzar + object", promptEn: "We reached our goal.", expectedEs: "Alcanzamos nuestra meta." },
    { id: "alcanzar-a-inf", focus: "alcanzar a + infinitive", promptEn: "I managed to see him before he left.", expectedEs: "Alcancé a verlo antes de que se fuera." },
  ],
  dirigir: [
    { id: "dirigir-obj", focus: "dirigir + object", promptEn: "She manages the team.", expectedEs: "Ella dirige el equipo." },
    { id: "dirigirse-a", focus: "dirigirse a", promptEn: "He addressed the audience calmly.", expectedEs: "Se dirigió al público con calma." },
  ],
  utilizar: [
    { id: "utilizar-obj", focus: "utilizar + object", promptEn: "We use this tool every day.", expectedEs: "Utilizamos esta herramienta todos los días." },
    { id: "utilizar-para", focus: "utilizar para + infinitive", promptEn: "I use the app to practice Spanish.", expectedEs: "Utilizo la app para practicar español." },
  ],
  intentar: [
    { id: "intentar-inf", focus: "intentar + infinitive", promptEn: "I tried to call you last night.", expectedEs: "Intenté llamarte anoche." },
    { id: "intentar-obj", focus: "intentar + object", promptEn: "They attempted a different solution.", expectedEs: "Intentaron una solución diferente." },
  ],
  aparecer: [
    { id: "aparecer-en", focus: "aparecer en", promptEn: "The word appears in the text.", expectedEs: "La palabra aparece en el texto." },
    { id: "aparecerse-a", focus: "aparecerse a", promptEn: "The idea appeared to me suddenly.", expectedEs: "La idea se me apareció de repente." },
  ],
};

function usageFocusFromHint(verb: string, hint?: string) {
  const first = (hint || "").split(";")[0]?.trim();
  if (!first) return `${verb} in a complete sentence`;
  return first.replace(/\s+—\s+.*/, "");
}

function buildUsageDrills(verb?: VerbCatalog["verbs"][number]): UsageDrill[] {
  if (!verb) return [];
  const curated = CURATED_USAGE_DRILLS[verb.verb];
  if (curated?.length) return curated;
  const focus = usageFocusFromHint(verb.verb, verb.usageHint);
  return [
    {
      id: `${verb.verb}-usage-open`,
      focus,
      promptEn: `Write one natural Spanish sentence using: ${focus}.`,
    },
    {
      id: `${verb.verb}-usage-personal`,
      focus,
      promptEn: `Write one personal sentence in Spanish that uses ${verb.verb} correctly in context.`,
    },
  ];
}

export default function VerbTrainer() {
  const [data, setData] = useState<VerbData>(emptyData);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [verbName, setVerbName] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grade, setGrade] = useState<StudyGradeResponse | null>(null);
  const [usageAnswers, setUsageAnswers] = useState<Record<string, string>>({});
  const [usageGrade, setUsageGrade] = useState<StudyGradeResponse | null>(null);
  const [usageGrading, setUsageGrading] = useState(false);
  const [promotingMissId, setPromotingMissId] = useState<number | null>(null);
  const [promotionStatus, setPromotionStatus] = useState<Record<number, string>>({});
  const [verbProgress, setVerbProgress] = useState<Record<string, VerbProgress>>({});
  const [promptProgress, setPromptProgress] = useState<Record<string, VerbPromptProgress>>({});
  const [resetting, setResetting] = useState(false);
  const [newVerb, setNewVerb] = useState("");
  const [newEnglishBase, setNewEnglishBase] = useState("");
  const [newCategory, setNewCategory] = useState("custom");
  const [newUsageHint, setNewUsageHint] = useState("");
  const [addingVerb, setAddingVerb] = useState(false);

  const verb = useMemo(
    () => data.verbs.find((v) => v.verb === verbName) ?? data.verbs[0],
    [data.verbs, verbName],
  );

  useEffect(() => {
    let alive = true;
    api.listVerbCatalog()
      .catch(async () => {
        const mod = await import("../../data/generated/verbs.json");
        return mod.default as VerbData;
      })
      .then((loaded) => {
        if (!alive) return;
        setData(loaded);
        setVerbName((current) => current || loaded.verbs[0]?.verb || "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        if (alive) setCatalogLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const rows = useMemo(() => verb?.assignments ?? [], [verb]);
  const usageDrills = useMemo(() => buildUsageDrills(verb), [verb]);
  const passedPromptKeys = useMemo(
    () => new Set(Object.entries(promptProgress).filter(([, p]) => p.status === "pass").map(([key]) => key)),
    [promptProgress],
  );
  const visibleRows = useMemo(
    () => verb ? rows.map((row, idx) => ({ row, idx })).filter(({ row }) => !passedPromptKeys.has(progressKey(verb.verb, row))) : [],
    [rows, passedPromptKeys, verb?.verb],
  );
  const hiddenPassedCount = rows.length - visibleRows.length;
  const currentProgress = verb ? verbProgress[verb.verb] : undefined;
  const isIrregular = (verb?.category ?? "").toLowerCase().includes("irregular");
  const requiredPasses = currentProgress?.required_full_passes ?? (isIrregular ? 7 : 1);
  const fullPassCount = currentProgress?.full_pass_count ?? 0;
  const verbComplete = Boolean(currentProgress?.completed);

  useEffect(() => {
    let cancelled = false;
    api.listVerbProgress().then((items) => {
      if (cancelled) return;
      setVerbProgress(Object.fromEntries(items.map((p) => [p.verb, p])));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function refreshPromptProgress(targetVerb?: string) {
    const name = targetVerb || verb?.verb;
    if (!name) return;
    const items = await api.listVerbPromptProgress(name);
    setPromptProgress((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key.startsWith(`${name}::`)) delete next[key];
      }
      for (const item of items) next[`${item.verb}::${item.tense}::${item.pronoun}`] = item;
      return next;
    });
  }

  useEffect(() => {
    if (!verb?.verb) return;
    refreshPromptProgress(verb.verb).catch(() => undefined);
  }, [verb?.verb]);

  function setAnswer(key: string, value: string) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    setGrade(null);
    setError(null);
  }

  function setUsageAnswer(key: string, value: string) {
    setUsageAnswers((prev) => ({ ...prev, [key]: value }));
    setUsageGrade(null);
    setError(null);
  }

  function clearAnswers() {
    setAnswers({});
    setUsageAnswers({});
    setGrade(null);
    setUsageGrade(null);
    setPromotionStatus({});
    setError(null);
  }

  async function submit() {
    if (!verb) return;
    const submitted = visibleRows
      .map(({ row, idx }) => ({ row, key: rowKey(row, idx), answer: answers[rowKey(row, idx)] ?? "" }))
      .filter((item) => item.answer.trim());
    if (!submitted.length) return;
    setGrading(true);
    setError(null);
    setGrade(null);
    try {
      const response = await api.gradeStudy({
        exercise_type: "verb_conjugation",
        source: "daily_verb",
        total_assignments: verb.assignments.length,
        verb_category: verb.category,
        items: submitted.map(({ row, key, answer }) => ({
          client_id: key,
          verb: verb.verb,
          pronoun: row.pronoun,
          tense: row.tense,
          prompt: row.translation,
          user_answer: answer,
        })),
      });
      setGrade(response);
      setPromptProgress((prev) => {
        const next = { ...prev };
        for (const item of response.items ?? []) {
          const submittedItem = submitted.find((s) => s.key === String(item.client_id));
          if (submittedItem && item.result === "pass") {
            next[progressKey(verb.verb, submittedItem.row)] = {
              verb: verb.verb,
              pronoun: submittedItem.row.pronoun,
              tense: submittedItem.row.tense,
              prompt: submittedItem.row.translation,
              status: "pass",
              last_result: item.result,
              last_attempt_id: item.attempt_id,
            };
          }
        }
        return next;
      });
      setAnswers((prev) => {
        const next = { ...prev };
        for (const item of response.items ?? []) {
          if (item.result === "pass" && item.client_id != null) delete next[String(item.client_id)];
        }
        return next;
      });
      if (response.progress?.verb) {
        setVerbProgress((prev) => ({ ...prev, [String(response.progress?.verb)]: response.progress as VerbProgress }));
      } else {
        const items = await api.listVerbProgress(verb.verb);
        if (items[0]) setVerbProgress((prev) => ({ ...prev, [verb.verb]: items[0] }));
      }
      await refreshPromptProgress(verb.verb);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGrading(false);
    }
  }

  async function submitUsage() {
    if (!verb) return;
    const submitted = usageDrills
      .map((drill) => ({ drill, answer: usageAnswers[drill.id] ?? "" }))
      .filter((item) => item.answer.trim());
    if (!submitted.length) return;
    setUsageGrading(true);
    setError(null);
    setUsageGrade(null);
    try {
      const response = await api.gradeStudy({
        exercise_type: "verb_usage",
        source: "verb_usage",
        lesson_id: `verb-usage:${verb.verb}`,
        section: "usage",
        lesson_context: {
          title: `${verb.verb} usage drills`,
          target_pattern: verb.usageHint || submitted.map(({ drill }) => drill.focus).join("; "),
          verb: verb.verb,
          english_base: verb.englishBase,
          category: verb.category,
          usage_hint: verb.usageHint,
        },
        items: submitted.map(({ drill, answer }) => ({
          client_id: drill.id,
          verb: verb.verb,
          prompt: drill.promptEn,
          expected_answer: drill.expectedEs || "",
          user_answer: answer,
          usage_focus: drill.focus,
        })),
      });
      setUsageGrade(response);
      setUsageAnswers((prev) => {
        const next = { ...prev };
        for (const item of response.items ?? []) {
          if (item.result === "pass" && item.client_id != null) delete next[String(item.client_id)];
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUsageGrading(false);
    }
  }

  async function promoteUsageMiss(missId: number) {
    setPromotingMissId(missId);
    setError(null);
    try {
      const res = await api.promoteLessonMiss(missId);
      setPromotionStatus((prev) => ({
        ...prev,
        [missId]: res.already_promoted ? `Already in timed recall as card #${res.phrase_id}` : `Added to timed recall as card #${res.phrase_id}`,
      }));
    } catch (err) {
      setPromotionStatus((prev) => ({ ...prev, [missId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setPromotingMissId(null);
    }
  }

  async function resetVerb() {
    if (!verb) return;
    setResetting(true);
    setError(null);
    try {
      const progress = await api.resetVerbProgress(verb.verb);
      setVerbProgress((prev) => ({ ...prev, [verb.verb]: progress }));
      setPromptProgress((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${verb.verb}::`)) delete next[key];
        }
        return next;
      });
      clearAnswers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  }

  const filled = visibleRows.filter(({ row, idx }) => normalize(answers[rowKey(row, idx)] ?? "")).length;
  const filledUsage = usageDrills.filter((drill) => normalize(usageAnswers[drill.id] ?? "")).length;
  const gradeByKey = useMemo(() => {
    const map = new Map<string, NonNullable<StudyGradeResponse["items"]>[number]>();
    for (const item of grade?.items ?? []) {
      if (item.client_id != null) map.set(String(item.client_id), item);
    }
    return map;
  }, [grade]);
  const usageGradeByKey = useMemo(() => {
    const map = new Map<string, NonNullable<StudyGradeResponse["items"]>[number]>();
    for (const item of usageGrade?.items ?? []) {
      if (item.client_id != null) map.set(String(item.client_id), item);
    }
    return map;
  }, [usageGrade]);

  async function addVerb(e: { preventDefault(): void }) {
    e.preventDefault();
    const verbValue = newVerb.trim().toLowerCase();
    const englishValue = newEnglishBase.trim().toLowerCase();
    if (!verbValue || !englishValue) {
      setError("Enter both the Spanish verb and the English base meaning.");
      return;
    }
    setAddingVerb(true);
    setError(null);
    try {
      const created = await api.addVerb({
        verb: verbValue,
        english_base: englishValue,
        category: newCategory.trim() || "custom",
        usage_hint: newUsageHint.trim(),
      });
      const refreshed = await api.listVerbCatalog();
      setData(refreshed);
      setVerbName(created.verb);
      setNewVerb("");
      setNewEnglishBase("");
      setNewUsageHint("");
      clearAnswers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingVerb(false);
    }
  }

  if (catalogLoading) {
    return (
      <div className="card card-tile stack center">
        <div className="spinner" aria-hidden="true" />
        <h2>Loading verbs…</h2>
        <p className="muted">Preparing the tile board.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card card-tile stack">
        <div className="row between wrap">
          <div>
            <div className="spanish-kicker">selected verb</div>
            <h2 style={{ margin: 0 }}>{verb?.verb || "—"}</h2>
            <p className="muted" style={{ margin: 0 }}>{verb?.englishBase} · {verb?.category}</p>
          </div>
          <span className={verbComplete ? "pill pill-good" : "pill"}>
            {verbComplete ? "mastered" : `${fullPassCount}/${requiredPasses} perfect`}
          </span>
        </div>
        <label className="field">
          <span>Choose verb</span>
          <select className="input" value={verbName} onChange={(e) => { setVerbName(e.target.value); clearAnswers(); }}>
            {data.verbs.map((v) => {
              const complete = Boolean(verbProgress[v.verb]?.completed);
              return (
                <option key={v.verb} value={v.verb}>
                  {complete ? "✓ " : "○ "}{v.verb} — {v.englishBase || v.category}
                </option>
              );
            })}
          </select>
        </label>

        <div className="alert alert-ok">
          <strong>Full grid mode:</strong> every tense and pronoun is shown for the selected verb.
        </div>

        <form className="card card-tight stack" onSubmit={addVerb}>
          <div className="row between wrap">
            <strong>Add another verb</strong>
            <span className="pill">full grid</span>
          </div>
          <div className="grid-two">
            <label className="field">
              <span>Spanish infinitive</span>
              <input className="input" value={newVerb} onChange={(e) => setNewVerb(e.target.value)} placeholder="bailar" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </label>
            <label className="field">
              <span>English base</span>
              <input className="input" value={newEnglishBase} onChange={(e) => setNewEnglishBase(e.target.value)} placeholder="dance" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </label>
          </div>
          <div className="grid-two">
            <label className="field">
              <span>Category</span>
              <input className="input" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="custom" />
            </label>
            <label className="field">
              <span>Usage hint</span>
              <input className="input" value={newUsageHint} onChange={(e) => setNewUsageHint(e.target.value)} placeholder="optional note" />
            </label>
          </div>
          <button className="btn btn-primary" type="submit" disabled={addingVerb || !newVerb.trim() || !newEnglishBase.trim()}>
            {addingVerb ? "Adding…" : "Add verb to grid"}
          </button>
        </form>

        {verb?.usageHint && (
          <div className="alert">
            <strong>{verb.verb}</strong>: {verb.usageHint}
          </div>
        )}

        <div className={verbComplete ? "alert alert-ok" : "alert"}>
          <div className="row between wrap">
            <span>
              <strong>Verb progress:</strong> {fullPassCount}/{requiredPasses} perfect full-grid runs
              {isIrregular ? " required for irregulars" : ""}
            </span>
            <span>{verbComplete ? "Complete" : "Incomplete"}</span>
          </div>
          <button className="btn btn-small" type="button" disabled={resetting || !verb} onClick={resetVerb}>
            {resetting ? "Resetting…" : "Mark incomplete / reset verb"}
          </button>
        </div>

        <div className="row between small faint">
          <span>{filled}/{visibleRows.length} open prompts answered</span>
          <span>{hiddenPassedCount ? `${hiddenPassedCount} completed hidden` : `${data.count} verbs · ${data.rotationCount} daily · ${verb?.category}`}</span>
        </div>
      </div>

      <div className="card stack">
        <div className="row between wrap">
          <div>
            <h2>Usage drills</h2>
            <p className="muted small">
              These test the verb as usable Spanish: construction, preposition, mood, and natural sentence context.
            </p>
          </div>
          <span className="pill">{filledUsage}/{usageDrills.length} answered</span>
        </div>
        <div className="stack">
          {usageDrills.map((drill, idx) => {
            const itemGrade = usageGradeByKey.get(drill.id);
            const missId = itemGrade?.lesson_miss_id;
            return (
              <div className="stack" key={drill.id}>
                <label className="field">
                  <span>
                    {idx + 1}. {drill.promptEn} <span className="faint">· {drill.focus}</span>
                  </span>
                  <input
                    className="input"
                    value={usageAnswers[drill.id] ?? ""}
                    onChange={(e) => setUsageAnswer(drill.id, e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={`Use ${verb?.verb ?? "the verb"} naturally`}
                  />
                </label>
                {drill.expectedEs && <p className="small faint" style={{ margin: 0 }}>Target model hidden from grading UI: English → Spanish production.</p>}
                {itemGrade && (
                  <div className={resultClass(itemGrade.result)}>
                    <strong>{itemGrade.result.toUpperCase()}</strong> · {itemGrade.feedback}
                    {itemGrade.corrected_answer && <div><strong>Model:</strong> {itemGrade.corrected_answer}</div>}
                    {itemGrade.result !== "pass" && missId && (
                      <div className="stack" style={{ marginTop: "0.75rem" }}>
                        <button className="btn btn-small" type="button" disabled={promotingMissId === missId} onClick={() => promoteUsageMiss(missId)}>
                          {promotingMissId === missId ? "Adding…" : "Add this miss to active timed recall"}
                        </button>
                        {promotionStatus[missId] && <span className="small">{promotionStatus[missId]}</span>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {usageGrade && (
          <div className="alert">
            <strong>Usage model:</strong> {usageGrade.model}<br />
            {usageGrade.summary || usageGrade.next_drill_recommendation}
          </div>
        )}
        <button className="btn btn-primary btn-block" type="button" disabled={usageGrading || filledUsage === 0} onClick={submitUsage}>
          {usageGrading ? "Grading usage…" : "Submit usage drills"}
        </button>
      </div>

      <div className="card stack">
        <h2>Conjugation prompts</h2>
        <p className="muted small">
          Submit sends your answers to the backend LLM grader. Misses are saved for targeted review.
        </p>
        <div className="stack">
          {visibleRows.length === 0 && (
            <div className="alert alert-ok">All visible verb prompts are complete. Reset the verb to bring them back.</div>
          )}
          {visibleRows.map(({ row, idx }) => {
            const key = rowKey(row, idx);
            const itemGrade = gradeByKey.get(key);
            return (
              <div className="stack" key={key}>
                <label className="field">
                  <span>
                    {idx + 1}. {row.translation} <span className="faint">· {row.pronoun} · {row.tense}</span>
                  </span>
                  <input
                    className="input"
                    value={answers[key] ?? ""}
                    onChange={(e) => setAnswer(key, e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={`${row.pronoun} + ${verb?.verb ?? "verb"}`}
                  />
                </label>
                {itemGrade && (
                  <div className={resultClass(itemGrade.result)}>
                    <strong>{itemGrade.result.toUpperCase()}</strong> · {itemGrade.feedback}
                    {itemGrade.corrected_answer && <div><strong>Correct:</strong> {itemGrade.corrected_answer}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {error && <div className="alert alert-danger">{error}</div>}
        {grade && (
          <div className="alert">
            <strong>Model:</strong> {grade.model}<br />
            {grade.summary || grade.next_drill_recommendation}
          </div>
        )}
        <button className="btn btn-primary btn-block" type="button" disabled={grading || filled === 0 || visibleRows.length === 0} onClick={submit}>
          {grading ? "Grading…" : "Submit for LLM grading"}
        </button>
      </div>

      <div className="card stack">
        <button className="btn btn-danger btn-block" type="button" onClick={clearAnswers}>Clear answers</button>
      </div>
    </div>
  );
}
