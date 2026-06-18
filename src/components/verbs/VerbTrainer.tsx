import { useEffect, useMemo, useState } from "react";
import { api, type StudyGradeResponse, type VerbProgress } from "../../lib/api";

type Assignment = {
  pronoun: string;
  tense: string;
  translation: string;
};

type VerbEntry = {
  verb: string;
  englishBase: string;
  category: string;
  inDailyRotation: boolean;
  usageHint: string;
  assignments: Assignment[];
};

type VerbData = {
  sourceRepo: string;
  count: number;
  rotationCount: number;
  tenses: string[];
  pronouns: string[];
  verbs: VerbEntry[];
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

function resultClass(result?: string) {
  if (result === "pass") return "alert alert-ok";
  if (result === "partial") return "alert";
  if (result === "fail") return "alert alert-danger";
  return "alert";
}

export default function VerbTrainer() {
  const [data, setData] = useState<VerbData>(emptyData);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [verbName, setVerbName] = useState("");
  const [tense, setTense] = useState("Present");
  const [showAllTenses, setShowAllTenses] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [showPromptList, setShowPromptList] = useState(false);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grade, setGrade] = useState<StudyGradeResponse | null>(null);
  const [verbProgress, setVerbProgress] = useState<Record<string, VerbProgress>>({});
  const [resetting, setResetting] = useState(false);

  const verb = useMemo(
    () => data.verbs.find((v) => v.verb === verbName) ?? data.verbs[0],
    [data.verbs, verbName],
  );

  useEffect(() => {
    let alive = true;
    import("../../data/generated/verbs.json")
      .then((mod) => {
        if (!alive) return;
        const loaded = mod.default as VerbData;
        setData(loaded);
        setVerbName((current) => current || loaded.verbs[0]?.verb || "");
        setTense((current) => current || loaded.tenses[0] || "Present");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        if (alive) setCatalogLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const rows = useMemo(() => {
    if (!verb) return [];
    return verb.assignments.filter((a) => showAllTenses || a.tense === tense);
  }, [verb, tense, showAllTenses]);
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

  function setAnswer(key: string, value: string) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    setGrade(null);
    setError(null);
  }

  function clearAnswers() {
    setAnswers({});
    setGrade(null);
    setError(null);
  }

  async function submit() {
    if (!verb) return;
    const submitted = rows
      .map((row, idx) => ({ row, key: rowKey(row, idx), answer: answers[rowKey(row, idx)] ?? "" }))
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
      if (response.progress?.verb) {
        setVerbProgress((prev) => ({ ...prev, [String(response.progress?.verb)]: response.progress as VerbProgress }));
      } else {
        const items = await api.listVerbProgress(verb.verb);
        if (items[0]) setVerbProgress((prev) => ({ ...prev, [verb.verb]: items[0] }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGrading(false);
    }
  }

  async function resetVerb() {
    if (!verb) return;
    setResetting(true);
    setError(null);
    try {
      const progress = await api.resetVerbProgress(verb.verb);
      setVerbProgress((prev) => ({ ...prev, [verb.verb]: progress }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  }

  const filled = rows.filter((row, idx) => normalize(answers[rowKey(row, idx)] ?? "")).length;
  const gradeByKey = useMemo(() => {
    const map = new Map<string, NonNullable<StudyGradeResponse["items"]>[number]>();
    for (const item of grade?.items ?? []) {
      if (item.client_id != null) map.set(String(item.client_id), item);
    }
    return map;
  }, [grade]);
  const promptText = rows
    .map((row, idx) => `${idx + 1}. ${row.translation} (${row.pronoun}, ${row.tense})`)
    .join("\n");

  if (catalogLoading) {
    return (
      <div className="card card-tile stack center">
        <div className="spinner" aria-hidden="true" />
        <h2>Cargando verbos…</h2>
        <p className="muted">Preparando el tablero de azulejos.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card card-tile stack">
        <div className="row between wrap">
          <div>
            <div className="spanish-kicker">verbo elegido</div>
            <h2 style={{ margin: 0 }}>{verb?.verb || "—"}</h2>
            <p className="muted" style={{ margin: 0 }}>{verb?.englishBase} · {verb?.category}</p>
          </div>
          <span className={verbComplete ? "pill pill-good" : "pill"}>
            {verbComplete ? "dominado" : `${fullPassCount}/${requiredPasses} perfectas`}
          </span>
        </div>
        <label className="field">
          <span>Elige verbo</span>
          <select className="input" value={verbName} onChange={(e) => { setVerbName(e.target.value); clearAnswers(); }}>
            {data.verbs.map((v) => (
              <option key={v.verb} value={v.verb}>
                {v.verb} — {v.englishBase || v.category}
              </option>
            ))}
          </select>
        </label>

        <div className="btn-row">
          <button className={showAllTenses ? "btn" : "btn btn-primary"} type="button" onClick={() => { setShowAllTenses(false); clearAnswers(); }}>
            Un tiempo
          </button>
          <button className={showAllTenses ? "btn btn-primary" : "btn"} type="button" onClick={() => { setShowAllTenses(true); clearAnswers(); }}>
            Tablero completo
          </button>
        </div>

        {!showAllTenses && (
          <label className="field">
            <span>Tense</span>
            <select className="input" value={tense} onChange={(e) => { setTense(e.target.value); clearAnswers(); }}>
              {data.tenses.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
        )}

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
          <span>{filled}/{rows.length} prompts answered</span>
          <span>{data.count} verbs · {data.rotationCount} daily · {verb?.category}</span>
        </div>
      </div>

      <div className="card stack">
        <h2>Conjugation prompts</h2>
        <p className="muted small">
          Submit sends your answers to the backend LLM grader. Misses are saved for targeted review.
        </p>
        <div className="stack">
          {rows.map((row, idx) => {
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
        <button className="btn btn-primary btn-block" type="button" disabled={grading || filled === 0} onClick={submit}>
          {grading ? "Grading…" : "Submit for LLM grading"}
        </button>
      </div>

      <div className="card stack">
        <button className="btn btn-block" type="button" onClick={() => setShowPromptList((v) => !v)}>
          {showPromptList ? "Hide" : "Show"} prompt list for Claude/Cursor
        </button>
        {showPromptList && <pre className="code-block">{promptText}</pre>}
        <button className="btn btn-danger btn-block" type="button" onClick={clearAnswers}>Clear answers</button>
      </div>
    </div>
  );
}
