import { useEffect, useReducer, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { IngestJob } from "../lib/types";
import { isIngestComplete, isIngestFailed } from "../lib/types";
import {
  INITIAL_INGEST_DELETE_UI,
  canChangeIngestSelection,
  createIngestDeleteGate,
  executeIngestCardDeletion,
  ingestActivePhraseCount,
  ingestDeleteUnavailableMessage,
  ingestDeleteUiReducer,
  ingestPhraseCount,
  isTerminalIngest,
  mergeRecentIngests,

} from "../lib/ingestJobs";
import PipelineProgress from "./PipelineProgress";
import ManualCuration from "./ManualCuration";

const INGEST_STORAGE_KEY = "atr.ingest.active";
const INGEST_TTL_MS = 24 * 60 * 60 * 1000;

function statusLabel(job: IngestJob): string {
  if (job.status === "partial") return "partial";
  if (isIngestComplete(job)) return "ready";
  if (isIngestFailed(job)) return "failed";
  return job.status || "processing";
}

export default function IngestForm() {

  const [job, setJob] = useState<IngestJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verbValue, setVerbValue] = useState("");
  const [verbEnglish, setVerbEnglish] = useState("");
  const [verbHint, setVerbHint] = useState("");
  const [verbBusy, setVerbBusy] = useState(false);
  const [verbAdded, setVerbAdded] = useState<string | null>(null);
  const [recentJobs, setRecentJobs] = useState<IngestJob[]>([]);
  const [restoring, setRestoring] = useState(true);
  const [openingJobId, setOpeningJobId] = useState<number | null>(null);
  const [deleteUi, dispatchDeleteUi] = useReducer(ingestDeleteUiReducer, INITIAL_INGEST_DELETE_UI);
  const deleteGateRef = useRef(createIngestDeleteGate());
  const openingJobRef = useRef<number | null>(null);
  const creatingRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollJobRef = useRef<number | null>(null);

  function forgetJob() {
    try { localStorage.removeItem(INGEST_STORAGE_KEY); } catch { /* optional browser cache */ }
  }

  function rememberJob(jobId: number) {
    try { localStorage.setItem(INGEST_STORAGE_KEY, JSON.stringify({ jobId, createdAt: Date.now() })); }
    catch { /* Server history and polling work without optional browser storage. */ }
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      let recent: IngestJob[] = [];
      try {
        recent = await api.getRecentIngests(10);
        if (alive) setRecentJobs(recent);
      } catch (err) {
        // Recent history is helpful recovery state, but must not prevent a
        // specifically saved job from reconnecting.
        if (alive) setError(`Could not load recent ingestion jobs: ${err instanceof Error ? err.message : String(err)}`);
      }

      let saved: { jobId: number; createdAt: number } | null = null;
      try {
        const raw = localStorage.getItem(INGEST_STORAGE_KEY);
        saved = raw ? JSON.parse(raw) : null;
        if (
          saved
          && (!Number.isInteger(saved.jobId) || Date.now() - saved.createdAt > INGEST_TTL_MS)
        ) {
          forgetJob();
          saved = null;
        }
      } catch {
        forgetJob();
      }

      if (saved) {
        try {
          const restored = await api.getIngest(saved.jobId);
          if (!alive) return;
          setJob(restored);
          setRecentJobs((current) => mergeRecentIngests(current, [restored]));
          setBusy(!isTerminalIngest(restored));
          if (!isTerminalIngest(restored)) startPolling(restored.job_id);
          return;
        } catch (err) {
          if (!alive) return;
          if (err instanceof ApiError && err.status === 404) {
            forgetJob();
          } else {
            setError(`Could not restore the saved job. Use Refresh to retry: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
        }
      }

      const active = recent.find((candidate) => !isTerminalIngest(candidate));
      if (alive && active) {
        setJob(active);
        setBusy(true);
        rememberJob(active.job_id);
        startPolling(active.job_id);
      }
    })().finally(() => { if (alive) setRestoring(false); });
    return () => {
      alive = false;
      stopPolling();
    };
  }, []);

  function stopPolling() {
    pollJobRef.current = null;
    setPollError(null);
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function finishIfTerminal(next: IngestJob): boolean {
    if (isTerminalIngest(next)) {
      stopPolling();
      setBusy(false);
      return true;
    }
    return false;
  }

  function startPolling(jobId: number) {
    stopPolling();
    pollJobRef.current = jobId;
    let inFlight = false;
    pollRef.current = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await api.getIngest(jobId);
        if (pollJobRef.current !== jobId) return;
        setPollError(null);
        setJob(next);
        setRecentJobs((current) => mergeRecentIngests(current, [next]));
        finishIfTerminal(next);
      } catch (err) {
        // Polling is only observation. The durable server job keeps running;
        // retain its id so navigation/refresh can reconnect later.
        if (pollJobRef.current !== jobId) return;
        setPollError(err instanceof ApiError ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    }, 1000);
  }


  async function addVerb(e: { preventDefault(): void }) {
    e.preventDefault();
    const verb = verbValue.trim().toLowerCase();
    const english = verbEnglish.trim().toLowerCase();
    if (!verb || !english) {
      setError("Enter both the Spanish verb and English base meaning.");
      return;
    }
    setVerbBusy(true);
    setError(null);
    setVerbAdded(null);
    try {
      const created = await api.addVerb({ verb, english_base: english, category: "custom", usage_hint: verbHint.trim() });
      setVerbAdded(`${created.verb} added to the full verb grid.`);
      setVerbValue("");
      setVerbEnglish("");
      setVerbHint("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setVerbBusy(false);
    }
  }

  async function removeJobCards() {
    if (busy || creatingRef.current || !job || openingJobRef.current !== null || deleteUi.confirmJobId !== job.job_id) return;
    const target = job;
    setError(null);
    const outcome = await executeIngestCardDeletion(
      target,
      (jobId) => api.removeIngestCards(jobId),
      deleteGateRef.current,
      () => dispatchDeleteUi({ type: "started", jobId: target.job_id }),
    );
    if (outcome.status === "success") {
      setJob((current) => current?.job_id === target.job_id ? outcome.job : current);
      setRecentJobs((current) => mergeRecentIngests(current, [outcome.job]));
      dispatchDeleteUi({
        type: "succeeded",
        jobId: target.job_id,
        removedCount: outcome.result.removed_count,
        historyPreserved: outcome.result.history_preserved === true,
      });
    } else if (outcome.status === "refused") {
      if ("job" in outcome) {
        setJob((current) => current?.job_id === target.job_id ? outcome.job : current);
        setRecentJobs((current) => mergeRecentIngests(current, [outcome.job]));
      }
      dispatchDeleteUi({ type: "refused", jobId: target.job_id, error: outcome.message });
    } else if (outcome.status === "error") {
      dispatchDeleteUi({
        type: "failed",
        jobId: target.job_id,
        error: outcome.error instanceof ApiError ? outcome.error.message : String(outcome.error),
      });
    }
  }

  function reset() {
    if (creatingRef.current || openingJobRef.current !== null || !canChangeIngestSelection(deleteGateRef.current)) return;
    stopPolling();
    forgetJob();
    setJob(null);

    setError(null);
    dispatchDeleteUi({ type: "reset" });
    setBusy(false);
  }

  async function openRecentJob(jobId: number) {
    if (restoring || busy || creatingRef.current || openingJobRef.current !== null) return;
    const selected = canChangeIngestSelection(deleteGateRef.current)
      ? recentJobs.find((candidate) => candidate.job_id === jobId) : undefined;
    if (!selected) return;
    stopPolling();
    openingJobRef.current = jobId;
    setOpeningJobId(jobId);
    setError(null);
    dispatchDeleteUi({ type: "selectionChanged" });
    try {
      const detailed = await api.getIngest(jobId);
      setJob(detailed);
      setRecentJobs((current) => mergeRecentIngests(current, [detailed]));
      setBusy(!isTerminalIngest(detailed));
      rememberJob(jobId);
      if (!isTerminalIngest(detailed)) startPolling(jobId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      openingJobRef.current = null;
      setOpeningJobId(null);
    }
  }

  const done = job && isIngestComplete(job);
  const failed = job && isIngestFailed(job);
  const phraseCount = ingestPhraseCount(job);
  const activePhraseCount = ingestActivePhraseCount(job);
  const terminal = isTerminalIngest(job);
  const deleteBusy = Boolean(job && deleteUi.deletingJobId === job.job_id);
  const deleteConfirm = Boolean(job && deleteUi.confirmJobId === job.job_id);
  const recentVisibleJobs = mergeRecentIngests(recentJobs, []);
  const selectionLocked = restoring || busy || openingJobId !== null || deleteUi.deletingJobId !== null;
  const deleteUnavailable = ingestDeleteUnavailableMessage(job);

  return (
    <div className="stack">
      <ManualCuration />

      <h2>Legacy auto-ingest history &amp; custom verbs</h2>

      <form onSubmit={addVerb} className="card stack">
        <div>
          <div className="spanish-kicker">verb grid</div>
          <h2 style={{ margin: 0 }}>Add another verb</h2>
          <p className="muted small" style={{ margin: "4px 0 0" }}>Adds the verb to the full conjugation grid.</p>
        </div>
        <div className="grid-two">
          <label className="field">
            <span>Spanish infinitive</span>
            <input className="input" value={verbValue} onChange={(e) => setVerbValue(e.target.value)} placeholder="bailar" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={verbBusy} />
          </label>
          <label className="field">
            <span>English base</span>
            <input className="input" value={verbEnglish} onChange={(e) => setVerbEnglish(e.target.value)} placeholder="dance" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={verbBusy} />
          </label>
        </div>
        <label className="field">
          <span>Usage hint</span>
          <input className="input" value={verbHint} onChange={(e) => setVerbHint(e.target.value)} placeholder="optional note" disabled={verbBusy} />
        </label>
        <button className="btn btn-primary btn-block" type="submit" disabled={verbBusy || !verbValue.trim() || !verbEnglish.trim()}>
          {verbBusy ? "Adding…" : "Add verb"}
        </button>
        {verbAdded && <div className="alert alert-ok">{verbAdded}</div>}
      </form>

      {error && <div className="error-box" role="alert">{error}</div>}
      {pollError && <div className="error-box" role="alert">{pollError}</div>}

      <section className="card stack" aria-label="Recent ingestion jobs">
        <div className="row between wrap">
          <h2 style={{ margin: 0 }}>Recent ingestion jobs</h2>
          <button className="btn btn-ghost" type="button" disabled={selectionLocked} onClick={() => window.location.reload()}>Refresh history</button>
        </div>
        <p className="small faint" style={{ margin: 0 }}>Reopen a completed ingestion to inspect or remove only its cards.</p>
        {restoring && <p role="status">Loading ingestion history…</p>}
        {!restoring && recentVisibleJobs.length === 0 && <p className="small faint">No ingestion jobs found.</p>}
        {recentVisibleJobs.map((recent) => (
          <button className="btn btn-block" type="button" key={recent.job_id}
            disabled={selectionLocked} aria-pressed={job?.job_id === recent.job_id}
            onClick={() => void openRecentJob(recent.job_id)}>
            Job #{recent.job_id} · {statusLabel(recent)} · {recent.ownership_unknown ? "ownership unknown" : `${ingestActivePhraseCount(recent)} active cards`}
          </button>
        ))}
        {openingJobId !== null && <p role="status">Opening job #{openingJobId}…</p>}
      </section>

      {job && (
        <div className="card stack">
          <div className="row between">
            <strong>Ingestion job #{job.job_id}</strong>
            <span
              className={
                done ? "pill pill-good" : failed ? "pill pill-bad" : "pill pill-warn"
              }
            >
              {statusLabel(job)}
            </span>
          </div>

          <div className="row wrap" style={{ gap: 8 }}>
            <span className="pill">status: {job.status}</span>
            <span className="pill">phrases: {job.ownership_unknown ? "unknown" : phraseCount}</span>
            <span className="pill">active cards: {job.ownership_unknown ? "unknown" : activePhraseCount}</span>
          </div>

          {!done && !failed && (
            <PipelineProgress progress={job.progress} fallbackStatus={job.status} />
          )}

          {done && (
            <div className="stack">
              {job.status === "partial" && (
                <div className="alert alert-warn">
                  Ingest completed partially. Some slices may have failed, but usable phrases were added.
                </div>
              )}
              <div className="small faint">
                {job.ownership_unknown ? "This legacy job needs ownership verification before its cards can be removed." : `${phraseCount} cards belong to this job; ${activePhraseCount} remain active.`} New phrases appear in Learn first.
              </div>
              {phraseCount !== null && phraseCount > 0 && (
                <div className="stack">
                  {job.phrases?.slice(0, 5).map((phrase) => (
                    <div className="card card-compact" key={phrase.id}>
                      <strong>{phrase.spanish}</strong>
                      <div className="small faint">{phrase.english}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="btn-row">
                <a className="btn btn-primary" href="/session?mode=learn">Learn new phrases</a>
                <a className="btn" href="/library">View library</a>
              </div>
            </div>
          )}

          {failed && (
            <div className="stack">
              <PipelineProgress progress={job.progress} fallbackStatus={job.status} />
              <div className="small" style={{ color: "var(--bad)" }}>
                Ingestion failed{job.error_message ? `: ${job.error_message}` : ". Try a different video."}
              </div>
            </div>
          )}

          {deleteUi.message && <div className="alert alert-ok" role="status">{deleteUi.message}</div>}
          {deleteUi.error && <div className="alert alert-error" role="alert">{deleteUi.error}</div>}
          {!terminal && <div className="small faint">Delete available when ingestion finishes.</div>}
          {terminal && deleteUnavailable && <div className="alert alert-warn" role="status">{deleteUnavailable}</div>}

          {terminal && !deleteUnavailable && activePhraseCount !== null && activePhraseCount > 0 && (
            deleteConfirm ? (
              <div className="remove-confirm">
                <strong>Remove all {activePhraseCount} cards from this ingestion?</strong>
                <p>
                  They will disappear from Learn and Review. Their review history and source audio records are preserved.
                </p>
                <div className="btn-row">
                  <button className="btn btn-danger" type="button" onClick={removeJobCards} disabled={busy || deleteBusy || openingJobId !== null}>
                    {deleteBusy ? "Removing…" : "Yes, remove all cards"}
                  </button>
                  <button className="btn" type="button" onClick={() => dispatchDeleteUi({ type: "cancel" })} disabled={deleteBusy}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn btn-danger btn-block" type="button" onClick={() => dispatchDeleteUi({ type: "confirm", job })} disabled={selectionLocked}>
                Delete all cards from this ingestion
              </button>
            )
          )}

          <button className="btn btn-ghost btn-block" type="button" onClick={reset}
            disabled={restoring || creatingRef.current || openingJobId !== null || deleteUi.deletingJobId !== null}>
            {busy ? "Stop watching this job" : "Ingest another"}
          </button>
        </div>
      )}
    </div>
  );
}
