import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Stats } from "../lib/types";
import { loadSession } from "../lib/timer";

export default function DueSummary() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasResumable, setHasResumable] = useState(false);

  useEffect(() => {
    setHasResumable(!!loadSession());
    let alive = true;
    (async () => {
      try {
        const s = await api.getStats();
        if (alive) setStats(s);
      } catch (err) {
        if (alive) {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="stack">
      {error && (
        <div className="alert alert-error">
          {error}
          <div className="small faint" style={{ marginTop: 6 }}>
            Confirm the backend is reachable over Tailscale, then check the API
            base URL in Settings.
          </div>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat">
          <div className="num">{loading ? "·" : (stats?.dueCount ?? 0)}</div>
          <div className="lbl">Due</div>
        </div>
        <div className="stat">
          <div className="num">{loading ? "·" : (stats?.newCount ?? 0)}</div>
          <div className="lbl">New</div>
        </div>
        <div className="stat">
          <div className="num">{loading ? "·" : (stats?.learningCount ?? 0)}</div>
          <div className="lbl">Learning</div>
        </div>
      </div>

      {hasResumable && (
        <div className="alert">
          You have an unfinished session.{" "}
          <a href="/session">Resume it →</a>
        </div>
      )}

      <a className="btn btn-primary btn-block btn-lg" href="/session">
        {hasResumable ? "Resume session" : "Start recall session"}
      </a>

      <div className="row between small faint">
        <span>
          {stats ? `${stats.totalCards} cards` : "—"} ·{" "}
          {stats ? `${stats.videoCount} videos` : "—"}
        </span>
        <a href="/ingest">Add a video →</a>
      </div>
    </div>
  );
}
