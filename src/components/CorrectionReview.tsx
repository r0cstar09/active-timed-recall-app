import { useEffect, useState } from "react";
import type { Session, SessionItem } from "../lib/types";
import { loadLastGraded } from "../lib/timer";
import AudioPlayer from "./AudioPlayer";

/**
 * Shows the misses (fail / partial) from the most recently graded session,
 * read from localStorage. The backend exposes graded results via
 * GET /api/sessions/:id; we persist the last one when a session completes so it
 * can be reviewed without a dedicated corrections endpoint.
 */
export default function CorrectionReview() {
  const [graded, setGraded] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setGraded(loadLastGraded());
    setReady(true);
  }, []);

  if (!ready) return <div className="card center faint">Loading…</div>;

  const misses: SessionItem[] = (graded?.items ?? []).filter(
    (i) => i.result === "fail" || i.result === "partial",
  );

  if (!graded) {
    return (
      <div className="card center stack">
        <p className="muted">No graded session yet.</p>
        <a className="btn btn-primary" href="/session">Start a session</a>
      </div>
    );
  }

  if (misses.length === 0) {
    return (
      <div className="card center stack">
        <p className="muted">No misses in your last session. 🎯</p>
        <a className="btn btn-primary" href="/session">Start a session</a>
      </div>
    );
  }

  return (
    <div className="stack">
      {misses.map((it) => (
        <div className="card stack" key={it.sprint_item_id}>
          <div className="row between">
            <span className={`pill ${it.result === "partial" ? "pill-warn" : "pill-bad"}`}>
              {it.result}
              {it.score != null ? ` · ${Math.round(it.score)}` : ""}
            </span>
            {it.fsrs_rating && <span className="small faint">FSRS {it.fsrs_rating}</span>}
          </div>

          <div>
            <div className="small faint">Expected</div>
            <div style={{ fontWeight: 600 }}>{it.spanish}</div>
            <div className="small faint">{it.english}</div>
          </div>

          <div>
            <div className="small faint">You said</div>
            <div style={{ color: "var(--text-dim)" }}>
              {it.user_transcript_segment || <em className="faint">(no transcript)</em>}
            </div>
          </div>

          {it.feedback && <div className="alert" style={{ margin: 0 }}>{it.feedback}</div>}

          <AudioPlayer src={it.source_audio_url} label="Native audio" />
        </div>
      ))}
    </div>
  );
}
