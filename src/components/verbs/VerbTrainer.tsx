import { useEffect, useMemo, useRef, useState } from "react";
import { api, type StudyGradeResponse, type VerbCatalog, type VerbCatalogAssignment, type VerbProgress, type VerbPromptProgress, type LessonPromptProgress, type VerbUsagePrompt } from "../../lib/api";

type Assignment = VerbCatalogAssignment;
type VerbData = VerbCatalog;
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

export default function VerbTrainer() {
  const [data, setData] = useState<VerbData>(emptyData);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [verbName, setVerbName] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grade, setGrade] = useState<StudyGradeResponse | null>(null);
  const autoSubmitSignature = useRef<string>("");
  const autoSubmitUsageSignature = useRef<string>("");
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
  const [activeUsageBatch, setActiveUsageBatch] = useState(1);
  const [usageBank, setUsageBank] = useState<VerbUsagePrompt[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usagePromptProgress, setUsagePromptProgress] = useState<Record<string, LessonPromptProgress>>({});

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
  const usageDrills = usageBank;
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

  async function refreshUsageProgress(targetVerb?: string) {
    const name = targetVerb || verb?.verb;
    if (!name) return;
    const lessonId = `verb-usage:${name}`;
    const items = await api.listLessonPromptProgress(lessonId);
    setUsagePromptProgress(Object.fromEntries(items.map((p) => [p.prompt, p])));
    let nextBatch = 1;
    for (let batch = 1; batch <= 10; batch += 1) {
      const batchItems = items.filter((p) => p.section === `usage-batch-${batch}`);
      const passed = batchItems.filter((p) => p.status === "pass").length;
      if (passed >= 50) nextBatch = Math.min(batch + 1, 10);
      else break;
    }
    setActiveUsageBatch(nextBatch);
  }

  useEffect(() => {
    if (!verb?.verb || !verbComplete) {
      setUsageBank([]);
      setUsagePromptProgress({});
      setActiveUsageBatch(1);
      return;
    }
    let cancelled = false;
    setUsageLoading(true);
    refreshUsageProgress(verb.verb)
      .then(async () => {
        const progressItems = await api.listLessonPromptProgress(`verb-usage:${verb.verb}`);
        let nextBatch = 1;
        for (let batch = 1; batch <= 10; batch += 1) {
          const batchItems = progressItems.filter((p) => p.section === `usage-batch-${batch}`);
          if (batchItems.filter((p) => p.status === "pass").length >= 50) nextBatch = Math.min(batch + 1, 10);
          else break;
        }
        const bank = await api.getVerbUsageBank(verb.verb, nextBatch);
        if (!cancelled) {
          setActiveUsageBatch(nextBatch);
          setUsageBank(bank.prompts ?? []);
          setUsagePromptProgress(Object.fromEntries(progressItems.map((p) => [p.prompt, p])));
        }
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setUsageLoading(false); });
    return () => { cancelled = true; };
  }, [verb?.verb, verbComplete]);

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
    if (!submitted.length) {
      setError(
        visibleRows.length === 0
          ? "Nothing was submitted because every prompt for this verb is already sealed as passed. If you want to redo it, use reset first."
          : "Nothing was submitted because no open prompt has an answer typed."
      );
      return;
    }
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
      if ((response.saved_attempt_count ?? response.items?.length ?? 0) !== submitted.length) {
        throw new Error(`Backend saved ${response.saved_attempt_count ?? 0}/${submitted.length} submitted attempts. Try again; if this repeats, stop and tell Hermes.`);
      }
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
    if (!submitted.length) {
      setError(
        usageDrills.length === 0
          ? "Nothing was submitted because there are no usage prompts loaded for this verb/batch."
          : "Nothing was submitted because no usage prompt has an answer typed."
      );
      return;
    }
    setUsageGrading(true);
    setError(null);
    setUsageGrade(null);
    try {
      const response = await api.gradeStudy({
        exercise_type: "verb_usage",
        source: "verb_usage",
        lesson_id: `verb-usage:${verb.verb}`,
        section: `usage-batch-${activeUsageBatch}`,
        module_total_prompts: 500,
        lesson_context: {
          title: `${verb.verb} usage drills`,
          target_pattern: verb.usageHint || submitted.map(({ drill }) => drill.construction).join("; "),
          verb: verb.verb,
          english_base: verb.englishBase,
          category: verb.category,
          usage_hint: verb.usageHint,
          active_batch: activeUsageBatch,
        },
        items: submitted.map(({ drill, answer }) => ({
          client_id: drill.id,
          verb: verb.verb,
          prompt: drill.prompt_en,
          expected_answer: drill.expected_es || "",
          user_answer: answer,
          usage_focus: drill.construction,
          tense: drill.tense,
          target_vocabulary: drill.target_vocabulary,
        })),
      });
      if ((response.saved_attempt_count ?? response.items?.length ?? 0) !== submitted.length) {
        throw new Error(`Backend saved ${response.saved_attempt_count ?? 0}/${submitted.length} submitted usage attempts. Try again; if this repeats, stop and tell Hermes.`);
      }
      setUsageGrade(response);
      setUsageAnswers((prev) => {
        const next = { ...prev };
        for (const item of response.items ?? []) {
          if (item.result === "pass" && item.client_id != null) delete next[String(item.client_id)];
        }
        return next;
      });
      await refreshUsageProgress(verb.verb);
      const refreshed = await api.listLessonPromptProgress(`verb-usage:${verb.verb}`);
      const currentPassed = refreshed.filter((p) => p.section === `usage-batch-${activeUsageBatch}` && p.status === "pass").length;
      if (currentPassed >= 50 && activeUsageBatch < 10) {
        const next = activeUsageBatch + 1;
        const bank = await api.getVerbUsageBank(verb.verb, next);
        setActiveUsageBatch(next);
        setUsageBank(bank.prompts ?? []);
        setUsageAnswers({});
        setUsageGrade(null);
      }
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

  const filledSignature = useMemo(
    () => visibleRows.map(({ row, idx }) => `${rowKey(row, idx)}:${answers[rowKey(row, idx)] ?? ""}`).join("||"),
    [visibleRows, answers],
  );
  const filledUsageSignature = useMemo(
    () => usageDrills.map((drill) => `${drill.id}:${usageAnswers[drill.id] ?? ""}`).join("||"),
    [usageDrills, usageAnswers],
  );

  useEffect(() => {
    if (!verb || grading || error) return;
    if (visibleRows.length === 0 || filled !== visibleRows.length) return;
    const signature = `${verb.verb}:conjugation:${filledSignature}`;
    if (!filledSignature || autoSubmitSignature.current === signature) return;
    autoSubmitSignature.current = signature;
    const timer = window.setTimeout(() => {
      submit().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [verb?.verb, filled, visibleRows.length, filledSignature, grading, error]);

  useEffect(() => {
    if (!verb || usageGrading || error) return;
    if (usageDrills.length === 0 || filledUsage !== usageDrills.length) return;
    const signature = `${verb.verb}:usage:${activeUsageBatch}:${filledUsageSignature}`;
    if (!filledUsageSignature || autoSubmitUsageSignature.current === signature) return;
    autoSubmitUsageSignature.current = signature;
    const timer = window.setTimeout(() => {
      submitUsage().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [verb?.verb, activeUsageBatch, filledUsage, usageDrills.length, filledUsageSignature, usageGrading, error]);

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
              Unlocks after conjugation mastery. Active batch {activeUsageBatch}/10 shows 50 sentence-production prompts using the C1 concrete Pareto word bank.
            </p>
          </div>
          <span className="pill">{filledUsage}/{usageDrills.length} answered</span>
        </div>
        {!verbComplete && (
          <div className="alert">Complete the conjugation threshold first to unlock real usage batches for this verb.</div>
        )}
        {usageLoading && <div className="alert">Loading usage batch…</div>}
        {verbComplete && !usageLoading && usageDrills.length === 0 && (
          <div className="alert">Usage bank for this verb has not been generated yet. Current curated bank: ser only.</div>
        )}
        <div className="stack">
          {usageDrills.map((drill, idx) => {
            const itemGrade = usageGradeByKey.get(drill.id);
            const missId = itemGrade?.lesson_miss_id;
            const sealed = usagePromptProgress[drill.prompt_en]?.status === "pass";
            return (
              <div className="stack" key={drill.id}>
                <label className="field">
                  <span>
                    {idx + 1}. {drill.prompt_en} <span className="faint">· {drill.tense} · {drill.construction}</span>
                    {sealed && <span className="pill pill-good" style={{ marginLeft: "0.5rem" }}>passed</span>}
                  </span>
                  <input
                    className="input"
                    value={usageAnswers[drill.id] ?? ""}
                    onChange={(e) => setUsageAnswer(drill.id, e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={`Use ${verb?.verb ?? "the verb"} naturally`}
                    disabled={sealed}
                  />
                </label>
                <p className="small faint" style={{ margin: 0 }}>Vocabulary: {(drill.target_vocabulary ?? []).join(", ") || "concrete scene words"}. Target model hidden: English → Spanish production.</p>
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
