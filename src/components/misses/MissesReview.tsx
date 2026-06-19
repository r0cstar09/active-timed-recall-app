import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type LessonMiss,
  type PatternGradeResultItem,
  type PatternMiss,
  type StudyGradeResultItem,
  type VerbMiss,
} from "../../lib/api";

type Tab = "verbs" | "lessons" | "patterns";
type RowResult = StudyGradeResultItem | PatternGradeResultItem;

function resultClass(result?: string) {
  if (result === "pass") return "alert alert-ok";
  if (result === "fail") return "alert alert-danger";
  return "alert";
}

export default function MissesReview() {
  const [tab, setTab] = useState<Tab>("verbs");
  const [verbMisses, setVerbMisses] = useState<VerbMiss[]>([]);
  const [lessonMisses, setLessonMisses] = useState<LessonMiss[]>([]);
  const [patternMisses, setPatternMisses] = useState<PatternMiss[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rowMessage, setRowMessage] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [verbs, lessons, patterns] = await Promise.all([
        api.listVerbMisses(),
        api.listLessonMisses(),
        api.listPatternMisses(),
      ]);
      setVerbMisses(verbs);
      setLessonMisses(lessons);
      setPatternMisses(patterns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const promoteCandidates = useMemo(
    () => lessonMisses.filter((m) => m.should_promote_to_recall),
    [lessonMisses],
  );

  async function retryVerb(miss: VerbMiss) {
    const key = `verbs:${miss.id}`;
    const answer = (answers[key] ?? "").trim();
    if (!answer) return;
    setBusy((b) => ({ ...b, [key]: true }));
    setRowError((e) => ({ ...e, [key]: "" }));
    try {
      const res = await api.gradeStudy({
        exercise_type: "verb_conjugation",
        source: "miss_review",
        items: [{ client_id: String(miss.id), verb: miss.verb, pronoun: miss.pronoun, tense: miss.tense, prompt: miss.prompt ?? "", user_answer: answer }],
      });
      const item = res.items[0];
      if (item) setResults((r) => ({ ...r, [key]: item }));
      if (item?.result === "pass") await refresh();
    } catch (err) {
      setRowError((e) => ({ ...e, [key]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  async function retryLesson(miss: LessonMiss) {
    const key = `lessons:${miss.id}`;
    const answer = (answers[key] ?? "").trim();
    if (!answer) return;
    setBusy((b) => ({ ...b, [key]: true }));
    setRowError((e) => ({ ...e, [key]: "" }));
    try {
      const res = await api.gradeStudy({
        exercise_type: "sentence_lesson",
        source: "miss_review",
        lesson_id: miss.lesson_id,
        section: miss.section ?? undefined,
        lesson_context: miss.target_pattern ? { target_pattern: miss.target_pattern } : {},
        items: [{ client_id: String(miss.id), prompt: miss.prompt, expected_answer: miss.expected_answer ?? "", user_answer: answer }],
      });
      const item = res.items[0];
      if (item) setResults((r) => ({ ...r, [key]: item }));
      if (item?.result === "pass") await refresh();
    } catch (err) {
      setRowError((e) => ({ ...e, [key]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  async function retryPattern(miss: PatternMiss) {
    const key = `patterns:${miss.id}`;
    const answer = (answers[key] ?? "").trim();
    if (!answer || !miss.drill_id) return;
    setBusy((b) => ({ ...b, [key]: true }));
    setRowError((e) => ({ ...e, [key]: "" }));
    try {
      const res = await api.gradePatternDrills([{ drill_id: miss.drill_id, user_answer: answer }]);
      const item = res.items[0];
      if (item) setResults((r) => ({ ...r, [key]: item }));
      if (item?.result === "pass") await refresh();
    } catch (err) {
      setRowError((e) => ({ ...e, [key]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  async function promoteLessonMiss(miss: LessonMiss) {
    const key = `promote:${miss.id}`;
    setBusy((b) => ({ ...b, [key]: true }));
    setRowError((e) => ({ ...e, [key]: "" }));
    setRowMessage((m) => ({ ...m, [key]: "" }));
    try {
      const res = await api.promoteLessonMiss(miss.id);
      setRowMessage((m) => ({
        ...m,
        [key]: res.already_promoted
          ? `Already in timed recall as phrase #${res.phrase_id}.`
          : `Added to timed recall as phrase #${res.phrase_id}.`,
      }));
      await refresh();
    } catch (err) {
      setRowError((e) => ({ ...e, [key]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <div className="btn-row">
          <button className={tab === "verbs" ? "btn btn-primary" : "btn"} type="button" onClick={() => setTab("verbs")}>Verb misses ({verbMisses.length})</button>
          <button className={tab === "lessons" ? "btn btn-primary" : "btn"} type="button" onClick={() => setTab("lessons")}>Sentence misses ({lessonMisses.length})</button>
          <button className={tab === "patterns" ? "btn btn-primary" : "btn"} type="button" onClick={() => setTab("patterns")}>Pattern misses ({patternMisses.length})</button>
        </div>
        <div className="row between small faint">
          <span>Correct answers clear the queue — this is polishing, not punishment.</span>
          <button className="btn" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
        </div>
        {error && <div className="alert alert-danger">{error}</div>}
      </div>

      {tab === "lessons" && promoteCandidates.length > 0 && (
        <div className="card stack">
          <h2>Suggested for active recall</h2>
          <p className="muted small">These missed sentences were natural enough to graduate into your timed-recall deck.</p>
          {promoteCandidates.map((m) => {
            const key = `promote:${m.id}`;
            return (
              <div className="alert" key={`promote-${m.id}`}>
                <strong>{m.corrected_answer || m.expected_answer || m.prompt}</strong>
                {m.prompt && <div className="small faint">{m.prompt}</div>}
                {rowMessage[key] && <div className="small">{rowMessage[key]}</div>}
                {rowError[key] && <div className="small danger-text">{rowError[key]}</div>}
                <button className="btn btn-primary" type="button" disabled={busy[key]} onClick={() => void promoteLessonMiss(m)}>
                  {busy[key] ? "Adding…" : m.promoted_phrase_id ? "Already in timed recall" : "Add to timed recall"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {tab === "verbs" && (
        <div className="stack">
          {!loading && verbMisses.length === 0 && <div className="card"><p className="muted">No open verb misses. Nice.</p></div>}
          {verbMisses.map((miss) => {
            const key = `verbs:${miss.id}`;
            const result = results[key];
            return (
              <div className="card card-tight stack" key={key}>
                <div className="row between wrap"><strong>{miss.verb} · {miss.pronoun} · {miss.tense}</strong><span className="pill pill-warn">missed ×{miss.miss_count}</span></div>
                {miss.prompt && <div className="small">{miss.prompt}</div>}
                {miss.user_answer && <div className="small faint">You wrote: {miss.user_answer}</div>}
                {miss.feedback && <div className="small faint">{miss.feedback}</div>}
                <input className="input" value={answers[key] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [key]: e.target.value }))} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={`${miss.pronoun} + ${miss.verb}`} />
                {result && <div className={resultClass(result.result)}><strong>{result.result.toUpperCase()}</strong> · {result.feedback}{result.corrected_answer && <div><strong>Correct:</strong> {result.corrected_answer}</div>}</div>}
                {rowError[key] && <div className="alert alert-danger">{rowError[key]}</div>}
                <button className="btn btn-primary btn-block" type="button" disabled={busy[key] || !(answers[key] ?? "").trim()} onClick={() => void retryVerb(miss)}>{busy[key] ? "Checking…" : "Check answer"}</button>
              </div>
            );
          })}
        </div>
      )}

      {tab === "lessons" && (
        <div className="stack">
          {!loading && lessonMisses.length === 0 && <div className="card"><p className="muted">No open lesson misses. Nice.</p></div>}
          {lessonMisses.map((miss) => {
            const key = `lessons:${miss.id}`;
            const result = results[key];
            return (
              <div className="card card-tight stack" key={key}>
                <div className="row between wrap"><strong>{miss.lesson_id}{miss.section ? ` · ${miss.section}` : ""}</strong><span className="pill pill-warn">missed ×{miss.miss_count}</span></div>
                <p>{miss.prompt}</p>
                {miss.target_pattern && <div className="small faint">Target: {miss.target_pattern}</div>}
                {miss.user_answer && <div className="small faint">You wrote: {miss.user_answer}</div>}
                {miss.feedback && <div className="small faint">{miss.feedback}</div>}
                {miss.should_promote_to_recall ? (
                  <div className="row wrap" style={{ gap: 8 }}>
                    <span className="pill pill-good">Suggested for active recall</span>
                    <button className="btn" type="button" disabled={busy[`promote:${miss.id}`]} onClick={() => void promoteLessonMiss(miss)}>
                      {busy[`promote:${miss.id}`] ? "Adding…" : miss.promoted_phrase_id ? "Already added" : "Add to timed recall"}
                    </button>
                  </div>
                ) : null}
                {rowMessage[`promote:${miss.id}`] && <div className="alert alert-ok">{rowMessage[`promote:${miss.id}`]}</div>}
                {rowError[`promote:${miss.id}`] && <div className="alert alert-danger">{rowError[`promote:${miss.id}`]}</div>}
                <textarea className="input" rows={3} value={answers[key] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [key]: e.target.value }))} placeholder="Type your Spanish answer..." />
                {result && <div className={resultClass(result.result)}><strong>{result.result.toUpperCase()}</strong> · {result.feedback}{result.corrected_answer && <div><strong>Corrected:</strong> {result.corrected_answer}</div>}</div>}
                {rowError[key] && <div className="alert alert-danger">{rowError[key]}</div>}
                <button className="btn btn-primary btn-block" type="button" disabled={busy[key] || !(answers[key] ?? "").trim()} onClick={() => void retryLesson(miss)}>{busy[key] ? "Checking…" : "Check answer"}</button>
              </div>
            );
          })}
        </div>
      )}

      {tab === "patterns" && (
        <div className="stack" data-pattern-misses="ready">
          {!loading && patternMisses.length === 0 && <div className="card"><p className="muted">No open pattern misses. Nice.</p></div>}
          {patternMisses.map((miss) => {
            const key = `patterns:${miss.id}`;
            const result = results[key];
            return (
              <div className="card card-tight stack" key={key}>
                <div className="row between wrap"><strong>{miss.pattern_id}{miss.verb_id ? ` · ${miss.verb_id}` : ""}</strong><span className="pill pill-warn">missed ×{miss.miss_count}</span></div>
                <p>{miss.prompt_en}</p>
                {miss.user_answer && <div className="small faint">You wrote: {miss.user_answer}</div>}
                {miss.feedback && <div className="small faint">{miss.feedback}</div>}
                {miss.error_tags?.length ? <div className="small faint">Focus: {miss.error_tags.join(", ")}</div> : null}
                <textarea className="input" rows={3} value={answers[key] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [key]: e.target.value }))} placeholder="Type the Spanish answer..." />
                {result && <div className={resultClass(result.result)}><strong>{result.result.toUpperCase()}</strong> · {result.feedback}{result.corrected_answer && <div><strong>Corrected:</strong> {result.corrected_answer}</div>}</div>}
                {rowError[key] && <div className="alert alert-danger">{rowError[key]}</div>}
                <button className="btn btn-primary btn-block" type="button" disabled={busy[key] || !(answers[key] ?? "").trim() || !miss.drill_id} onClick={() => void retryPattern(miss)}>{busy[key] ? "Checking…" : "Check pattern"}</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
