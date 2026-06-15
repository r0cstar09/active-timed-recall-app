import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { IngestJob } from "../lib/types";

const YT_RE =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]{6,}/i;

function statusLabel(status: IngestJob["status"]): string {
  switch (status) {
    case "queued":
      return "Queued…";
    case "processing":
      return "Extracting sentences & slicing audio…";
    case "done":
      return "Done";
    case "error":
      return "Failed";
  }
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

  async function submit(e: React.FormEvent) {
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
      const started = await api.startIngest(trimmed);
      setJob(started);
      if (started.status === "done" || started.status === "error") {
        setBusy(false);
        return;
      }
      pollRef.current = setInterval(async () => {
        try {
          const next = await api.getIngest(started.jobId);
          setJob(next);
          if (next.status === "done" || next.status === "error") {
            stopPolling();
            setBusy(false);
          }
        } catch (err) {
          stopPolling();
          setBusy(false);
          setError(err instanceof ApiError ? err.message : String(err));
        }
      }, 2000);
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

  const progressPct =
    job?.progress != null ? Math.round(job.progress * 100) : null;

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
            <strong>{statusLabel(job.status)}</strong>
            <span
              className={
                job.status === "done"
                  ? "pill pill-good"
                  : job.status === "error"
                    ? "pill pill-bad"
                    : "pill pill-warn"
              }
            >
              {job.status}
            </span>
          </div>

          {progressPct != null && job.status === "processing" && (
            <div
              style={{
                height: 8,
                borderRadius: 999,
                background: "var(--bg-elev-2)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${progressPct}%`,
                  background: "var(--accent-grad)",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          )}

          {job.status === "done" && (
            <>
              <div>
                <div style={{ fontWeight: 600 }}>{job.title ?? "Video added"}</div>
                {job.sentenceCount != null && (
                  <div className="small faint">
                    {job.sentenceCount} sentences extracted
                  </div>
                )}
              </div>
              <div className="btn-row">
                <a className="btn btn-primary" href="/session">
                  Start session
                </a>
                <a className="btn" href="/library">
                  View library
                </a>
              </div>
            </>
          )}

          {job.status === "error" && (
            <div className="small" style={{ color: "var(--bad)" }}>
              {job.error ?? "Ingestion failed. Try a different video."}
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
