import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type VerbCatalog } from "../lib/api";
import type { DashboardStats } from "../lib/types";
import { loadSession } from "../lib/timer";
import { REGIONS, RegionArt, StateIllustration } from "../lib/visuals";

type LastSession = { id: number; score?: number | null; completed_at?: string | null };

function dayPart() {
  const h = new Date().getHours();
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  return "Evening";
}

function scoreLabel(score?: number | null) {
  if (score == null) return "last session saved";
  if (score >= 0.9) return "clean pronunciation energy";
  if (score >= 0.72) return "solid recall, keep the rhythm";
  return "weak spots found — perfect fuel";
}

function queueMood(stats: DashboardStats | null, hasResumable: boolean) {
  if (hasResumable) return { label: "paused mid-flow", tone: "Resume the rep before starting anything new." };
  const due = stats?.dueCount ?? 0;
  const learning = stats?.learningCount ?? 0;
  const fresh = stats?.newCount ?? 0;
  if (due > 12) return { label: "review wave", tone: "Big due stack. Hit reviews first and let the timer sharpen recall." };
  if (due > 0) return { label: "ready to speak", tone: `${due} phrase${due === 1 ? "" : "s"} due. Clear the deck.` };
  if (learning > 0) return { label: "warming up", tone: `${learning} phrase${learning === 1 ? "" : "s"} in learning. Keep the reps moving.` };
  if (fresh > 0) return { label: "fresh material", tone: "No urgent reviews. Pull in new phrases or run a freestyle sprint." };
  return { label: "quiet deck", tone: "Add a source, drill verbs, or practice patterns while FSRS waits." };
}

export default function DueSummary() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [lastSession, setLastSession] = useState<LastSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasResumable, setHasResumable] = useState(false);
  const [verbCompletion, setVerbCompletion] = useState({ completed: 0, total: 0 });
  const [lessonCompletion, setLessonCompletion] = useState({ completed: 0, total: 0 });

  useEffect(() => {
    setHasResumable(!!loadSession());
    let alive = true;
    (async () => {
      try {
        const [counts, sourceCount, rawStats, verbCatalog, verbProgress, lessonProgress, lessonCatalog] = await Promise.all([
          api.getDashboardCounts(),
          api.countSources(),
          api.getStats(),
          api.listVerbCatalog().catch(async () => {
            const mod = await import("../data/generated/verbs.json");
            return mod.default as VerbCatalog;
          }),
          api.listVerbProgress().catch(() => []),
          api.listLessonProgress().catch(() => []),
          import("../data/generated/fuzzy_lessons.json").then((mod) => mod.default as { count: number }),
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
        setVerbCompletion({
          completed: verbProgress.filter((p) => Number(p.completed) === 1).length,
          total: verbCatalog.count || verbCatalog.verbs?.length || 0,
        });
        setLessonCompletion({
          completed: lessonProgress.filter((p) => Number(p.completed) === 1).length,
          total: lessonCatalog.count || 0,
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

  const mood = useMemo(() => queueMood(stats, hasResumable), [hasResumable, stats]);
  const primaryHref = hasResumable ? "/session" : (stats?.dueCount ?? 0) > 0 ? "/session?mode=review" : "/session?mode=practice";
  const completion = stats ? Math.min(100, Math.round(((stats.reviewCount + stats.learningCount) / Math.max(1, stats.totalCards)) * 100)) : 0;
  const MOSAIC_TILES = 16;
  const filledTiles = Math.round((completion / 100) * MOSAIC_TILES);
  const verbPct = verbCompletion.total ? Math.round((verbCompletion.completed / verbCompletion.total) * 100) : 0;
  const lessonPct = lessonCompletion.total ? Math.round((lessonCompletion.completed / lessonCompletion.total) * 100) : 0;

  return (
    <div className="stack dashboard-stack">
      {error && (
        <div className="alert alert-error">
          {error}
          <div className="small faint" style={{ marginTop: 6 }}>
            Confirm the backend is reachable over Tailscale, then check the API base URL in Settings.
          </div>
        </div>
      )}
      {loading && <div className="mini-loading"><StateIllustration type="loading" /><span>Stamping today’s queue…</span></div>}

      <div className="mission-card" style={{ "--region-accent": REGIONS[(new Date().getDate() - 1) % REGIONS.length].accent } as React.CSSProperties}>
        <RegionArt region={REGIONS[(new Date().getDate() - 1) % REGIONS.length].key} className="mission-region-art" />
        <div className="mission-mosaic" role="img" aria-label={`${completion}% of your deck is active`}>
          {Array.from({ length: MOSAIC_TILES }).map((_, i) => (
            <span key={i} className={i < filledTiles ? "m-tile filled" : "m-tile"} />
          ))}
          <small className="m-tile-label">{loading ? "·" : `${completion}% active`}</small>
        </div>
        <div className="mission-content stack">
          <div className="row between wrap">
            <div>
              <div className="spanish-kicker">Today's mission · {dayPart()} · {mood.label}</div>
              <h2 style={{ margin: 0 }}>Speak with rhythm, not hesitation.</h2>
            </div>
            <span className="flavor-badge">sabor mode</span>
          </div>
          <p className="muted" style={{ margin: 0 }}>{loading ? "Loading today’s speaking queue…" : mood.tone}</p>
          <div className="row wrap" style={{ gap: 10 }}>
            <a className="btn btn-primary btn-lg" href={primaryHref}>{hasResumable ? "Resume the flow" : "Start speaking"}</a>
            <a className="btn btn-azul" href="/session?mode=learn">Learn phrases</a>
            <a className="btn btn-ghost" href="/session?mode=practice">Freestyle sprint</a>
          </div>
        </div>
      </div>

      <div className="score-strip">
        <div className="score-ring" style={{ "--pct": `${completion}%` } as React.CSSProperties}>
          <strong>{loading ? "·" : `${completion}%`}</strong>
          <span>active</span>
        </div>
        <div className="score-copy">
          <div className="spanish-kicker">momentum</div>
          <strong>{lastSession ? scoreLabel(lastSession.score) : "build today’s first rep"}</strong>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {stats ? `${stats.totalCards} phrase cards · ${stats.sourceCount} sources · ${stats.reviewCount} mature reviews` : "Loading library totals…"}
          </p>
        </div>
      </div>

      <div className="card stack progress-card">
        <div className="row between wrap">
          <div>
            <div className="spanish-kicker">visible progress</div>
            <strong>Curriculum completion</strong>
          </div>
          <span className="pill">verbs + sentence lessons</span>
        </div>
        <div className="progress-row">
          <div className="row between small">
            <span>Verb grids completed</span>
            <strong>{loading ? "·" : `${verbCompletion.completed}/${verbCompletion.total} (${verbPct}%)`}</strong>
          </div>
          <div className="progress-track" aria-label={`Verb progress ${verbPct}%`}><span style={{ width: `${verbPct}%` }} /></div>
        </div>
        <div className="progress-row">
          <div className="row between small">
            <span>Sentence lessons completed</span>
            <strong>{loading ? "·" : `${lessonCompletion.completed}/${lessonCompletion.total} (${lessonPct}%)`}</strong>
          </div>
          <div className="progress-track" aria-label={`Sentence lesson progress ${lessonPct}%`}><span style={{ width: `${lessonPct}%` }} /></div>
        </div>
      </div>

      <div className="metric-board metric-board-pop" aria-label="Practice counts">
        <div className="metric-card hot">
          <div className="metric-icon">🔥</div>
          <div className="num">{loading ? "·" : (stats?.dueCount ?? 0)}</div>
          <div className="lbl">due to speak</div>
        </div>
        <div className="metric-card rhythm">
          <div className="metric-icon">🎧</div>
          <div className="num">{loading ? "·" : (stats?.learningCount ?? 0)}</div>
          <div className="lbl">finding rhythm</div>
        </div>
        <div className="metric-card cool">
          <div className="metric-icon">✨</div>
          <div className="num">{loading ? "·" : (stats?.newCount ?? 0)}</div>
          <div className="lbl">new sparks</div>
        </div>
      </div>

      <div className="action-grid action-grid-pop">
        <a className="action-card action-card-red" href="/session?mode=review">
          <span>primero</span>
          <strong>Clear reviews</strong>
          <small>Lock in due Spanish under real timer pressure.</small>
        </a>
        <a className="action-card action-card-blue" href="/verbs">
          <span>motor</span>
          <strong>Drill verbs</strong>
          <small>Conjugation grids that feel like reps, not worksheets.</small>
        </a>
        <a className="action-card action-card-gold" href="/lessons">
          <span>patrón</span>
          <strong>Build patterns</strong>
          <small>From meaning to flexible Spanish sentence shapes.</small>
        </a>
        <a className="action-card action-card-green" href="/misses">
          <span>pulir</span>
          <strong>Polish misses</strong>
          <small>Weak spots become targeted recall fuel.</small>
        </a>
      </div>
    </div>
  );
}
