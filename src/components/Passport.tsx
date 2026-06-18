import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type LessonProgress, type VerbCatalog, type VerbProgress } from "../lib/api";
import type { DashboardStats } from "../lib/types";
import { REGIONS, RegionArt, type RegionKey, StateIllustration } from "../lib/visuals";

type Stamp = {
  id: string;
  title: string;
  condition: string;
  region: RegionKey;
  earned: boolean;
  progress?: string;
};

type PassportStats = DashboardStats & {
  lastSession: boolean;
  cleanRecalls: number;
  streakDays: number;
  verbCompleted: number;
  verbTotal: number;
  lessonCompleted: number;
  lessonTotal: number;
  missesOpen: number;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

function pickStat(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (key in raw) return num(raw[key]);
  }
  return 0;
}

function buildStamps(s: PassportStats): Stamp[] {
  const introduced = s.learningCount + s.reviewCount;
  const curriculumPct = Math.round(((s.verbCompleted + s.lessonCompleted) / Math.max(1, s.verbTotal + s.lessonTotal)) * 100);
  const lessonPct = Math.round((s.lessonCompleted / Math.max(1, s.lessonTotal)) * 100);
  const verbPct = Math.round((s.verbCompleted / Math.max(1, s.verbTotal)) * 100);
  const reviewClear = s.dueCount === 0 && s.totalCards > 0;
  return [
    { id: "first-session", title: "First entry", condition: "Complete your first spoken session or introduce cards", region: "madrid", earned: s.lastSession || introduced > 0, progress: introduced ? `${introduced} active cards` : "start a session" },
    { id: "review-inbox-zero", title: "Review gate clear", condition: "Clear today’s due review queue", region: "cdmx", earned: reviewClear, progress: `${s.dueCount} due reviews` },
    { id: "lessons-5", title: "5 sentence stamps", condition: "Complete 5 sentence lessons", region: "medellin", earned: s.lessonCompleted >= 5, progress: `${s.lessonCompleted}/5 lessons` },
    { id: "lessons-25pct", title: "Pattern quarter", condition: "Complete 25% of sentence lessons", region: "buenos-aires", earned: lessonPct >= 25, progress: `${lessonPct}% lessons` },
    { id: "verbs-10", title: "10 verb visas", condition: "Complete 10 full verb grids", region: "san-juan", earned: s.verbCompleted >= 10, progress: `${s.verbCompleted}/10 grids` },
    { id: "verbs-25pct", title: "Verb atlas quarter", condition: "Complete 25% of verb grids", region: "madrid", earned: verbPct >= 25, progress: `${verbPct}% verbs` },
    { id: "curriculum-25", title: "Route 25%", condition: "Complete 25% of verbs + sentence lessons", region: "cdmx", earned: curriculumPct >= 25, progress: `${curriculumPct}% curriculum` },
    { id: "misses-cleared", title: "Polish inbox zero", condition: "Clear all open study misses after starting progress", region: "buenos-aires", earned: s.missesOpen === 0 && (s.verbCompleted + s.lessonCompleted + introduced) > 0, progress: `${s.missesOpen} open misses` },
    { id: "streak-7", title: "7-day route", condition: "Study 7 days in a row", region: "medellin", earned: s.streakDays >= 7, progress: `${s.streakDays}/7 days` },
  ];
}

export default function Passport() {
  const [stats, setStats] = useState<PassportStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [counts, sourceCount, raw, verbProgress, lessonProgress, verbMisses, lessonMisses, verbCatalog, lessonCatalog] = await Promise.all([
          api.getDashboardCounts(),
          api.countSources().catch(() => 0),
          api.getStats().catch(() => ({})),
          api.listVerbProgress().catch(() => [] as VerbProgress[]),
          api.listLessonProgress().catch(() => [] as LessonProgress[]),
          api.listVerbMisses(200).catch(() => []),
          api.listLessonMisses(200).catch(() => []),
          api.listVerbCatalog().catch(async () => {
            const mod = await import("../data/generated/verbs.json");
            return mod.default as VerbCatalog;
          }),
          import("../data/generated/fuzzy_lessons.json").then((mod) => mod.default as { count: number }).catch(() => ({ count: 0 })),
        ]);
        if (!alive) return;
        const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const next: PassportStats = {
          dueCount: counts.due_count,
          newCount: counts.new_count,
          learningCount: counts.learning_count,
          reviewCount: counts.review_count,
          totalCards: counts.new_count + counts.learning_count + counts.review_count + counts.suspended_count,
          sourceCount,
          lastSession: !!rawObj.last_session,
          cleanRecalls: pickStat(rawObj, ["clean_recalls", "clean_recall_count", "perfect_recalls", "passed_count"]),
          streakDays: pickStat(rawObj, ["streak_days", "current_streak", "daily_streak"]),
          verbCompleted: verbProgress.filter((p) => Number(p.completed) === 1).length,
          verbTotal: Math.max(verbCatalog.count || verbCatalog.verbs?.length || verbProgress.length, 1),
          lessonCompleted: lessonProgress.filter((p) => Number(p.completed) === 1).length,
          lessonTotal: Math.max(lessonCatalog.count || lessonProgress.length, 1),
          missesOpen: verbMisses.filter((m) => m.status !== "cleared").length + lessonMisses.filter((m) => m.status !== "cleared").length,
        };
        setStats(next);
        const earned = buildStamps(next).filter((x) => x.earned).map((x) => x.id);
        const seen = new Set(JSON.parse(localStorage.getItem("passport-earned-stamps") || "[]") as string[]);
        const fresh = earned.filter((id) => !seen.has(id));
        if (fresh.length) {
          setNewIds(new Set(fresh));
          localStorage.setItem("passport-earned-stamps", JSON.stringify([...new Set([...seen, ...earned])]));
        }
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : String(err));
      }
    })();
    return () => { alive = false; };
  }, []);

  const stamps = useMemo(() => stats ? buildStamps(stats) : [], [stats]);
  const earnedCount = stamps.filter((s) => s.earned).length;
  const nextStamp = stamps.find((s) => !s.earned);
  const leadRegion = REGIONS[earnedCount % REGIONS.length];

  return (
    <div className="stack passport-page">
      {error && <div className="alert alert-error">{error}</div>}
      <section className="passport-hero card stack" style={{ "--region-accent": leadRegion.accent } as React.CSSProperties}>
        <RegionArt region={leadRegion.key} />
        <div className="spanish-kicker">passport / sellos</div>
        <h1>Your Spanish travel passport</h1>
        <p className="muted">Earn stamps for the work that actually moves this app: due reviews, sentence lessons, verb grids, open misses, and streak consistency.</p>
        <div className="passport-progress"><strong>{stats ? `${earnedCount}/${stamps.length}` : "·"}</strong><span>stamps earned</span></div>
        {nextStamp && <div className="passport-next-stamp"><strong>Next stamp:</strong> {nextStamp.title} · {nextStamp.progress ?? nextStamp.condition}</div>}
      </section>

      {!stats ? (
        <div className="card center stack"><StateIllustration type="loading" /><p className="muted">Pressing fresh ink into the passport…</p></div>
      ) : (
        <section className="passport-book" aria-label="Passport stamp booklet">
          <div className="passport-spine" aria-hidden="true" />
          <div className="passport-page-sheet intro-page">
            <div className="passport-page-label">República de la Práctica</div>
            <h2>Entry visas</h2>
            <p className="muted">The page fills as reviews are cleared, lessons are sealed, verb grids are completed, and misses are polished.</p>
            <div className="passport-mini-stats">
              <span><strong>{stats.learningCount + stats.reviewCount}</strong> introduced</span>
              <span><strong>{stats.lessonCompleted}/{stats.lessonTotal}</strong> lessons</span>
              <span><strong>{stats.verbCompleted}/{stats.verbTotal}</strong> verbs</span>
              <span><strong>{stats.missesOpen}</strong> misses open</span>
            </div>
          </div>
          <div className="passport-page-sheet stamps-page">
            <div className="stamp-grid">
              {stamps.map((stamp, i) => (
                <article key={stamp.id} className={`stamp-card stamp-shape-${i % 4} ${stamp.earned ? "earned" : "locked"} ${newIds.has(stamp.id) ? "just-earned" : ""}`} style={{ "--region-accent": REGIONS.find((r) => r.key === stamp.region)?.accent } as React.CSSProperties}>
                  <RegionArt region={stamp.region} small />
                  <div className="stamp-seal"><span>{REGIONS.find((r) => r.key === stamp.region)?.flag}</span></div>
                  <div className="stamp-date">{stamp.earned ? new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase() : "LOCKED"}</div>
                  <h3>{stamp.title}</h3>
                  <p>{stamp.earned ? "Stamped into your passport." : stamp.condition}</p>
                  {stamp.progress && <small>{stamp.progress}</small>}
                </article>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
