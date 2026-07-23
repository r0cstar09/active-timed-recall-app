import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { DailyHabitDay, ServerDashboardStats } from "../lib/types";

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "narrow", timeZone: "America/New_York" })
    .format(new Date(`${date}T12:00:00-04:00`));
}

function longDate(date: string): string {
  if (!date) return "Today";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(new Date(`${date}T12:00:00-04:00`));
}

function WeekStrip({ days, today }: { days: DailyHabitDay[]; today: string }) {
  return (
    <div className="habit-week" role="list" aria-label="Practice during the last seven days">
      {days.map((day) => {
        const state = day.target_met ? "goal" : day.reps > 0 ? "active" : "empty";
        return (
          <div
            className={`habit-day ${state} ${day.date === today ? "today" : ""}`}
            key={day.date}
            title={`${day.date}: ${day.reps} practice ${day.reps === 1 ? "rep" : "reps"}`}
            role="listitem"
            aria-label={`${day.date}: ${day.reps} practice ${day.reps === 1 ? "rep" : "reps"}`}
            aria-current={day.date === today ? "date" : undefined}
          >
            <span>{dayLabel(day.date)}</span>
            <i aria-hidden="true">{day.reps > 0 ? Math.min(day.reps, 99) : ""}</i>
          </div>
        );
      })}
    </div>
  );
}

export default function DueSummary() {
  const [stats, setStats] = useState<ServerDashboardStats | null>(null);
  const [sourceCount, setSourceCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dashboard = await api.getDashboardCounts();
      setStats(dashboard);
      try {
        setSourceCount(await api.countSources());
      } catch {
        setSourceCount(0);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const primary = useMemo(() => {
    if (!stats) return { href: "/session?mode=practice", label: "Start practice" };
    if (stats.due_count > 0) {
      return {
        href: "/session?mode=review",
        label: `Review ${Math.min(stats.due_count, 10)} due ${Math.min(stats.due_count, 10) === 1 ? "card" : "cards"}`,
      };
    }
    if (stats.new_count > 0) {
      return {
        href: "/session?mode=learn",
        label: `Learn ${Math.min(stats.new_count, 10)} new ${Math.min(stats.new_count, 10) === 1 ? "card" : "cards"}`,
      };
    }
    if (!stats.habit.target_met) {
      return { href: "/session?mode=practice", label: "Build today’s reps" };
    }
    return { href: "/lessons", label: "Explore a lesson" };
  }, [stats]);

  if (loading && !stats) {
    return (
      <section className="daily-home" aria-busy="true">
        <div className="daily-loading-card">
          <div className="daily-loading-line wide"></div>
          <div className="daily-loading-line"></div>
          <div className="daily-loading-line button"></div>
        </div>
      </section>
    );
  }

  if (error || !stats) {
    return (
      <section className="daily-home">
        <div className="card center stack daily-error-card" role="alert">
          <span className="daily-error-icon" aria-hidden="true">!</span>
          <h1>Today’s plan could not load.</h1>
          <p className="muted">{error ?? "The learning service did not return your dashboard."}</p>
          <button className="btn btn-primary" type="button" onClick={() => void load()}>Try again</button>
        </div>
      </section>
    );
  }

  const { habit } = stats;
  const progress = Math.min(100, Math.round((habit.today_reps / habit.daily_target) * 100));
  const streakCopy = !habit.available
    ? "Streak tracking temporarily unavailable"
    : habit.current_streak === 0
    ? "Start your streak today"
    : habit.practiced_today
      ? `${habit.current_streak}-day streak active`
      : `Practice today to keep your ${habit.current_streak}-day streak`;
  const planCopy = habit.target_met
    ? "Daily target complete. Anything else is bonus Spanish."
    : stats.due_count > 0
      ? `Review your due cards${stats.new_count > 0 ? ", then learn your new cards" : ""} and finish today’s target.`
      : stats.new_count > 0
        ? "Learn your new cards, then finish the remaining practice reps."
        : "Build today’s practice reps to keep your momentum.";

  return (
    <section className="daily-home">
      <header className="daily-command-card">
        <div className="daily-command-topline">
          <div>
            <span className="daily-kicker">Your daily plan</span>
            <span className="daily-date">{longDate(habit.local_date)}</span>
          </div>
          <div className={`streak-badge ${habit.practiced_today ? "is-active" : ""}`} aria-label={streakCopy}>
            <span aria-hidden="true">🔥</span>
            <strong>{habit.available ? habit.current_streak : "–"}</strong>
            <small>{habit.available ? (habit.current_streak === 1 ? "day" : "days") : "offline"}</small>
          </div>
        </div>

        <div className="daily-command-copy">
          <h1>What to do today</h1>
          <p>{planCopy}</p>
        </div>

        <div className="daily-goal-progress">
          <div className="daily-goal-labels">
            <strong>{habit.available ? `${habit.today_reps} of ${habit.daily_target} practice reps` : "Practice tracking unavailable"}</strong>
            <span>{habit.available ? (habit.target_met ? "Target complete" : `${habit.remaining_reps} left`) : "Your study queues still work"}</span>
          </div>
          <div
            className="daily-progress-track"
            role="progressbar"
            aria-label="Daily practice target"
            aria-valuemin={0}
            aria-valuemax={habit.daily_target}
            aria-valuenow={Math.min(habit.today_reps, habit.daily_target)}
          >
            <span style={{ width: `${progress}%` }}></span>
          </div>
        </div>

        <a className="btn btn-primary btn-lg daily-primary-button" href={primary.href}>
          {primary.label}
          <span aria-hidden="true">→</span>
        </a>
      </header>

      <div className="daily-task-grid" aria-label="Today’s Spanish tasks">
        <article className={`daily-task-card learn ${stats.new_count === 0 ? "is-complete" : ""}`}>
          <div className="daily-task-icon" aria-hidden="true">＋</div>
          <div className="daily-task-number">{stats.new_count}</div>
          <h2>New cards to learn</h2>
          <p>{stats.new_count > 0
            ? `Start with up to ${Math.min(stats.new_count, 10)} new cards. They stay out of review until you introduce them.`
            : "You have introduced every current card."}</p>
          <a className={`btn btn-block ${stats.new_count > 0 ? "btn-primary" : ""}`} href={stats.new_count > 0 ? "/session?mode=learn" : "/ingest"}>
            {stats.new_count > 0 ? "Learn new cards" : "Add a source"}
          </a>
        </article>

        <article className={`daily-task-card practice ${habit.target_met ? "is-complete" : ""}`}>
          <div className="daily-task-icon" aria-hidden="true">◎</div>
          <div className="daily-task-number">{habit.remaining_reps}</div>
          <h2>{habit.target_met ? "Practice target complete" : "Practice reps remaining"}</h2>
          <p>{habit.target_met
            ? `You completed ${habit.today_reps} reps today. Your ${habit.daily_target}-rep target is covered.`
            : `${stats.due_count} cards are due now. Lessons, verbs, patterns, and recall cards all move this target.`}</p>
          <a
            className={`btn btn-block ${habit.target_met ? "" : "btn-primary"}`}
            href={habit.target_met ? "/misses" : stats.due_count > 0 ? "/session?mode=review" : "/session?mode=practice"}
          >
            {habit.target_met ? "Optional: clear misses" : stats.due_count > 0 ? "Review due cards" : "Practice now"}
          </a>
        </article>
      </div>

      <article className="streak-card">
        <div className="streak-copy">
          <span className="streak-flame" aria-hidden="true">🔥</span>
          <div>
            <span className="daily-kicker">Consistency</span>
            <h2>{streakCopy}</h2>
            <p>{!habit.available
              ? "You can still review due cards; tracking will resume when the activity store recovers."
              : habit.practiced_today
              ? "Today is secured. Come back tomorrow to extend it."
              : habit.current_streak > 0
                ? "One meaningful practice rep today keeps the streak alive."
                : "Practice today, then return tomorrow to build momentum."}</p>
          </div>
        </div>
        <WeekStrip days={habit.recent_days} today={habit.local_date} />
      </article>

      <section className="daily-more">
        <div className="daily-section-heading">
          <div>
            <span className="daily-kicker">More ways to train</span>
            <h2>Choose a focus</h2>
          </div>
          <span className="pill">{sourceCount} {sourceCount === 1 ? "source" : "sources"}</span>
        </div>
        <nav className="daily-focus-grid" aria-label="Spanish study areas">
          <a href="/lessons"><span aria-hidden="true">Aa</span><strong>Lessons</strong><small>Meaning and patterns</small></a>
          <a href="/verbs"><span aria-hidden="true">V</span><strong>Verbs</strong><small>Fast conjugation</small></a>
          <a href="/misses"><span aria-hidden="true">✦</span><strong>Misses</strong><small>Fix weak spots</small></a>
          <a href="/library"><span aria-hidden="true">▤</span><strong>Library</strong><small>Manage source cards</small></a>
        </nav>
        <p className="daily-queue-note">
          {stats.due_count} due · {stats.learning_count} learning · {stats.review_count} in review
        </p>
      </section>
    </section>
  );
}
