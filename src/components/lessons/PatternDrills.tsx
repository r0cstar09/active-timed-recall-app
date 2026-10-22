import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type PatternCatalogEntry, type PatternDrill, type PatternPack, type PatternPackJob, type PatternGradeResultItem } from "../../lib/api";
import AudioPlayer from "../AudioPlayer";

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

type SavedPatternJob = {
  requestKey: string;
  jobId?: number;
  sourceLessonId?: string | null;
  count: number;
};

const patternJobStorageKey = (patternId: string) => `spanish.patternPackJob:${patternId}`;

function readSavedPatternJob(patternId: string): SavedPatternJob | null {
  try {
    const value = JSON.parse(localStorage.getItem(patternJobStorageKey(patternId)) || "null") as Partial<SavedPatternJob> | null;
    return value && typeof value.requestKey === "string" && value.requestKey.length >= 8
      ? { requestKey: value.requestKey, jobId: value.jobId, sourceLessonId: value.sourceLessonId, count: value.count ?? 10 }
      : null;
  } catch { return null; }
}

function writeSavedPatternJob(patternId: string, value: SavedPatternJob) {
  try { localStorage.setItem(patternJobStorageKey(patternId), JSON.stringify(value)); } catch { /* optional cache */ }
}

function clearSavedPatternJob(patternId: string, requestKey: string) {
  try {
    const saved = readSavedPatternJob(patternId);
    if (saved?.requestKey === requestKey) localStorage.removeItem(patternJobStorageKey(patternId));
  } catch { /* optional cache */ }
}

function newRequestKey() {
  return `pattern:${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}:${Math.random().toString(36).slice(2)}`}`;
}

export default function PatternDrills() {
  const [patterns, setPatterns] = useState<PatternCatalogEntry[]>([]);
  const [packs, setPacks] = useState<PatternPack[]>([]);
  const [view, setView] = useState<View>("unlocked");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [generationJobs, setGenerationJobs] = useState<Record<string, PatternPackJob>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<number, PatternGradeResultItem>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const res = await api.listPatterns();
      setPatterns(res.patterns);
      setPacks(res.packs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!patterns.length) return;
    let cancelled = false;
    for (const pattern of patterns) {
      const saved = readSavedPatternJob(pattern.id);
      if (!saved) continue;
      api.enqueuePatternPack(pattern.id, {
        request_key: saved.requestKey,
        source_lesson_id: saved.sourceLessonId,
        count: saved.count,
      }).then((job) => {
        if (cancelled) return;
        writeSavedPatternJob(pattern.id, {
          requestKey: job.request_key,
          jobId: job.id,
          sourceLessonId: job.source_lesson_id,
          count: job.requested_count,
        });
        setGenerationJobs((current) => ({ ...current, [pattern.id]: job }));
        if (job.status === "completed") {
          clearSavedPatternJob(pattern.id, job.request_key);
          setMessage(`Generated ${job.pack?.drills.length ?? 0} drills. The saved pack is ready.`);
          void refresh(false);
        } else if (job.status === "failed") {
          setError(job.error || "Pattern generation failed. Retry to create a replacement job.");
        }
      }).catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    }
    return () => { cancelled = true; };
  }, [patterns.map((pattern) => pattern.id).join(",")]);

  const generationPollKey = Object.values(generationJobs)
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => `${job.id}:${job.status}`)
    .sort()
    .join(",");
  useEffect(() => {
    if (!generationPollKey) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const active = Object.values(generationJobs).filter((job) => job.status === "queued" || job.status === "running");
      try {
        const updates = await Promise.all(active.map((job) => api.getPatternPackJob(job.id)));
        if (cancelled) return;
        const completed = updates.some((job) => job.status === "completed");
        // React may defer/replay state updaters: no side effects or flags inside.
        setGenerationJobs((current) => ({
          ...current,
          ...Object.fromEntries(updates.map((job) => [job.pattern_id, job])),
        }));
        for (const job of updates) {
          if (job.status === "completed") {
            clearSavedPatternJob(job.pattern_id, job.request_key);
            setMessage(`Generated ${job.pack?.drills.length ?? 0} drills. The saved pack is ready.`);
          } else if (job.status === "failed") {
            setError(job.error || "Pattern generation failed. Retry without losing saved packs.");
          }
        }
        if (completed) await refresh(false);
        if (!cancelled && updates.some((job) => job.status === "queued" || job.status === "running")) {
          timer = setTimeout(poll, 1800);
        }
      } catch (err) {
        if (!cancelled) {
          setError(`Connection interrupted while checking generation. The server job is saved. ${err instanceof Error ? err.message : String(err)}`);
          timer = setTimeout(poll, 2500);
        }
      }
    }
    timer = setTimeout(poll, 800);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [generationPollKey, refresh]);

  const hasPendingAudio = packs.some((pack) => pack.drills.some((drill) => drill.audio_status === "pending"));
  useEffect(() => {
    if (!hasPendingAudio) return;
    const timer = window.setTimeout(() => void refresh(false), 1800);
    return () => window.clearTimeout(timer);
  }, [hasPendingAudio, packs, refresh]);

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
      const saved = readSavedPatternJob(pattern.id);
      const intent: SavedPatternJob = saved ?? {
        requestKey: newRequestKey(),
        sourceLessonId: pattern.source_lesson_id,
        count: 10,
      };
      // Persist intent before POST so a lost enqueue response can be reissued idempotently.
      writeSavedPatternJob(pattern.id, intent);
      const job = await api.enqueuePatternPack(pattern.id, {
        request_key: intent.requestKey,
        source_lesson_id: intent.sourceLessonId,
        count: intent.count,
      });
      writeSavedPatternJob(pattern.id, {
        requestKey: job.request_key,
        jobId: job.id,
        sourceLessonId: job.source_lesson_id,
        count: job.requested_count,
      });
      setGenerationJobs((current) => ({ ...current, [pattern.id]: job }));
      if (job.status === "completed") {
        clearSavedPatternJob(pattern.id, job.request_key);
        setMessage(`Generated ${job.pack?.drills.length ?? 0} drills for ${pattern.name}.`);
        await refresh(false);
      } else if (job.status === "failed") {
        setError(job.error || "Pattern generation failed. Retry to create a replacement job.");
      } else {
        setMessage(`Hermes is generating a saved pack for ${pattern.name}. You can leave and return.`);
      }
    } catch (err) {
      const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      setError(`${msg} The generation request is saved; Retry will reconnect safely.`);
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

  async function promotePack(pack: PatternPack) {
    const key = `promote:${pack.id}`;
    setBusy((b) => ({ ...b, [key]: true }));
    setError(null);
    try {
      const res = await api.promotePatternPack(pack.id);
      setMessage(`${res.promoted} cards are ready in Due Review (FSRS).`);
      await refresh(false);
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
          Core lessons unlock patterns. Packs begin with simple foundations for that pattern, then each new pack adds controlled complexity until advanced tense and mood work.
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
            const generationJob = generationJobs[pattern.id];
            const generationActive = generationJob?.status === "queued" || generationJob?.status === "running";
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
                  <div className="btn-row">
                    <button className="btn btn-primary" type="button" disabled={busy[key] || generationActive} onClick={() => void generatePack(pattern)}>
                      {busy[key] ? "Reconnecting…" : generationActive ? (generationJob.progress_message || "Hermes is generating…") : generationJob?.status === "failed" ? "Retry generation" : patternPacks.length ? "Generate next pack" : "Generate drill pack"}
                    </button>
                    {patternPacks.length > 0 ? (
                      <button className="btn" type="button" onClick={() => setView("packs")}>Open saved packs</button>
                    ) : null}
                  </div>
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
            const promoted = pack.drills.length > 0 && pack.drills.every((d) => Boolean(d.promoted_phrase_id));
            const stage = (pack.difficulty_stage || "foundation").replaceAll("_", " ");
            return (
              <article className="card stack" key={pack.id} data-pattern-pack={pack.pattern_id}>
                <div className="row between wrap">
                  <div>
                    <h3>{pattern?.name ?? pack.pattern_id}</h3>
                    <p className="small faint">
                      Pack #{pack.generation_sequence ?? pack.id} · {stage}{pack.source_lesson_id ? ` · from ${pack.source_lesson_id}` : ""}
                    </p>
                  </div>
                  <span className="pill pill-good">{sealed}/{pack.drills.length} sealed</span>
                </div>
                <button
                  className="btn btn-primary btn-block"
                  type="button"
                  disabled={busy[`promote:${pack.id}`] || promoted}
                  onClick={() => void promotePack(pack)}
                >
                  {busy[`promote:${pack.id}`] ? "Adding cards…" : promoted ? "Added to Due Review" : "Add sealed pack to Due Review · FSRS"}
                </button>
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
                          {drill.audio_url ? (
                            <AudioPlayer src={drill.audio_url} label={`Spanish audio for ${drill.prompt_en}`} />
                          ) : drill.audio_status === "failed" ? (
                            <span className="small faint">Audio is being repaired; the drill is still available.</span>
                          ) : null}
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
