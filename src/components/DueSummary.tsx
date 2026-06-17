import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { DashboardStats } from "../lib/types";
import { loadSession } from "../lib/timer";

export default function DueSummary() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasResumable, setHasResumable] = useState(false);

  useEffect(() => {
    setHasResumable(!!loadSession());
    let alive = true;
    (async () => {
      try {
        // Server-side aggregation: correct even when the deck grows past the
        // /api/cards 100-row cap (which silently undercounted before).
        const [counts, sourceCount] = await Promise.all([
          api.getDashboardCounts(),
          api.countSources(),
        ]);
        if (alive) {
          setStats({
            dueCount: counts.due_count,
            newCount: counts.new_count,
            learningCount: counts.learning_count,
            reviewCount: counts.review_count,
            totalCards:
              counts.new_count +
              counts.learning_count +
              counts.review_count +
              counts.suspended_count,
            sourceCount,
          });
        }
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : String(err));
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
          You have an unfinished session. <a href="/session">Resume it →</a>
        </div>
      )}

      <div className="stack">
        <a className="btn btn-primary btn-block btn-lg" href="/session?mode=learn">
          Learn first queue
          <span className="small faint"> · meaning + audio before timed recall</span>
        </a>
        <a className="btn btn-block" href="/session?mode=review">
          {hasResumable ? "Resume session" : "Review due"}
        </a>
        <a className="btn btn-block" href="/session?mode=practice">
          Practice anytime <span className="small faint">(no FSRS)</span>
        </a>
        <a className="btn btn-block" href="/session?mode=misses">
          Misses workout <span className="small faint">(redo failed/partial cards)</span>
        </a>
      </div>

      <div className="row between small faint">
        <span>
          {stats ? `${stats.totalCards} cards` : "—"} ·{" "}
          {stats ? `${stats.sourceCount} sources` : "—"}
        </span>
        <a href="/ingest">Add a source →</a>
      </div>
    </div>
  );
}
