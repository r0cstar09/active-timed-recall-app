import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { DashboardStats } from "../lib/types";
import { loadSession } from "../lib/timer";

type LastSession = { id: number; score?: number | null; completed_at?: string | null };

function dayPart() {
  const h = new Date().getHours();
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  return "Evening";
}

function scoreLabel(score?: number | null) {
  if (score == null) return "last session saved";
  if (score >= 0.9) return "sharp last session";
  if (score >= 0.72) return "solid last session";
  return "good data for review";
}

export default function DueSummary() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [lastSession, setLastSession] = useState<LastSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasResumable, setHasResumable] = useState(false);

  useEffect(() => {
    setHasResumable(!!loadSession());
    let alive = true;
    (async () => {
      try {
        const [counts, sourceCount, rawStats] = await Promise.all([
          api.getDashboardCounts(),
          api.countSources(),
          api.getStats(),
        ]);
        if (!alive) return;
        setStats({
          dueCount: counts.due_count,
          newCount: counts.new_count,
          learningCount: counts.learning_count,
          reviewCount: counts.review_count,
          totalCards: counts.new_count + counts.learning_count + counts.review_count + counts.suspended_count,
          sourceCount,
        });
        if (rawStats && typeof rawStats === "object" && "last_session" in rawStats) {
          setLastSession((rawStats as { last_session?: LastSession | null }).last_session ?? null);
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

  const mission = useMemo(() => {
    if (loading) return "Loading today’s speaking queue…";
    const due = stats?.dueCount ?? 0;
    const learning = stats?.learningCount ?? 0;
    const fresh = stats?.newCount ?? 0;
    if (hasResumable) return "You have a paused speaking session waiting.";
    if (due > 0) return `${due} phrase${due === 1 ? "" : "s"} due. Clear those first.`;
    if (learning > 0) return `${learning} phrase${learning === 1 ? "" : "s"} warming up. Keep them moving.`;
    if (fresh > 0) return "No urgent reviews. Add a few new phrases or do a free practice sprint.";
    return "Your deck is quiet. Add a source or practice verbs while FSRS waits.";
  }, [hasResumable, loading, stats]);

  const primaryHref = hasResumable ? "/session" : (stats?.dueCount ?? 0) > 0 ? "/session?mode=review" : "/session?mode=practice";

  return (
    <div className="stack">
      {error && (
        <div className="alert alert-error">
          {error}
          <div className="small faint" style={{ marginTop: 6 }}>
            Confirm the backend is reachable over Tailscale, then check the API base URL in Settings.
          </div>
        </div>
      )}

      <div className="ritual-panel">
        <div className="voice-orb voice-orb-small" aria-hidden="true"><span></span></div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="spanish-kicker">{dayPart()} practice</div>
          <h2 style={{ margin: 0 }}>Today’s mission</h2>
          <p className="muted" style={{ margin: 0 }}>{mission}</p>
          <div className="row wrap" style={{ gap: 10 }}>
            <a className="btn btn-primary btn-lg" href={primaryHref}>{hasResumable ? "Resume speaking" : "Start speaking"}</a>
            <a className="btn" href="/session?mode=learn">Learn new phrases</a>
          </div>
        </div>
      </div>

      <div className="metric-board" aria-label="Practice counts">
        <div className="metric-card hot">
          <div className="num">{loading ? "·" : (stats?.dueCount ?? 0)}</div>
          <div className="lbl">due to speak</div>
        </div>
        <div className="metric-card">
          <div className="num">{loading ? "·" : (stats?.learningCount ?? 0)}</div>
          <div className="lbl">in learning</div>
        </div>
        <div className="metric-card cool">
          <div className="num">{loading ? "·" : (stats?.newCount ?? 0)}</div>
          <div className="lbl">new available</div>
        </div>
      </div>

      <div className="action-grid">
        <a className="action-card" href="/session?mode=review">
          <span>01</span>
          <strong>Clear reviews</strong>
          <small>FSRS due queue, spoken answers only.</small>
        </a>
        <a className="action-card" href="/verbs">
          <span>02</span>
          <strong>Drill verbs</strong>
          <small>Tile-board conjugation practice.</small>
        </a>
        <a className="action-card" href="/lessons">
          <span>03</span>
          <strong>Build patterns</strong>
          <small>Meaning → variation → fast production.</small>
        </a>
        <a className="action-card" href="/misses">
          <span>04</span>
          <strong>Polish misses</strong>
          <small>Turn weak spots into targeted recall.</small>
        </a>
      </div>

      <div className="card stack compact-card">
        <div className="row between wrap">
          <div>
            <div className="spanish-kicker">momentum</div>
            <strong>{lastSession ? scoreLabel(lastSession.score) : "ready when you are"}</strong>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              {stats ? `${stats.totalCards} phrase cards · ${stats.sourceCount} sources` : "Loading library totals…"}
            </p>
          </div>
          <a className="btn btn-small" href="/ingest">Add source</a>
        </div>
      </div>
    </div>
  );
}
