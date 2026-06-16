import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { IngestJob } from "../lib/types";
import { isIngestComplete, isIngestFailed } from "../lib/types";

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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
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
      if (finishIfTerminal(created)) return;

      pollRef.current = setInterval(async () => {
        try {
          const next = await api.getIngest(created.job_id);
          setJob(next);
          finishIfTerminal(next);
        } catch (err) {
          stopPolling();
          setBusy(false);
          setError(err instanceof ApiError ? err.message : String(err));
        }
      }, 2500);
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  function reset() {
    stopPolling();
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
            <div className="row">
              <div className="spinner spinner-sm" aria-hidden="true" />
              <span className="small faint">
                Extracting transcript, selecting sentences, downloading audio, and slicing clips…
              </span>
            </div>
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
            <div className="small" style={{ color: "var(--bad)" }}>
              Ingestion failed{job.error_message ? `: ${job.error_message}` : ". Try a different video."}
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
