import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { IngestJob } from "../lib/types";
import { isIngestComplete, isIngestFailed } from "../lib/types";
import PipelineProgress from "./PipelineProgress";

const INGEST_STORAGE_KEY = "atr.ingest.active";
const INGEST_TTL_MS = 24 * 60 * 60 * 1000;

const YT_RE =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]{6,}/i;

const TERMINAL_STATUSES = new Set(["complete", "partial", "failed"]);

function statusLabel(job: IngestJob): string {
  if (job.status === "partial") return "partial";
  if (isIngestComplete(job)) return "ready";
  if (isIngestFailed(job)) return "failed";
  return job.status || "processing";
}

export default function IngestForm() {
  const [urlValue, setUrlValue] = useState("");
  const [job, setJob] = useState<IngestJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verbValue, setVerbValue] = useState("");
  const [verbEnglish, setVerbEnglish] = useState("");
  const [verbHint, setVerbHint] = useState("");
  const [verbBusy, setVerbBusy] = useState(false);
  const [verbAdded, setVerbAdded] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = localStorage.getItem(INGEST_STORAGE_KEY);
        let saved: { jobId: number; createdAt: number } | null = raw ? JSON.parse(raw) : null;
        if (saved && Date.now() - saved.createdAt > INGEST_TTL_MS) {
          localStorage.removeItem(INGEST_STORAGE_KEY);
          saved = null;
        }
        if (saved) {
          const restored = await api.getIngest(saved.jobId);
          if (!alive) return;
          setJob(restored);
          setBusy(!TERMINAL_STATUSES.has(restored.status));
          if (!TERMINAL_STATUSES.has(restored.status)) startPolling(restored.job_id);
          return;
        }
        const recent = await api.getRecentIngests(10);
        const active = recent.find((candidate) => !TERMINAL_STATUSES.has(candidate.status));
        if (alive && active) {
          setJob(active);
          setBusy(true);
          localStorage.setItem(INGEST_STORAGE_KEY, JSON.stringify({ jobId: active.job_id, createdAt: Date.now() }));
          startPolling(active.job_id);
        }
      } catch {
        localStorage.removeItem(INGEST_STORAGE_KEY);
      }
    })();
    return () => {
      alive = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function finishIfTerminal(next: IngestJob): boolean {
    if (TERMINAL_STATUSES.has(next.status)) {
      stopPolling();
      setBusy(false);
      return true;
    }
    return false;
  }

  function startPolling(jobId: number) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const next = await api.getIngest(jobId);
        setJob(next);
        finishIfTerminal(next);
      } catch (err) {
        // Polling is only observation. The durable server job keeps running;
        // retain its id so navigation/refresh can reconnect later.
        setError(err instanceof ApiError ? err.message : String(err));
      }
    }, 1000);
  }

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    setError(null);
    const trimmed = urlValue.trim();
    if (!YT_RE.test(trimmed)) {
      setError("Enter a valid YouTube URL.");
      return;
    }
    setBusy(true);
    stopPolling();
    try {
      const created = await api.createIngest(trimmed);
      setJob(created);
      localStorage.setItem(INGEST_STORAGE_KEY, JSON.stringify({ jobId: created.job_id, createdAt: Date.now() }));
      if (finishIfTerminal(created)) return;
      startPolling(created.job_id);
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError ? err.message : String(err));
    }
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

  function reset() {
    stopPolling();
    localStorage.removeItem(INGEST_STORAGE_KEY);
    setJob(null);
    setUrlValue("");
    setError(null);
    setBusy(false);
  }

  const done = job && isIngestComplete(job);
  const failed = job && isIngestFailed(job);
  const phraseCount = job?.phrases?.length ?? 0;

  return (
    <div className="stack">
      <form onSubmit={submit} className="card">
        <label className="field">
          <span>YouTube URL</span>
          <input
            className="input"
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://youtube.com/watch?v=…"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            disabled={busy}
          />
        </label>
        <button
          className="btn btn-primary btn-block"
          type="submit"
          disabled={busy || !urlValue.trim()}
        >
          {busy ? "Ingesting…" : "Ingest video"}
        </button>
      </form>

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

      {error && <div className="alert alert-error">{error}</div>}

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
            <span className="pill">phrases: {phraseCount}</span>
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
                Added or found {phraseCount} phrase{phraseCount === 1 ? "" : "s"}. New phrases appear in Learn first.
              </div>
              {phraseCount > 0 && (
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

          <button className="btn btn-ghost btn-block" onClick={reset}>
            Ingest another
          </button>
        </div>
      )}
    </div>
  );
}
