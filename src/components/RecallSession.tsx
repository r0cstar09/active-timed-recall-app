import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, pollAttempt } from "../lib/api";
import type { Attempt, Card, ReviewRating } from "../lib/types";
import { Recorder, isRecordingSupported } from "../lib/recorder";
import {
  clearSession,
  loadSession,
  remainingMs,
  remainingSeconds,
  saveSession,
  type PersistedSession,
  type Phase,
} from "../lib/timer";
import AudioPlayer from "./AudioPlayer";

type Status = "idle" | "active" | "done" | "error";

const RATINGS: { rating: ReviewRating; label: string; cls: string }[] = [
  { rating: "again", label: "Again", cls: "pill-bad" },
  { rating: "hard", label: "Hard", cls: "pill-warn" },
  { rating: "good", label: "Good", cls: "" },
  { rating: "easy", label: "Easy", cls: "pill-good" },
];

export default function RecallSession() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<PersistedSession | null>(null);

  const [cards, setCards] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("recall");
  const [deadline, setDeadline] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [, setTick] = useState(0); // forces countdown re-render

  const sessionIdRef = useRef<string>("");
  const recorderRef = useRef<Recorder | null>(null);
  const submitRef = useRef<() => void>(() => {});
  const supported = isRecordingSupported();

  const card = cards[index];

  // ── persistence ─────────────────────────────────────────────────────────
  const persist = useCallback(
    (over: Partial<PersistedSession> = {}) => {
      const snapshot: PersistedSession = {
        sessionId: sessionIdRef.current,
        cards,
        index,
        phase,
        deadline,
        durationMs,
        attemptId: attempt?.attemptId ?? null,
        startedAt: Date.now(),
        ...over,
      };
      saveSession(snapshot);
    },
    [cards, index, phase, deadline, durationMs, attempt],
  );

  useEffect(() => {
    if (status === "idle") setResumable(loadSession());
  }, [status]);

  // ── countdown tick + auto-resync on visibility/refocus ───────────────────
  useEffect(() => {
    if (status !== "active" || phase !== "recall") return;
    const id = setInterval(() => setTick((t) => t + 1), 200);
    const onVisible = () => setTick((t) => t + 1);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [status, phase]);

  // ── auto-submit when the recall countdown reaches zero ───────────────────
  useEffect(() => {
    if (status === "active" && phase === "recall" && deadline != null) {
      if (remainingMs(deadline) <= 0) submitRef.current();
    }
  });

  // ── release the mic when leaving the screen ──────────────────────────────
  useEffect(() => {
    return () => recorderRef.current?.dispose();
  }, []);

  function beginCard(i: number, list: Card[], preserveDeadline: number | null) {
    const c = list[i];
    if (!c) return;
    const dur = Math.max(1, c.recallSeconds) * 1000;
    let dl = preserveDeadline;
    // If resuming and the saved countdown still has meaningful time, keep it so
    // the timer is not corrupted; otherwise start a fresh window for this card.
    if (dl == null || remainingMs(dl) < 1000) dl = Date.now() + dur;
    setIndex(i);
    setPhase("recall");
    setDurationMs(dur);
    setDeadline(dl);
    setAttempt(null);
    try {
      recorderRef.current?.start();
    } catch {
      /* recorder may restart on next gesture */
    }
    saveSession({
      sessionId: sessionIdRef.current,
      cards: list,
      index: i,
      phase: "recall",
      deadline: dl,
      durationMs: dur,
      attemptId: null,
      startedAt: Date.now(),
    });
  }

  async function armRecorder(): Promise<boolean> {
    if (!recorderRef.current) recorderRef.current = new Recorder();
    try {
      await recorderRef.current.init();
      return true;
    } catch (err) {
      setError(
        `Microphone permission is required. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  async function start() {
    setError(null);
    if (!supported) {
      setError("This browser does not support audio recording.");
      return;
    }
    if (!(await armRecorder())) return;
    try {
      const payload = await api.startSession(20);
      if (!payload.cards.length) {
        clearSession();
        setStatus("done");
        return;
      }
      sessionIdRef.current = payload.sessionId;
      setCards(payload.cards);
      setStatus("active");
      beginCard(0, payload.cards, null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setStatus("error");
    }
  }

  async function resume() {
    const saved = resumable;
    if (!saved) return;
    setError(null);
    if (!(await armRecorder())) return;
    sessionIdRef.current = saved.sessionId;
    setCards(saved.cards);
    setIndex(saved.index);
    setStatus("active");

    if (saved.phase === "feedback" && saved.attemptId) {
      setPhase("feedback");
      setDeadline(null);
      try {
        setAttempt(await api.getAttempt(saved.attemptId));
      } catch {
        /* fall back to a fresh recall of this card */
        beginCard(saved.index, saved.cards, null);
      }
      return;
    }
    // recall / recording / submitting → resume recall, preserving remaining time
    beginCard(saved.index, saved.cards, saved.deadline);
  }

  const submit = useCallback(async () => {
    if (phase !== "recall") return;
    setPhase("submitting");
    persist({ phase: "submitting" });
    let result: { blob: Blob; filename: string } | null = null;
    try {
      result = await recorderRef.current!.stop();
    } catch {
      /* no recording captured */
    }

    if (!result || result.blob.size === 0) {
      setError("No audio was captured. Try recording again.");
      setPhase("recall");
      const dl = Date.now() + (durationMs ?? 5000);
      setDeadline(dl);
      try {
        recorderRef.current?.start();
      } catch {
        /* ignore */
      }
      return;
    }

    const elapsedMs =
      durationMs != null && deadline != null
        ? durationMs - remainingMs(deadline)
        : undefined;

    try {
      const created = await api.submitAttempt(card.id, result.blob, {
        sessionId: sessionIdRef.current,
        elapsedMs,
        filename: result.filename,
      });
      setAttempt(created);
      setPhase("feedback");
      persist({ phase: "feedback", attemptId: created.attemptId });

      if (created.status === "grading") {
        const graded = await pollAttempt(created.attemptId, {
          onUpdate: setAttempt,
        });
        setAttempt(graded);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setPhase("feedback");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, card, durationMs, deadline, persist]);

  // keep the auto-submit ref pointed at the latest closure
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  async function rate(rating: ReviewRating) {
    if (card) {
      try {
        await api.submitReview(card.id, rating);
      } catch {
        /* non-fatal: scheduling can be retried; keep the session moving */
      }
    }
    next();
  }

  function next() {
    const ni = index + 1;
    if (ni >= cards.length) {
      clearSession();
      recorderRef.current?.dispose();
      setStatus("done");
      return;
    }
    beginCard(ni, cards, null);
  }

  function quit() {
    clearSession();
    recorderRef.current?.dispose();
    window.location.href = "/";
  }

  // ── render ────────────────────────────────────────────────────────────────
  if (status === "idle") {
    return (
      <div className="stack">
        {!supported && (
          <div className="alert alert-error">
            Audio recording isn’t supported here. Open the app in iPhone Safari.
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {resumable ? (
          <div className="card stack center">
            <p className="muted">
              Resume your session at card {resumable.index + 1} of{" "}
              {resumable.cards.length}?
            </p>
            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={resume}
              disabled={!supported}
            >
              Resume (enable mic)
            </button>
            <button
              className="btn btn-ghost btn-block"
              onClick={() => {
                clearSession();
                setResumable(null);
              }}
            >
              Discard & start fresh
            </button>
          </div>
        ) : (
          <div className="card stack center">
            <p className="muted">
              Tap begin and allow microphone access. You’ll recall each Spanish
              sentence aloud before the timer ends.
            </p>
            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={start}
              disabled={!supported}
            >
              Begin session
            </button>
          </div>
        )}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="stack">
        <div className="alert alert-error">{error}</div>
        <button className="btn btn-primary btn-block" onClick={() => setStatus("idle")}>
          Back
        </button>
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="card stack center">
        <h2>Session complete</h2>
        <p className="muted">Nice work. Review any misses below.</p>
        <a className="btn btn-primary btn-block" href="/review">
          Review corrections
        </a>
        <a className="btn btn-ghost btn-block" href="/">
          Home
        </a>
      </div>
    );
  }

  // active
  const secs = remainingSeconds(deadline);
  const totalSecs = durationMs ? Math.round(durationMs / 1000) : 1;
  const pct = deadline
    ? Math.max(0, Math.min(100, (remainingMs(deadline) / (durationMs || 1)) * 100))
    : 0;
  const danger = secs <= 3;

  return (
    <div className="stack">
      <div className="row between small faint">
        <span>
          Card {index + 1} / {cards.length}
        </span>
        <button
          className="btn btn-ghost"
          style={{ minHeight: 32, padding: "4px 10px" }}
          onClick={quit}
        >
          End
        </button>
      </div>

      {/* ── RECALL: prompt · countdown · recording state · submit ─────────── */}
      {phase === "recall" && (
        <div className="card stack center" style={{ paddingTop: 28, paddingBottom: 28 }}>
          <div
            className="num"
            style={{
              fontSize: "3.4rem",
              fontWeight: 800,
              color: danger ? "var(--bad)" : undefined,
              background: danger ? "none" : "var(--accent-grad)",
              WebkitBackgroundClip: danger ? undefined : "text",
              backgroundClip: danger ? undefined : "text",
              WebkitTextFillColor: danger ? "var(--bad)" : "transparent",
            }}
            aria-live="off"
          >
            {secs}
          </div>
          <div
            style={{
              height: 6,
              width: "100%",
              borderRadius: 999,
              background: "var(--bg-elev-2)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                background: danger ? "var(--bad)" : "var(--accent-grad)",
              }}
            />
          </div>

          <p className="small faint" style={{ margin: "6px 0 0" }}>
            Recall this aloud
          </p>
          <h2 style={{ margin: "2px 0 0" }}>{card?.promptText}</h2>

          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: "var(--bad)",
                boxShadow: "0 0 0 0 rgba(248,113,113,0.6)",
                animation: "pulse 1.2s infinite",
              }}
            />
            <span className="small" style={{ color: "var(--bad)", fontWeight: 700 }}>
              Recording · {totalSecs - secs}s
            </span>
          </div>

          <button
            className="btn btn-primary btn-lg btn-block"
            style={{ marginTop: 10 }}
            onClick={() => submitRef.current()}
          >
            Submit answer
          </button>
          {error && <div className="alert alert-error" style={{ margin: "8px 0 0" }}>{error}</div>}
        </div>
      )}

      {/* ── SUBMITTING / GRADING ──────────────────────────────────────────── */}
      {phase === "submitting" && (
        <div className="card stack center" style={{ padding: 36 }}>
          <div className="spinner" aria-hidden="true" />
          <p className="muted">Uploading & grading…</p>
        </div>
      )}

      {/* ── FEEDBACK / CORRECTION ─────────────────────────────────────────── */}
      {phase === "feedback" && (
        <div className="card stack">
          {attempt?.status === "grading" && (
            <div className="row">
              <div className="spinner spinner-sm" aria-hidden="true" />
              <span className="muted">Grading…</span>
            </div>
          )}

          {attempt?.result && (
            <span
              className={`pill ${attempt.result === "pass" ? "pill-good" : "pill-bad"}`}
            >
              {attempt.result === "pass" ? "Pass" : "Needs work"}
            </span>
          )}

          <div>
            <div className="small faint">Answer</div>
            <h2 style={{ margin: 0 }}>{card?.targetText}</h2>
          </div>

          {attempt?.userTranscript != null && (
            <div>
              <div className="small faint">You said</div>
              <div style={{ color: "var(--text-dim)" }}>
                {attempt.userTranscript || <em className="faint">(no transcript)</em>}
              </div>
            </div>
          )}

          {attempt?.correction && (
            <div className="alert" style={{ margin: 0 }}>{attempt.correction}</div>
          )}

          {attempt?.error && (
            <div className="alert alert-error" style={{ margin: 0 }}>{attempt.error}</div>
          )}
          {error && <div className="alert alert-error" style={{ margin: 0 }}>{error}</div>}

          {card && <AudioPlayer src={card.nativeAudioUrl} label="Native audio" />}
          {attempt?.userAudioUrl && (
            <AudioPlayer src={attempt.userAudioUrl} label="Your recording" />
          )}

          <div className="small faint" style={{ marginTop: 4 }}>
            How well did you recall it?
          </div>
          <div className="btn-row">
            {RATINGS.map((r) => (
              <button
                key={r.rating}
                className={`btn ${r.cls === "pill-good" ? "btn-primary" : ""}`}
                onClick={() => rate(r.rating)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button className="btn btn-ghost btn-block" onClick={next}>
            Skip →
          </button>
        </div>
      )}
    </div>
  );
}
