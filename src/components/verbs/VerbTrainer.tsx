import { useMemo, useState } from "react";
import { api, type StudyGradeResponse } from "../../lib/api";
import verbsData from "../../data/generated/verbs.json";

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

const data = verbsData as {
  sourceRepo: string;
  count: number;
  rotationCount: number;
  tenses: string[];
  pronouns: string[];
  verbs: VerbEntry[];
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
  const [verbName, setVerbName] = useState(data.verbs[0]?.verb ?? "ser");
  const [tense, setTense] = useState(data.tenses[0] ?? "Present");
  const [showAllTenses, setShowAllTenses] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [showPromptList, setShowPromptList] = useState(false);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grade, setGrade] = useState<StudyGradeResponse | null>(null);

  const verb = useMemo(
    () => data.verbs.find((v) => v.verb === verbName) ?? data.verbs[0],
    [verbName],
  );

  const rows = useMemo(() => {
    if (!verb) return [];
    return verb.assignments.filter((a) => showAllTenses || a.tense === tense);
  }, [verb, tense, showAllTenses]);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGrading(false);
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

  return (
    <div className="stack">
      <div className="card stack">
        <label className="field">
          <span>Verb</span>
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
            One tense
          </button>
          <button className={showAllTenses ? "btn btn-primary" : "btn"} type="button" onClick={() => { setShowAllTenses(true); clearAnswers(); }}>
            Full grid
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
