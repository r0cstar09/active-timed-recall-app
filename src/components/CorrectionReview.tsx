import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { CorrectionCard } from "../lib/types";
import AudioPlayer from "./AudioPlayer";

export default function CorrectionReview() {
  const [items, setItems] = useState<CorrectionCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setItems(await api.listCorrections());
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
        setItems([]);
      }
    })();
  }, []);

  if (error && !items) return <div className="alert alert-error">{error}</div>;
  if (!items) return <div className="card center faint">Loading corrections…</div>;
  if (items.length === 0) {
    return (
      <div className="card center stack">
        <p className="muted">No failed cards to review. 🎯</p>
        <a className="btn btn-primary" href="/session">
          Start a session
        </a>
      </div>
    );
  }

  return (
    <div className="stack">
      {error && <div className="alert alert-error">{error}</div>}
      {items.map((c) => (
        <div className="card stack" key={c.attemptId}>
          <div className="row between">
            <span className="pill pill-bad">Failed</span>
            {c.videoTitle && (
              <span className="small faint truncate" style={{ maxWidth: "60%" }}>
                {c.videoTitle}
              </span>
            )}
          </div>

          <div>
            <div className="small faint">Expected</div>
            <div style={{ fontWeight: 600 }}>{c.expectedTranscript}</div>
          </div>

          <div>
            <div className="small faint">You said</div>
            <div style={{ color: "var(--text-dim)" }}>
              {c.userTranscript || <em className="faint">(no transcript)</em>}
            </div>
          </div>

          {c.correction && (
            <div className="alert" style={{ margin: 0 }}>
              {c.correction}
            </div>
          )}

          <AudioPlayer src={c.nativeAudioUrl} label="Native audio" />
          {c.userAudioUrl && (
            <AudioPlayer src={c.userAudioUrl} label="Your recording" />
          )}
        </div>
      ))}
    </div>
  );
}
