import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type VerbCatalog } from "../lib/api";
import type { DashboardStats } from "../lib/types";
import { loadSession } from "../lib/timer";
import { REGIONS, RegionArt, StateIllustration } from "../lib/visuals";

function dayPart() {
  const h = new Date().getHours();
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  return "Evening";
}

function queueMood(stats: DashboardStats | null, hasResumable: boolean) {
  if (hasResumable) return { label: "paused mid-flow", tone: "Resume the rep before starting anything new." };
  const due = stats?.dueCount ?? 0;
  const learning = stats?.learningCount ?? 0;
  const fresh = stats?.newCount ?? 0;
  if (due > 12) return { label: "review wave", tone: "Big due stack. Clear reviews first, then move into lessons or verb grids." };
  if (due > 0) return { label: "reviews ready", tone: `${due} sentence${due === 1 ? "" : "s"} due. Clear the review queue and keep your spoken recall moving.` };
  if (learning > 0) return { label: "lesson loop", tone: `${learning} sentence${learning === 1 ? "" : "s"} still learning. Finish the loop, then practice speaking.` };
  if (fresh > 0) return { label: "new lessons", tone: "No urgent reviews. Learn sentence cards, drill verbs, or start a speaking sprint." };
  return { label: "open route", tone: "Add a source, drill verbs, learn sentence patterns, or practice speaking while FSRS waits." };
}

export default function DueSummary() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasResumable, setHasResumable] = useState(false);
  const [verbCompletion, setVerbCompletion] = useState({ completed: 0, total: 0 });
  const [lessonCompletion, setLessonCompletion] = useState({ completed: 0, total: 0 });
  const [patternCompletion, setPatternCompletion] = useState({ unlocked: 0, total: 0, packs: 0, sealed: 0, drills: 0 });
  const [missCounts, setMissCounts] = useState({ lessons: 0, verbs: 0, patterns: 0 });

  useEffect(() => {
    setHasResumable(!!loadSession());
    let alive = true;
    (async () => {
      try {
        const [counts, sourceCount, verbCatalog, verbProgress, lessonProgress, lessonCatalog, lessonMisses, verbMisses, patternState, patternMisses] = await Promise.all([
          api.getDashboardCounts(),
          api.countSources(),
          api.listVerbCatalog().catch(async () => {
            const mod = await import("../data/generated/verbs.json");
            return mod.default as VerbCatalog;
          }),
          api.listVerbProgress().catch(() => []),
          api.listLessonProgress().catch(() => []),
          import("../data/generated/fuzzy_lessons.json").then((mod) => mod.default as { count: number }),
          api.listLessonMisses(200).catch(() => []),
          api.listVerbMisses(200).catch(() => []),
          api.listPatterns().catch(() => ({ patterns: [], packs: [] })),
          api.listPatternMisses(200).catch(() => []),
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
        const allDrills = patternState.packs.flatMap((p) => p.drills ?? []);
        setPatternCompletion({
          unlocked: patternState.patterns.filter((p) => p.status !== "locked").length,
          total: patternState.patterns.length,
          packs: patternState.packs.length,
          sealed: allDrills.filter((d) => d.sealed).length,
          drills: allDrills.length,
        });
        setMissCounts({
          lessons: lessonMisses.filter((m) => m.status !== "cleared").length,
          verbs: verbMisses.filter((m) => m.status !== "cleared").length,
          patterns: patternMisses.filter((m) => m.status !== "cleared" && m.status !== "resolved").length,
        });
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
  const completion = stats ? Math.min(100, Math.round(((stats.reviewCount + stats.learningCount) / Math.max(1, stats.totalCards)) * 100)) : 0;
  const MOSAIC_TILES = 16;
  const filledTiles = Math.round((completion / 100) * MOSAIC_TILES);
  const verbPct = verbCompletion.total ? Math.round((verbCompletion.completed / verbCompletion.total) * 100) : 0;
  const lessonPct = lessonCompletion.total ? Math.round((lessonCompletion.completed / lessonCompletion.total) * 100) : 0;
  const dueCount = stats?.dueCount ?? 0;
  const lessonRemaining = Math.max(0, lessonCompletion.total - lessonCompletion.completed);
  const verbRemaining = Math.max(0, verbCompletion.total - verbCompletion.completed);
  const patternPct = patternCompletion.drills ? Math.round((patternCompletion.sealed / patternCompletion.drills) * 100) : (patternCompletion.unlocked ? 20 : 0);
  const openMisses = missCounts.lessons + missCounts.verbs + missCounts.patterns;
  const passportPct = Math.round((verbPct + lessonPct + patternPct + Math.max(0, 100 - Math.min(100, openMisses * 8))) / 4);
  const nextFocus = hasResumable
    ? { label: "Resume session", href: "/session", note: "Finish the interrupted speaking rep before adding more work." }
    : dueCount > 0
      ? { label: "Clear reviews", href: "/session?mode=review", note: `${dueCount} due card${dueCount === 1 ? "" : "s"} are blocking clean momentum.` }
      : openMisses > 0
        ? { label: "Polish misses", href: "/misses", note: `${openMisses} open miss${openMisses === 1 ? "" : "es"} should become targeted recall fuel.` }
        : patternCompletion.unlocked > patternCompletion.packs
          ? { label: "Generate pattern pack", href: "/lessons/patterns", note: `${patternCompletion.unlocked - patternCompletion.packs} unlocked pattern${patternCompletion.unlocked - patternCompletion.packs === 1 ? "" : "s"} need saved drill packs.` }
          : patternCompletion.drills > patternCompletion.sealed
            ? { label: "Seal pattern drills", href: "/lessons/patterns", note: `${patternCompletion.drills - patternCompletion.sealed} generated pattern drill${patternCompletion.drills - patternCompletion.sealed === 1 ? "" : "s"} still open.` }
        : lessonRemaining > verbRemaining
          ? { label: "Sentence lessons", href: "/lessons", note: `${lessonRemaining} lesson${lessonRemaining === 1 ? "" : "s"} left in the pattern library.` }
          : { label: "Verb grids", href: "/verbs", note: `${verbRemaining} verb grid${verbRemaining === 1 ? "" : "s"} left to lock in.` };
  const heatSeed = (stats?.reviewCount ?? 0) + (stats?.learningCount ?? 0) + (stats?.sourceCount ?? 0);
  const heatCells = Array.from({ length: 35 }, (_, i) => {
    const age = 34 - i;
    const activeToday = heatSeed > 0 && age < Math.min(35, Math.max(2, Math.ceil(completion / 4)));
    const level = !activeToday ? 0 : Math.max(1, Math.min(4, ((heatSeed + i * 3) % 5)));
    return level;
  });

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
              <div className="spanish-kicker">Today's route · {dayPart()} · {mood.label}</div>
              <h2 style={{ margin: 0 }}>Move the bottleneck, earn the stamp.</h2>
            </div>
            <span className="flavor-badge">next: {nextFocus.label}</span>
          </div>
          <p className="muted" style={{ margin: 0 }}>{loading ? "Checking reviews, sentence lessons, verb grids, and open misses…" : nextFocus.note}</p>
          <div className="row wrap" style={{ gap: 10 }}>
            <a className="btn btn-primary btn-lg" href={nextFocus.href}>{nextFocus.label}</a>
            <a className="btn btn-azul" href="/lessons">Sentence lessons</a>
            <a className="btn btn-ghost" href="/verbs">Verb grids</a>
          </div>
        </div>
      </div>

      <div className="score-strip">
        <div className="score-ring" style={{ "--pct": `${completion}%` } as React.CSSProperties}>
          <strong>{loading ? "·" : `${completion}%`}</strong>
          <span>active</span>
        </div>
        <div className="score-copy">
          <div className="spanish-kicker">passport readiness</div>
          <strong>{loading ? "calculating the route" : `${passportPct}% toward the next visible milestone`}</strong>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {stats ? `${dueCount} due · ${openMisses} open misses · ${patternCompletion.unlocked} patterns unlocked · ${lessonRemaining} lessons left · ${verbRemaining} verb grids left` : "Loading library totals…"}
          </p>
        </div>
      </div>

      <div className="route-board" aria-label="Today’s progress route">
        <a className={`route-card ${dueCount ? "urgent" : "done"}`} href="/session?mode=review">
          <span>1</span><strong>{dueCount} reviews due</strong><small>{dueCount ? "Clear these before new work." : "Review queue clear."}</small>
        </a>
        <a className={`route-card ${openMisses ? "urgent" : "done"}`} href="/misses">
          <span>2</span><strong>{openMisses} misses open</strong><small>{missCounts.lessons} lesson · {missCounts.verbs} verb · {missCounts.patterns} pattern</small>
        </a>
        <a className="route-card" href="/lessons">
          <span>3</span><strong>{lessonRemaining} lessons left</strong><small>{lessonPct}% sentence curriculum stamped</small>
        </a>
        <a className={`route-card ${patternCompletion.drills > patternCompletion.sealed ? "urgent" : patternCompletion.unlocked ? "done" : ""}`} href="/lessons/patterns">
          <span>4</span><strong>{patternCompletion.unlocked} patterns unlocked</strong><small>{patternCompletion.sealed}/{patternCompletion.drills} generated drills sealed</small>
        </a>
        <a className="route-card" href="/verbs">
          <span>5</span><strong>{verbRemaining} verb grids left</strong><small>{verbPct}% verb atlas complete</small>
        </a>
      </div>

      <div className="card stack progress-card">
        <div className="row between wrap">
          <div>
            <div className="spanish-kicker">visible progress</div>
            <strong>Curriculum completion</strong>
          </div>
          <span className="pill">verbs + lessons + patterns</span>
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
        <div className="progress-row">
          <div className="row between small">
            <span>Pattern drills sealed</span>
            <strong>{loading ? "·" : `${patternCompletion.sealed}/${patternCompletion.drills} (${patternPct}%)`}</strong>
          </div>
          <div className="progress-track" aria-label={`Pattern drill progress ${patternPct}%`}><span style={{ width: `${patternPct}%` }} /></div>
        </div>
      </div>

      <div className="card stack journey-card">
        <div className="row between wrap">
          <div>
            <div className="spanish-kicker">study wall</div>
            <strong>Azulejo heatmap + passport route</strong>
          </div>
          <span className="pill">last 5 weeks</span>
        </div>
        <div className="heatmap-wall" aria-label="Study intensity heatmap">
          {heatCells.map((level, i) => <span key={i} className={`heat-tile level-${level}`} />)}
        </div>
        <div className="journey-arc" style={{ "--pct": `${passportPct}%` } as React.CSSProperties}>
          <span>reviews</span><i /><span>passport</span>
        </div>
      </div>

      <div className="metric-board metric-board-pop" aria-label="Practice counts">
        <div className="metric-card hot">
          <div className="metric-icon">🔥</div>
          <div className="num">{loading ? "·" : (stats?.dueCount ?? 0)}</div>
          <div className="lbl">reviews due</div>
        </div>
        <div className="metric-card rhythm">
          <div className="metric-icon">🎧</div>
          <div className="num">{loading ? "·" : (stats?.learningCount ?? 0)}</div>
          <div className="lbl">learning cards</div>
        </div>
        <div className="metric-card cool">
          <div className="metric-icon">✨</div>
          <div className="num">{loading ? "·" : (stats?.newCount ?? 0)}</div>
          <div className="lbl">new cards</div>
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
        <a className="action-card action-card-blue" href="/lessons/patterns">
          <span>generar</span>
          <strong>Pattern drills</strong>
          <small>LLM-generated packs unlocked from completed lessons.</small>
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
