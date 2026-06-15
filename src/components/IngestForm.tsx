import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { SourceRaw } from "../lib/types";
import { isStatusFailed, isStatusReady } from "../lib/types";

const YT_RE =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]{6,}/i;

function bothDone(s: SourceRaw): boolean {
  return isStatusReady(s.transcript_status) && isStatusReady(s.audio_status);
}
function anyFailed(s: SourceRaw): boolean {
  return isStatusFailed(s.transcript_status) || isStatusFailed(s.audio_status);
}

export default function IngestForm() {
  const [urlValue, setUrlValue] = useState("");
  const [source, setSource] = useState<SourceRaw | null>(null);
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
      const created = await api.createSource(trimmed);
      setSource(created);
      if (bothDone(created) || anyFailed(created)) {
        setBusy(false);
        return;
      }
      pollRef.current = setInterval(async () => {
        try {
          const next = await api.getSource(created.id);
          setSource(next);
          if (bothDone(next) || anyFailed(next)) {
            stopPolling();
            setBusy(false);
          }
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
    setSource(null);
    setUrlValue("");
    setError(null);
    setBusy(false);
  }

  const done = source && bothDone(source);
  const failed = source && anyFailed(source);

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

      {source && (
        <div className="card stack">
          <div className="row between">
            <strong className="truncate" style={{ maxWidth: "70%" }}>
              {source.title ?? source.source_url}
            </strong>
            <span
              className={
                done ? "pill pill-good" : failed ? "pill pill-bad" : "pill pill-warn"
              }
            >
              {done ? "ready" : failed ? "failed" : "processing"}
            </span>
          </div>

          <div className="row wrap" style={{ gap: 8 }}>
            <span className="pill">transcript: {source.transcript_status ?? "—"}</span>
            <span className="pill">audio: {source.audio_status ?? "—"}</span>
          </div>

          {!done && !failed && (
            <div className="row">
              <div className="spinner spinner-sm" aria-hidden="true" />
              <span className="small faint">
                Extracting sentences & slicing audio…
              </span>
            </div>
          )}

          {done && (
            <div className="btn-row">
              <a className="btn btn-primary" href="/session">Start session</a>
              <a className="btn" href="/library">View library</a>
            </div>
          )}

          {failed && (
            <div className="small" style={{ color: "var(--bad)" }}>
              Ingestion failed. Try a different video.
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
