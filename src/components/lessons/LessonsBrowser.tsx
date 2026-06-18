import { useEffect, useMemo, useState } from "react";
import { api, type StudyGradeResponse } from "../../lib/api";

type LessonSection = {
  instructions: string;
  prompts: string[];
  answers: string[];
};

type Lesson = {
  id: string;
  number: number;
  title: string;
  difficulty: string;
  patternId: string;
  tags: string[];
  targetPattern: string;
  englishTrap: string;
  spanishLogic: string;
  formula: string[];
  naturalExamples: string[];
  sections: Record<string, LessonSection>;
  commonErrors: Array<{ mistake?: string; why_it_happens?: string; correct_spanish?: string }>;
};

type LessonsData = { sourceRepo: string; count: number; lessons: Lesson[] };

const emptyLessonsData: LessonsData = { sourceRepo: "", count: 0, lessons: [] };
const sectionOrder = ["controlled", "mutation", "contrast", "writing", "reverse"] as const;
const sectionLabels: Record<string, string> = {
  controlled: "Controlled recombination",
  mutation: "Pattern mutation",
  contrast: "Contrastive discrimination",
  writing: "Guided writing",
  reverse: "Reverse expression",
};

function resultClass(result?: string) {
  if (result === "pass") return "alert alert-ok";
  if (result === "partial") return "alert";
  if (result === "fail") return "alert alert-danger";
  return "alert";
}

export default function LessonsBrowser() {
  const [data, setData] = useState<LessonsData>(emptyLessonsData);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [lessonId, setLessonId] = useState("");
  const [sectionName, setSectionName] = useState<string>("controlled");
  const [showAnswers, setShowAnswers] = useState(false);
  const [responses, setResponses] = useState<Record<number, string>>({});
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grade, setGrade] = useState<StudyGradeResponse | null>(null);
  const [lessonProgress, setLessonProgress] = useState<Record<string, { total_prompts: number; passed_prompts: number; completed: number }>>({});
  const [promoting, setPromoting] = useState<Record<number, string>>({});
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let alive = true;
    import("../../data/generated/fuzzy_lessons.json")
      .then((mod) => {
        if (!alive) return;
        const loaded = mod.default as LessonsData;
        setData(loaded);
        setLessonId((current) => current || loaded.lessons[0]?.id || "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        if (alive) setCatalogLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data.lessons;
    return data.lessons.filter((l) =>
      [l.title, l.patternId, l.targetPattern, l.difficulty, ...(l.tags ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [data.lessons, query]);

  const lesson = data.lessons.find((l) => l.id === lessonId) ?? filtered[0] ?? data.lessons[0];
  const section = lesson?.sections?.[sectionName] ?? lesson?.sections?.controlled;
  const moduleTotalPrompts = useMemo(() => {
    if (!lesson) return 0;
    return Object.values(lesson.sections ?? {}).reduce((sum, s) => sum + (s.prompts?.length ?? 0), 0);
  }, [lesson]);
  const currentProgress = lesson ? lessonProgress[lesson.id] : undefined;
  const progressTotal = currentProgress?.total_prompts || moduleTotalPrompts;
  const lessonComplete = Boolean(currentProgress?.completed);

  async function refreshLessonProgress(targetLessonId?: string) {
    const items = await api.listLessonProgress(targetLessonId);
    setLessonProgress((prev) => ({ ...prev, ...Object.fromEntries(items.map((p) => [p.lesson_id, p])) }));
  }

  useEffect(() => {
    let cancelled = false;
    api.listLessonProgress().then((items) => {
      if (cancelled) return;
      setLessonProgress(Object.fromEntries(items.map((p) => [p.lesson_id, p])));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  function resetWork() {
    setShowAnswers(false);
    setResponses({});
    setGrade(null);
    setError(null);
  }

  function pickLesson(id: string) {
    setLessonId(id);
    resetWork();
  }

  function setResponse(idx: number, value: string) {
    setResponses((prev) => ({ ...prev, [idx]: value }));
    setGrade(null);
    setError(null);
  }

  async function submit() {
    if (!lesson || !section) return;
    const submitted = section.prompts
      .map((prompt, idx) => ({ prompt, idx, answer: responses[idx] ?? "" }))
      .filter((item) => item.answer.trim());
    if (!submitted.length) return;
    setGrading(true);
    setError(null);
    setGrade(null);
    try {
      const response = await api.gradeStudy({
        exercise_type: "sentence_lesson",
        source: "fuzzy_funicular",
        lesson_id: lesson.id,
        section: sectionName,
        lesson_context: {
          title: lesson.title,
          target_pattern: lesson.targetPattern,
          english_trap: lesson.englishTrap,
          spanish_logic: lesson.spanishLogic,
          formula: lesson.formula,
          natural_examples: lesson.naturalExamples,
        },
        module_total_prompts: moduleTotalPrompts,
        items: submitted.map(({ prompt, idx, answer }) => ({
          client_id: String(idx),
          prompt,
          expected_answer: section.answers?.[idx] ?? "",
          user_answer: answer,
        })),
      });
      setGrade(response);
      if (response.progress?.lesson_id) {
        setLessonProgress((prev) => ({
          ...prev,
          [String(response.progress?.lesson_id)]: response.progress as { total_prompts: number; passed_prompts: number; completed: number },
        }));
      } else {
        await refreshLessonProgress(lesson.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGrading(false);
    }
  }

  async function resetModuleProgress() {
    if (!lesson) return;
    setResetting(true);
    setError(null);
    try {
      const progress = await api.resetLessonProgress(lesson.id);
      setLessonProgress((prev) => ({ ...prev, [lesson.id]: progress }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  }

  async function promoteMiss(missId: number) {
    setPromoting((prev) => ({ ...prev, [missId]: "Adding…" }));
    setError(null);
    try {
      const result = await api.promoteLessonMiss(missId);
      setPromoting((prev) => ({
        ...prev,
        [missId]: result.already_promoted ? "Already in active recall" : `Added card #${result.phrase_id}`,
      }));
    } catch (err) {
      setPromoting((prev) => ({ ...prev, [missId]: "Failed" }));
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const filled = section?.prompts?.filter((_, idx) => responses[idx]?.trim()).length ?? 0;
  const gradeByIndex = useMemo(() => {
    const map = new Map<number, NonNullable<StudyGradeResponse["items"]>[number]>();
    for (const item of grade?.items ?? []) {
      if (item.client_id != null) map.set(Number(item.client_id), item);
    }
    return map;
  }, [grade]);

  if (catalogLoading) {
    return (
      <div className="card notebook-card stack center">
        <div className="spinner" aria-hidden="true" />
        <h2>Abriendo el cuaderno…</h2>
        <p className="muted">Cargando patrones, trampas y ejemplos naturales.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card notebook-card stack">
        <div>
          <div className="spanish-kicker">biblioteca de patrones</div>
          <h2 style={{ margin: 0 }}>Busca una estructura que quieras dominar</h2>
        </div>
        <label className="field">
          <span>Buscar en el cuaderno</span>
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="subjunctive, reported speech, se me..." />
        </label>
        <label className="field">
          <span>Lesson</span>
          <select className="input" value={lesson?.id ?? ""} onChange={(e) => pickLesson(e.target.value)}>
            {filtered.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title} {l.difficulty ? `(${l.difficulty})` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="row between small faint">
          <span>{filtered.length}/{data.count} lessons</span>
          <span>{lesson?.id}</span>
        </div>
      </div>

      {lesson && (
        <>
          <div className="card stack">
            <div className="row between wrap">
              <h2>{lesson.title}</h2>
              {lesson.difficulty && <span className="pill pill-warn">{lesson.difficulty}</span>}
            </div>
            {lesson.targetPattern && <p>{lesson.targetPattern}</p>}
            <div className={lessonComplete ? "alert alert-ok" : "alert"}>
              <div className="row between wrap">
                <span><strong>Module progress:</strong> {currentProgress?.passed_prompts ?? 0}/{progressTotal || 0} prompts passed</span>
                <span>{lessonComplete ? "Complete" : "Incomplete"}</span>
              </div>
              <button className="btn btn-small" type="button" disabled={resetting} onClick={resetModuleProgress}>
                {resetting ? "Resetting…" : "Mark incomplete / reset module"}
              </button>
            </div>
            {lesson.spanishLogic && <div className="alert"><strong>Spanish logic:</strong> {lesson.spanishLogic}</div>}
            {lesson.englishTrap && <div className="alert"><strong>English trap:</strong> {lesson.englishTrap}</div>}
            {!!lesson.formula?.length && (
              <div>
                <h3>Formula</h3>
                <ul>{lesson.formula.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            )}
            {!!lesson.naturalExamples?.length && (
              <div>
                <h3>Natural examples</h3>
                <ul>{lesson.naturalExamples.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            )}
          </div>

          <div className="card stack">
            <label className="field">
              <span>Drill section</span>
              <select className="input" value={sectionName} onChange={(e) => { setSectionName(e.target.value); resetWork(); }}>
                {sectionOrder
                  .filter((name) => lesson.sections?.[name]?.prompts?.length)
                  .map((name) => <option key={name} value={name}>{sectionLabels[name]}</option>)}
              </select>
            </label>
            {section?.instructions && <p className="muted">{section.instructions}</p>}
            <div className="row between small faint">
              <span>{filled}/{section?.prompts?.length ?? 0} responses filled</span>
              <span>LLM graded by backend</span>
            </div>
            <div className="stack">
              {section?.prompts?.map((prompt, idx) => {
                const itemGrade = gradeByIndex.get(idx);
                return (
                  <div className="card card-tight stack" key={`${prompt}-${idx}`}>
                    <div className="small faint">Prompt {idx + 1}</div>
                    <p>{prompt}</p>
                    <textarea
                      className="input"
                      rows={3}
                      value={responses[idx] ?? ""}
                      onChange={(e) => setResponse(idx, e.target.value)}
                      placeholder="Type your Spanish answer..."
                    />
                    {itemGrade && (
                      <div className={resultClass(itemGrade.result)}>
                        <strong>{itemGrade.result.toUpperCase()}</strong> · {itemGrade.feedback}
                        {itemGrade.corrected_answer && <div><strong>Corrected:</strong> {itemGrade.corrected_answer}</div>}
                        {itemGrade.should_promote_to_recall && (
                          <div className="stack gap-small">
                            <div className="small">Suggested for active timed recall.</div>
                            {itemGrade.lesson_miss_id ? (
                              <button
                                className="btn"
                                type="button"
                                disabled={promoting[itemGrade.lesson_miss_id] === "Adding…"}
                                onClick={() => promoteMiss(itemGrade.lesson_miss_id as number)}
                              >
                                {promoting[itemGrade.lesson_miss_id] ?? "Add to active timed recall"}
                              </button>
                            ) : (
                              <div className="small faint">Submit again if no miss ID was returned.</div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {showAnswers && section.answers?.[idx] && (
                      <div className="alert alert-ok"><strong>Answer key:</strong> {section.answers[idx]}</div>
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
            <button className="btn btn-block" type="button" onClick={() => setShowAnswers((v) => !v)}>
              {showAnswers ? "Hide answers" : "Reveal answer key"}
            </button>
          </div>

          {!!lesson.commonErrors?.length && (
            <div className="card stack">
              <h2>Common errors</h2>
              {lesson.commonErrors.map((err, idx) => (
                <div className="alert" key={idx}>
                  {err.mistake && <div><strong>Mistake:</strong> {err.mistake}</div>}
                  {err.why_it_happens && <div><strong>Why:</strong> {err.why_it_happens}</div>}
                  {err.correct_spanish && <div><strong>Correct:</strong> {err.correct_spanish}</div>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
