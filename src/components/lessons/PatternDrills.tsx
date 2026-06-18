import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type PatternCatalogEntry, type PatternDrill, type PatternPack, type PatternGradeResultItem } from "../../lib/api";

type View = "all" | "unlocked" | "packs";

function patternState(pattern: PatternCatalogEntry) {
  const status = pattern.status || "locked";
  if (status === "locked") return "Locked";
  if (status === "unlocked") return "Unlocked";
  if (status === "drilling") return "Drilling";
  if (status === "mastered") return "Mastered";
  return status.replace(/_/g, " ");
}

function stampClass(status: string) {
  if (status === "locked") return "pill";
  if (status === "mastered" || status === "stable") return "pill pill-good";
  if (status === "unlocked" || status === "drilling") return "pill pill-warn";
  return "pill";
}

function drillKey(drill: PatternDrill) {
  return `pattern-drill:${drill.id}`;
}

export default function PatternDrills() {
  const [patterns, setPatterns] = useState<PatternCatalogEntry[]>([]);
  const [packs, setPacks] = useState<PatternPack[]>([]);
  const [view, setView] = useState<View>("unlocked");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<number, PatternGradeResultItem>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPatterns();
      setPatterns(res.patterns);
      setPacks(res.packs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const unlockedPatterns = useMemo(
    () => patterns.filter((p) => p.status !== "locked"),
    [patterns],
  );
  const visiblePatterns = view === "all" ? patterns : unlockedPatterns;
  const packsByPattern = useMemo(() => {
    const map = new Map<string, PatternPack[]>();
    for (const pack of packs) {
      const arr = map.get(pack.pattern_id) ?? [];
      arr.push(pack);
      map.set(pack.pattern_id, arr);
    }
    return map;
  }, [packs]);

  async function generatePack(pattern: PatternCatalogEntry) {
    const key = `generate:${pattern.id}`;
    setBusy((b) => ({ ...b, [key]: true }));
    setError(null);
    setMessage(null);
    try {
      const res = await api.generatePatternPack(pattern.id, { source_lesson_id: pattern.source_lesson_id, count: 10 });
      setMessage(`Generated ${res.pack.drills.length} drills for ${pattern.name}.`);
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  async function gradeDrill(drill: PatternDrill) {
    const key = drillKey(drill);
    const answer = (answers[key] ?? "").trim();
    if (!answer) return;
    setBusy((b) => ({ ...b, [key]: true }));
    setError(null);
    try {
      const res = await api.gradePatternDrills([{ drill_id: drill.id, user_answer: answer }]);
      const item = res.items[0];
      if (item) setResults((r) => ({ ...r, [drill.id]: item }));
      if (item?.result === "pass") await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  return (
    <div className="stack pattern-drills" data-pattern-drills="ready">
      <section className="card stack pattern-hero">
        <span className="eyebrow">Generated Practice</span>
        <h2>Pattern drills</h2>
        <p className="muted">
          Core lessons unlock patterns. The app then uses an LLM to generate small, saved drill packs so you can practice the same structure with useful verbs without random worksheet chaos.
        </p>
        <div className="btn-row">
          <button className={view === "unlocked" ? "btn btn-primary" : "btn"} type="button" onClick={() => setView("unlocked")}>Unlocked</button>
          <button className={view === "packs" ? "btn btn-primary" : "btn"} type="button" onClick={() => setView("packs")}>Practice packs</button>
          <button className={view === "all" ? "btn btn-primary" : "btn"} type="button" onClick={() => setView("all")}>Catalog</button>
          <button className="btn" type="button" disabled={loading} onClick={() => void refresh()}>{loading ? "Loading…" : "Refresh"}</button>
        </div>
        {message && <div className="alert alert-ok">{message}</div>}
        {error && <div className="alert alert-danger">{error}</div>}
      </section>

      {view !== "packs" && (
        <section className="pattern-grid">
          {!loading && visiblePatterns.length === 0 && (
            <div className="card"><p className="muted">No patterns unlocked yet. Complete core sentence lessons to unlock the first drill pack.</p></div>
          )}
          {visiblePatterns.map((pattern) => {
            const patternPacks = packsByPattern.get(pattern.id) ?? [];
            const sealed = patternPacks.flatMap((p) => p.drills).filter((d) => d.sealed).length;
            const total = patternPacks.flatMap((p) => p.drills).length;
            const canGenerate = pattern.status !== "locked";
            const key = `generate:${pattern.id}`;
            return (
              <article className="card card-tight stack pattern-card" key={pattern.id}>
                <div className="row between wrap">
                  <strong>{pattern.name}</strong>
                  <span className={stampClass(pattern.status)}>{patternState(pattern)}</span>
                </div>
                <div className="pattern-frame">{pattern.frame}</div>
                <p className="small muted">{pattern.description}</p>
                {pattern.examples?.length > 0 && <p className="small faint">Example: {pattern.examples[0]}</p>}
                <div className="row between small faint">
                  <span>{total ? `${sealed}/${total} drills sealed` : "No pack yet"}</span>
                  <span>{pattern.level} · {pattern.target_dialect}</span>
                </div>
                {canGenerate ? (
                  <button className="btn btn-primary btn-block" type="button" disabled={busy[key]} onClick={() => void generatePack(pattern)}>
                    {busy[key] ? "Generating…" : patternPacks.length ? "Generate another pack" : "Generate drill pack"}
                  </button>
                ) : (
                  <div className="alert">Unlock this by sealing enough tagged prompts in core lessons.</div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {(view === "packs" || view === "unlocked") && packs.length > 0 && (
        <section className="stack">
          <div className="row between wrap">
            <h2>Practice packs</h2>
            <span className="pill pill-good">{packs.length} saved</span>
          </div>
          {packs.map((pack) => {
            const pattern = patterns.find((p) => p.id === pack.pattern_id);
            const sealed = pack.drills.filter((d) => d.sealed).length;
            return (
              <article className="card stack" key={pack.id} data-pattern-pack={pack.pattern_id}>
                <div className="row between wrap">
                  <div>
                    <h3>{pattern?.name ?? pack.pattern_id}</h3>
                    <p className="small faint">Saved pack #{pack.id}{pack.source_lesson_id ? ` · from ${pack.source_lesson_id}` : ""}</p>
                  </div>
                  <span className="pill pill-good">{sealed}/{pack.drills.length} sealed</span>
                </div>
                <div className="stack">
                  {pack.drills.map((drill) => {
                    const key = drillKey(drill);
                    const result = results[drill.id];
                    return (
                      <div className="pattern-drill-row" key={drill.id}>
                        <div className="stack tiny-gap">
                          <div className="row between wrap">
                            <strong>{drill.prompt_en}</strong>
                            <span className={drill.sealed ? "pill pill-good" : "pill"}>{drill.sealed ? "sealed" : drill.verb_id || "open"}</span>
                          </div>
                          {drill.grading_notes && <span className="small faint">{drill.grading_notes}</span>}
                        </div>
                        <textarea
                          className="input"
                          rows={2}
                          value={answers[key] ?? ""}
                          onChange={(e) => setAnswers((a) => ({ ...a, [key]: e.target.value }))}
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          placeholder="Type the Spanish sentence…"
                        />
                        {result && (
                          <div className={result.result === "pass" ? "alert alert-ok" : result.result === "fail" ? "alert alert-danger" : "alert"}>
                            <strong>{result.result.toUpperCase()}</strong> · {result.feedback || "Checked."}
                            <div className="small">Correct: {result.corrected_answer}</div>
                            {result.error_tags?.length ? <div className="small faint">Focus: {result.error_tags.join(", ")}</div> : null}
                          </div>
                        )}
                        <button className="btn btn-primary btn-block" type="button" disabled={busy[key] || !(answers[key] ?? "").trim()} onClick={() => void gradeDrill(drill)}>
                          {busy[key] ? "Checking…" : "Check and seal"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
