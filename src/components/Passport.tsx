import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type LessonProgress, type VerbProgress } from "../lib/api";
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
  return [
    { id: "first-session", title: "First stamp", condition: "Complete your first spoken session", region: "madrid", earned: s.lastSession || introduced > 0 },
    { id: "streak-7", title: "7-day rhythm", condition: "Study 7 days in a row", region: "cdmx", earned: s.streakDays >= 7, progress: `${s.streakDays}/7 days` },
    { id: "streak-30", title: "30-day traveler", condition: "Study 30 days in a row", region: "medellin", earned: s.streakDays >= 30, progress: `${s.streakDays}/30 days` },
    { id: "cards-50", title: "50 cards introduced", condition: "Introduce 50 phrase cards", region: "buenos-aires", earned: introduced >= 50, progress: `${introduced}/50 cards` },
    { id: "cards-100", title: "100 cards introduced", condition: "Introduce 100 phrase cards", region: "san-juan", earned: introduced >= 100, progress: `${introduced}/100 cards` },
    { id: "cards-250", title: "250-card atlas", condition: "Introduce 250 phrase cards", region: "madrid", earned: introduced >= 250, progress: `${introduced}/250 cards` },
    { id: "region-mastery", title: "Region mastery", condition: "Complete 25% of verbs + sentence lessons", region: "cdmx", earned: curriculumPct >= 25, progress: `${curriculumPct}% curriculum` },
    { id: "clean-100", title: "100 clean recalls", condition: "Earn 100 clean spoken recalls", region: "medellin", earned: s.cleanRecalls >= 100, progress: `${s.cleanRecalls}/100 clean` },
    { id: "misses-cleared", title: "Misses cleared", condition: "Clear all open study misses after starting progress", region: "buenos-aires", earned: s.missesOpen === 0 && (s.verbCompleted + s.lessonCompleted + introduced) > 0, progress: `${s.missesOpen} open misses` },
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
        const [counts, sourceCount, raw, verbProgress, lessonProgress, verbMisses, lessonMisses] = await Promise.all([
          api.getDashboardCounts(),
          api.countSources().catch(() => 0),
          api.getStats().catch(() => ({})),
          api.listVerbProgress().catch(() => [] as VerbProgress[]),
          api.listLessonProgress().catch(() => [] as LessonProgress[]),
          api.listVerbMisses(200).catch(() => []),
          api.listLessonMisses(200).catch(() => []),
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
          verbTotal: Math.max(verbProgress.length, 1),
          lessonCompleted: lessonProgress.filter((p) => Number(p.completed) === 1).length,
          lessonTotal: Math.max(lessonProgress.length, 1),
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
  const leadRegion = REGIONS[earnedCount % REGIONS.length];

  return (
    <div className="stack passport-page">
      {error && <div className="alert alert-error">{error}</div>}
      <section className="passport-hero card stack" style={{ "--region-accent": leadRegion.accent } as React.CSSProperties}>
        <RegionArt region={leadRegion.key} />
        <div className="spanish-kicker">passport / sellos</div>
        <h1>Your Spanish travel passport</h1>
        <p className="muted">Earn stamps for sessions, streaks, introduced cards, region mastery, clean recalls, and cleared misses.</p>
        <div className="passport-progress"><strong>{stats ? `${earnedCount}/${stamps.length}` : "·"}</strong><span>stamps earned</span></div>
      </section>

      {!stats ? (
        <div className="card center stack"><StateIllustration type="loading" /><p className="muted">Pressing fresh ink into the passport…</p></div>
      ) : (
        <div className="stamp-grid">
          {stamps.map((stamp) => (
            <article key={stamp.id} className={`stamp-card ${stamp.earned ? "earned" : "locked"} ${newIds.has(stamp.id) ? "just-earned" : ""}`}>
              <RegionArt region={stamp.region} small />
              <div className="stamp-seal"><span>{REGIONS.find((r) => r.key === stamp.region)?.flag}</span></div>
              <h3>{stamp.title}</h3>
              <p>{stamp.earned ? "Stamped into your passport." : stamp.condition}</p>
              {stamp.progress && <small>{stamp.progress}</small>}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
