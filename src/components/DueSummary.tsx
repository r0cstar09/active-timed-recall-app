import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { DailyHabitDay, ServerDashboardStats } from "../lib/types";

type IconName =
  | "arrow"
  | "book"
  | "check"
  | "consistency"
  | "error"
  | "layers"
  | "library"
  | "microphone"
  | "pencil"
  | "refresh"
  | "verbs";

function DashboardIcon({ name, className = "" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z" /></>,
    check: <path d="m7 12 3 3 7-7" />,
    consistency: <><path d="M7 3v3M17 3v3M4 9h16" /><rect x="4" y="5" width="16" height="16" rx="3" /><path d="m8 15 2.2 2.2L16 12" /></>,
    error: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 17h.01" /></>,
    layers: <><path d="m12 3-9 5 9 5 9-5z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    library: <><path d="M4 4h5v16H4zM10 4h5v16h-5z" /><path d="m16 5 4-1 2 15-4 1z" /></>,
    microphone: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" /></>,
    pencil: <><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z" /><path d="m14 7 3 3M4 20h6" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 0-1.7 4.6" /></>,
    verbs: <><path d="M5 5h14M5 12h9M5 19h14" /><circle cx="18" cy="12" r="2" /></>,
  };

  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function dateOnly(date: string): Date {
  // The API sends a New York-local calendar date. UTC noon prevents DST from
  // shifting that calendar date while it is formatted in the browser.
  return new Date(`${date}T12:00:00Z`);
}

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "narrow", timeZone: "UTC" })
    .format(dateOnly(date));
}

function longDate(date: string): string {
  if (!date) return "Today";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(dateOnly(date));
}

function WeekStrip({ days, today, available }: { days: DailyHabitDay[]; today: string; available: boolean }) {
  if (!available) {
    return (
      <div className="habit-week-unavailable" role="status">
        Recent activity could not be loaded. Your study queues are still available.
      </div>
    );
  }

  const recentDays = days.slice(-7);
  if (recentDays.length === 0) {
    return <div className="habit-week-unavailable">No recent activity has been recorded yet.</div>;
  }

  return (
    <div className="habit-week" role="list" aria-label="Practice during the last seven days">
      {recentDays.map((day) => {
        const state = day.target_met ? "goal" : day.reps > 0 ? "active" : "empty";
        const description = `${longDate(day.date)}: ${day.reps} practice ${day.reps === 1 ? "rep" : "reps"}${day.target_met ? "; target met" : ""}`;
        return (
          <div
            className={`habit-day ${state} ${day.date === today ? "today" : ""}`}
            key={day.date}
            title={description}
            role="listitem"
            aria-label={`${description}${day.date === today ? "; today" : ""}`}
            aria-current={day.date === today ? "date" : undefined}
          >
            <time dateTime={day.date}>{dayLabel(day.date)}</time>
            <span className="habit-day-state" aria-hidden="true">
              {day.target_met ? <DashboardIcon name="check" /> : day.reps > 0 ? <i /> : null}
            </span>
            <strong>{day.reps}</strong>
          </div>
        );
      })}
    </div>
  );
}

export default function DueSummary() {
  const [stats, setStats] = useState<ServerDashboardStats | null>(null);
  const [sourceCount, setSourceCount] = useState<number | null>(null);
  const [sourceStatus, setSourceStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);
  const restoreRetryFocus = useRef(false);
  const primaryLink = useRef<HTMLAnchorElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    setSourceStatus("loading");

    const [dashboardResult, sourceResult] = await Promise.allSettled([
      api.getDashboardCounts(),
      api.countSources(),
    ]);

    if (currentRequest !== requestId.current) return;

    if (dashboardResult.status === "rejected") {
      const reason = dashboardResult.reason;
      setError(reason instanceof ApiError ? reason.message : String(reason));
      setLoading(false);
      return;
    }

    setStats(dashboardResult.value);
    if (sourceResult.status === "fulfilled") {
      setSourceCount(sourceResult.value);
      setSourceStatus("ready");
    } else {
      setSourceCount(null);
      setSourceStatus("unavailable");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!loading && restoreRetryFocus.current) {
      const target = error ? retryButton.current : primaryLink.current;
      target?.focus();
      restoreRetryFocus.current = false;
    }
  }, [loading, error]);

  const primary = useMemo(() => {
    if (!stats) {
      return {
        href: "/session",
        label: "Choose a speaking mode",
        detail: "Open practice",
        headline: "Choose where to begin.",
      };
    }
    if (stats.due_count > 0) {
      const count = Math.min(stats.due_count, 10);
      return {
        href: "/session?mode=review",
        label: `Review ${count} due ${count === 1 ? "card" : "cards"}`,
        detail: "FSRS scheduling on",
        headline: "Bring today’s Spanish back to mind.",
      };
    }
    if (stats.new_count > 0) {
      const count = Math.min(stats.new_count, 10);
      return {
        href: "/session?mode=learn",
        label: `Learn ${count} new ${count === 1 ? "card" : "cards"}`,
        detail: "Learn before review",
        headline: "Make new Spanish familiar.",
      };
    }
    if (!stats.habit.target_met) {
      return {
        href: "/session?mode=practice",
        label: "Start free practice",
        detail: "FSRS scheduling off",
        headline: "Keep the rhythm going.",
      };
    }
    return {
      href: "/lessons",
      label: "Choose a lesson",
      detail: "Today’s target is complete",
      headline: "Today’s work is in.",
    };
  }, [stats]);

  if (loading && !stats) {
    return (
      <section className="daily-home" aria-busy="true" aria-label="Loading today’s Spanish plan">
        <div className="daily-page-header daily-loading-header">
          <span className="daily-loading-line short" />
          <span className="daily-loading-line date" />
        </div>
        <div className="daily-loading-card">
          <div className="daily-loading-line wide" />
          <div className="daily-loading-line" />
          <div className="daily-loading-line button" />
        </div>
      </section>
    );
  }

  if (error || !stats) {
    return (
      <section className="daily-home">
        <div className="daily-error-card" role="alert">
          <span className="daily-error-icon" aria-hidden="true"><DashboardIcon name="error" /></span>
          <span className="daily-eyebrow">Dashboard unavailable</span>
          <h1>Today’s plan could not load.</h1>
          <p>{error ?? "The learning service did not return your dashboard."}</p>
          <button ref={retryButton} className="btn btn-primary" type="button" onClick={() => { restoreRetryFocus.current = true; void load(); }}>Try again</button>
        </div>
      </section>
    );
  }

  const { habit } = stats;
  const progress = habit.available
    ? Math.min(100, Math.round((habit.today_reps / habit.daily_target) * 100))
    : 0;
  const streakCopy = !habit.available
    ? "Activity tracking is temporarily unavailable."
    : habit.current_streak === 0
      ? "A streak starts with one practice rep."
      : habit.practiced_today
        ? `${habit.current_streak}-day streak active.`
        : `Practice today to keep your ${habit.current_streak}-day streak.`;
  const habitDetail = !habit.available
    ? "Nothing is shown as zero while tracking is offline."
    : habit.practiced_today
      ? "Today is recorded. Return tomorrow to keep the sequence going."
      : "Any completed study activity can begin or continue the streak.";
  const goalStatus = !habit.available
    ? "Tracking unavailable"
    : habit.target_met
      ? `${habit.daily_target}-rep goal complete`
      : `${habit.remaining_reps} ${habit.remaining_reps === 1 ? "rep" : "reps"} to today’s goal`;
  const planCopy = !habit.available
    ? "Your activity history is offline, but the card queues below are still ready."
    : habit.target_met
      ? "Your daily activity goal is complete. Keep going only if it feels useful."
      : stats.due_count > 0
        ? `Start with what is due. Every completed study activity moves the ${habit.daily_target}-rep goal forward.`
        : stats.new_count > 0
          ? "Introduce the new cards first, then use practice to make them feel natural."
          : "Nothing is due. A short free-practice round will keep today moving.";

  const sourceLabel = sourceStatus === "ready"
    ? `${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`
    : sourceStatus === "unavailable"
      ? "Source count unavailable"
      : "Refreshing sources…";

  return (
    <section className="daily-home">
      <header className="daily-page-header">
        <div>
          <span className="daily-eyebrow">Today</span>
          <h1>A little Spanish, every day.</h1>
        </div>
        <time className="daily-date" dateTime={habit.local_date}>{longDate(habit.local_date)}</time>
      </header>

      <article className="daily-hero">
        <div className="daily-hero-main">
          <div className="daily-hero-copy">
            <span className="daily-hero-kicker">Best next step</span>
            <h2>{primary.headline}</h2>
            <p>{planCopy}</p>
            <a ref={primaryLink} className="daily-primary-action" href={primary.href}>
              <span>
                <strong>{primary.label}</strong>
                <small>{primary.detail}</small>
              </span>
              <DashboardIcon name="arrow" />
            </a>
          </div>

          <div className={`daily-goal-panel ${habit.available ? "" : "is-unavailable"}`}>
            <div
              className="daily-goal-ring"
              role={habit.available ? "progressbar" : undefined}
              aria-label={habit.available ? "Daily practice target" : "Daily practice tracking unavailable"}
              aria-valuemin={habit.available ? 0 : undefined}
              aria-valuemax={habit.available ? habit.daily_target : undefined}
              aria-valuenow={habit.available ? Math.min(habit.today_reps, habit.daily_target) : undefined}
            >
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle className="daily-goal-ring-track" cx="60" cy="60" r="52" pathLength="100" />
                <circle className="daily-goal-ring-value" cx="60" cy="60" r="52" pathLength="100" strokeDasharray={`${progress} 100`} />
              </svg>
              <span>
                <strong>{habit.available ? habit.today_reps : "—"}</strong>
                <small>{habit.available ? `of ${habit.daily_target}` : "offline"}</small>
              </span>
            </div>
            <div className="daily-goal-copy">
              <span>Daily activity</span>
              <strong>{goalStatus}</strong>
              <small>{habit.available ? "All study modes count" : "Queues are unaffected"}</small>
            </div>
          </div>
        </div>

        <div className="daily-scheduling-note">
          <DashboardIcon name="refresh" />
          <p><strong>Scheduling stays clear.</strong> Due Review and fresh Misses attempts update FSRS. Free Practice does not. Every study activity can add to today’s reps.</p>
        </div>
      </article>

      <section className="daily-modes" aria-labelledby="daily-modes-title">
        <div className="daily-section-heading">
          <div>
            <span className="daily-eyebrow">Choose your mode</span>
            <h2 id="daily-modes-title">Three ways to practise</h2>
          </div>
          <span className="daily-section-note">Speak first. Feedback follows.</span>
        </div>

        <div className="daily-mode-grid">
          <a className="daily-mode-card review" href="/session?mode=review">
            <div className="daily-mode-topline">
              <span className="daily-mode-icon"><DashboardIcon name="refresh" /></span>
              <span className="daily-mode-tag">FSRS on</span>
            </div>
            <strong className="daily-mode-value">{stats.due_count}</strong>
            <div className="daily-mode-copy">
              <h3>Due Review</h3>
              <p>{stats.due_count > 0
                ? `${stats.due_count} ${stats.due_count === 1 ? "card is" : "cards are"} scheduled now. Your grades set what comes next.`
                : "The scheduled queue is clear. Check in whenever you want to review it."}</p>
            </div>
            <span className="daily-mode-action">{stats.due_count > 0 ? "Start review" : "Queue clear"}<DashboardIcon name="arrow" /></span>
          </a>

          <a className="daily-mode-card learn" href={stats.new_count > 0 ? "/session?mode=learn" : "/ingest"}>
            <div className="daily-mode-topline">
              <span className="daily-mode-icon"><DashboardIcon name="layers" /></span>
              <span className="daily-mode-tag">Learn first</span>
            </div>
            <strong className="daily-mode-value">{stats.new_count}</strong>
            <div className="daily-mode-copy">
              <h3>New cards</h3>
              <p>{stats.new_count > 0
                ? `Introduce up to ${Math.min(stats.new_count, 10)} ${Math.min(stats.new_count, 10) === 1 ? "card" : "cards"} before they enter review.`
                : "Every current card has been introduced. Add a source when you want more."}</p>
            </div>
            <span className="daily-mode-action">{stats.new_count > 0 ? "Learn new cards" : "Add a source"}<DashboardIcon name="arrow" /></span>
          </a>

          <a className="daily-mode-card practice" href="/session?mode=practice">
            <div className="daily-mode-topline">
              <span className="daily-mode-icon"><DashboardIcon name="microphone" /></span>
              <span className="daily-mode-tag">FSRS off</span>
            </div>
            <strong className="daily-mode-value daily-mode-word">Open</strong>
            <div className="daily-mode-copy">
              <h3>Free Practice</h3>
              <p>Rotate introduced cards and practise speaking without moving their due dates.</p>
            </div>
            <span className="daily-mode-action">Practise freely<DashboardIcon name="arrow" /></span>
          </a>
        </div>
      </section>

      <article className="daily-habit-card">
        <div className="daily-habit-copy">
          <span className="daily-habit-icon" aria-hidden="true"><DashboardIcon name="consistency" /></span>
          <div>
            <span className="daily-eyebrow">Seven-day rhythm</span>
            <h2>{streakCopy}</h2>
            <p>{habitDetail}</p>
          </div>
        </div>
        <div className="daily-habit-week-wrap">
          <WeekStrip days={habit.recent_days} today={habit.local_date} available={habit.available} />
          {habit.available && habit.recent_days.length > 0 && (
            <div className="habit-legend" aria-hidden="true">
              <span><i className="active" /> practised</span>
              <span><i className="goal" /> goal met</span>
              <span>number = reps</span>
            </div>
          )}
        </div>
      </article>

      <section className="daily-more" aria-labelledby="daily-more-title">
        <div className="daily-section-heading">
          <div>
            <span className="daily-eyebrow">Keep exploring</span>
            <h2 id="daily-more-title">Build the skill from another angle</h2>
          </div>
          <span className={`daily-source-count ${sourceStatus === "unavailable" ? "is-unavailable" : ""}`}>{sourceLabel}</span>
        </div>

        <nav className="daily-focus-grid" aria-label="Spanish study areas">
          <a href="/lessons">
            <DashboardIcon name="book" />
            <span><strong>Lessons</strong><small>Patterns in context</small></span>
            <DashboardIcon name="arrow" className="daily-resource-arrow" />
          </a>
          <a href="/verbs">
            <DashboardIcon name="verbs" />
            <span><strong>Verbs</strong><small>Build faster recall</small></span>
            <DashboardIcon name="arrow" className="daily-resource-arrow" />
          </a>
          <a href="/write">
            <DashboardIcon name="pencil" />
            <span><strong>Written recall</strong><small>Type what you know</small></span>
            <DashboardIcon name="arrow" className="daily-resource-arrow" />
          </a>
          <a href="/library">
            <DashboardIcon name="library" />
            <span><strong>Library</strong><small>Manage source cards</small></span>
            <DashboardIcon name="arrow" className="daily-resource-arrow" />
          </a>
        </nav>

        <p className="daily-deck-note">
          <span>Deck status</span>
          <strong>{stats.learning_count} learning</strong>
          <i aria-hidden="true" />
          <strong>{stats.review_count} in review</strong>
        </p>
      </section>
    </section>
  );
}
