import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, pollJob } from "../lib/api";
import { RECALL_SECONDS } from "../lib/config";
import type { Session, SessionItem, SessionMode } from "../lib/types";
import { Recorder, isRecordingSupported } from "../lib/recorder";
import {
  clearSession,
  loadSession,
  remainingMs,
  remainingSeconds,
  saveLastGraded,
  saveSession,
  type PersistedSession,
  type Phase,
} from "../lib/timer";
import AudioPlayer from "./AudioPlayer";

type Status = "idle" | "active" | "error";

const isoFromMs = (ms: number) => new Date(ms).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;

const VALID_MODES = new Set<SessionMode>(["learn", "review", "practice", "misses", "cloze", "english_to_spanish", "audio_shadow"]);

function modeFromUrl(): SessionMode {
  if (typeof window === "undefined") return "review";
  const raw = new URLSearchParams(window.location.search).get("mode") || "review";
  return VALID_MODES.has(raw as SessionMode) ? (raw as SessionMode) : "review";
}

function modeLabel(mode: SessionMode): string {
  return {
    learn: "Learn first queue",
    review: "Due review",
    practice: "Practice anytime",
    misses: "Misses workout",
    cloze: "Cloze recall",
    english_to_spanish: "English → Spanish",
    audio_shadow: "Audio shadow",
  }[mode];
}

function promptText(item: SessionItem): string {
  if (item.prompt_type === "cloze") return item.cloze_prompt || item.prompt;
  return item.prompt;
}

function itemForDuration(item?: SessionItem): number {
  return item?.scheduling?.time_limit_seconds || RECALL_SECONDS;
}

export default function RecallSession() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<PersistedSession | null>(null);

  const [items, setItems] = useState<SessionItem[]>([]);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("recall");
  const [deadline, setDeadline] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [graded, setGraded] = useState<Session | null>(null);
  const [sessionMode, setSessionMode] = useState<SessionMode>("review");
  const [, setTick] = useState(0);

  const sessionIdRef = useRef<number>(0);
  const promptShownAtRef = useRef<number>(0);
  const uploadedRef = useRef<number[]>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const recordingsRef = useRef<Map<number, string>>(new Map());
  const submitRef = useRef<() => void>(() => {});
  const supported = isRecordingSupported();

  const item = items[index];

  // ── persistence ─────────────────────────────────────────────────────────
  const persist = useCallback(
    (over: Partial<PersistedSession> = {}) => {
      saveSession({
        sessionId: sessionIdRef.current,
        items,
        index,
        phase,
        deadline,
        durationMs,
        promptShownAt: promptShownAtRef.current
          ? isoFromMs(promptShownAtRef.current)
          : null,
        uploadedItemIds: uploadedRef.current,
        jobId: null,
        graded,
        savedAt: Date.now(),
        ...over,
      });
    },
    [items, index, phase, deadline, durationMs, graded],
  );

  useEffect(() => {
    const mode = modeFromUrl();
    setSessionMode(mode);
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

  // ── cleanup: release mic + revoke local recording URLs ───────────────────
  useEffect(() => {
    const urls = recordingsRef.current;
    return () => {
      recorderRef.current?.dispose();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  function beginItem(i: number, list: SessionItem[], preserveDeadline: number | null) {
    const dur = Math.max(1, itemForDuration(list[i]) ?? RECALL_SECONDS) * 1000;
    let dl = preserveDeadline;
    if (dl == null || remainingMs(dl) < 1000) dl = Date.now() + dur;
    promptShownAtRef.current = dl - dur;
    setIndex(i);
    setPhase("recall");
    setDurationMs(dur);
    setDeadline(dl);
    setError(null);
    try {
      recorderRef.current?.start();
    } catch {
      /* will retry on next gesture */
    }
    saveSession({
      sessionId: sessionIdRef.current,
      items: list,
      index: i,
      phase: "recall",
      deadline: dl,
      durationMs: dur,
      promptShownAt: isoFromMs(promptShownAtRef.current),
      uploadedItemIds: uploadedRef.current,
      jobId: null,
      graded: null,
      savedAt: Date.now(),
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
    const mode = modeFromUrl();
    setSessionMode(mode);
    setError(null);
    if (mode !== "learn") {
      if (!supported) {
        setError("This browser does not support audio recording.");
        return;
      }
      if (!(await armRecorder())) return;
    }
    try {
      const session = await api.createSession(mode);
      if (!session.items?.length) {
        clearSession();
        setGraded({
          session_id: session.session_id,
          items: [],
          mode: session.mode ?? mode,
          affects_fsrs: session.affects_fsrs,
        });
        setPhase("summary");
        setStatus("active");
        return;
      }
      sessionIdRef.current = session.session_id;
      uploadedRef.current = [];
      setItems(session.items);
      setSessionMode(session.mode ?? mode);
      setStatus("active");
      if ((session.mode ?? mode) === "learn") {
        setIndex(0);
        setPhase("learn");
        saveSession({
          sessionId: session.session_id,
          items: session.items,
          index: 0,
          phase: "learn",
          deadline: null,
          durationMs: null,
          promptShownAt: null,
          uploadedItemIds: [],
          jobId: null,
          graded: null,
          savedAt: Date.now(),
        });
      } else {
        beginItem(0, session.items, null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setStatus("error");
    }
  }

  async function resume() {
    const saved = resumable;
    if (!saved) return;
    setError(null);
    sessionIdRef.current = saved.sessionId;
    uploadedRef.current = saved.uploadedItemIds ?? [];
    setItems(saved.items);
    setIndex(saved.index);

    if (saved.phase === "learn") {
      setPhase("learn");
      setStatus("active");
      return;
    }

    if (saved.phase === "summary" && saved.graded) {
      setGraded(saved.graded);
      setPhase("summary");
      setStatus("active");
      return;
    }
    if (saved.phase === "grading" && saved.jobId != null) {
      setPhase("grading");
      setStatus("active");
      runGrading(saved.sessionId, saved.jobId);
      return;
    }
    // recall / uploading → need the mic again; resume preserving the countdown
    if (!(await armRecorder())) {
      setStatus("idle");
      return;
    }
    setStatus("active");
    beginItem(saved.index, saved.items, saved.deadline);
  }

  async function acknowledgeLearned() {
    if (!item) return;
    setError(null);
    try {
      await api.introducePhrase(item.phrase_id);
      if (index + 1 < items.length) {
        const next = index + 1;
        setIndex(next);
        saveSession({
          sessionId: sessionIdRef.current,
          items,
          index: next,
          phase: "learn",
          deadline: null,
          durationMs: null,
          promptShownAt: null,
          uploadedItemIds: uploadedRef.current,
          jobId: null,
          graded: null,
          savedAt: Date.now(),
        });
      } else {
        clearSession();
        setGraded({ session_id: sessionIdRef.current, mode: "learn", affects_fsrs: false, items });
        setPhase("summary");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const submit = useCallback(async () => {
    if (phase !== "recall" || !item) return;
    const answeredAtMs = Date.now();
    const timedOut = deadline != null && remainingMs(deadline) <= 0;
    const responseSeconds = round1((answeredAtMs - promptShownAtRef.current) / 1000);

    setPhase("uploading");
    persist({ phase: "uploading" });

    let rec: { blob: Blob; mimeType: string; filename: string } | null = null;
    try {
      rec = await recorderRef.current!.stop();
    } catch {
      /* no recording captured */
    }

    if (!rec || rec.blob.size === 0) {
      setError("No audio was captured. Recording again.");
      beginItem(index, items, null);
      return;
    }

    // keep a local URL so the learner can replay their own recording (the
    // backend contract doesn't return user-audio URLs).
    const prev = recordingsRef.current.get(item.sprint_item_id);
    if (prev) URL.revokeObjectURL(prev);
    recordingsRef.current.set(item.sprint_item_id, URL.createObjectURL(rec.blob));

    try {
      await api.uploadRecording(sessionIdRef.current, item.sprint_item_id, rec.blob, {
        mimeType: rec.mimeType,
        promptShownAt: isoFromMs(promptShownAtRef.current),
        answeredAt: isoFromMs(answeredAtMs),
        responseSeconds,
        timedOut,
        filename: rec.filename,
      });
      if (!uploadedRef.current.includes(item.sprint_item_id)) {
        uploadedRef.current.push(item.sprint_item_id);
      }
    } catch (err) {
      setError(
        `${err instanceof ApiError ? err.message : String(err)} — tap to retry.`,
      );
      return; // stays in "uploading" with a Retry button
    }

    if (index + 1 < items.length) {
      beginItem(index + 1, items, null);
    } else {
      startGrading();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, item, deadline, index, items, persist]);

  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  async function startGrading() {
    setPhase("grading");
    setError(null);
    persist({ phase: "grading" });
    try {
      const { job_id } = await api.gradeSession(sessionIdRef.current);
      saveSession({
        sessionId: sessionIdRef.current,
        items,
        index,
        phase: "grading",
        deadline: null,
        durationMs: null,
        promptShownAt: null,
        uploadedItemIds: uploadedRef.current,
        jobId: job_id,
        graded: null,
        savedAt: Date.now(),
      });
      runGrading(sessionIdRef.current, job_id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function runGrading(sessionId: number, jobId: string | number) {
    setPhase("grading");
    try {
      await pollJob(jobId);
      const gradedSession = await api.getSession(sessionId);
      setGraded(gradedSession);
      saveLastGraded(gradedSession);
      clearSession();
      setPhase("summary");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  function quit() {
    clearSession();
    recorderRef.current?.dispose();
    window.location.href = "/";
  }

  // ── render: IDLE ──────────────────────────────────────────────────────────
  if (status === "idle") {
    return (
      <div className="stack">
        {!supported && sessionMode !== "learn" && (
          <div className="alert alert-error">
            Audio recording isn’t supported here. Open the app in iPhone Safari.
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {resumable ? (
          <div className="card hero-card stack center">
            <div className="spanish-kicker">seguimos</div>
            <p className="muted">
              {resumable.phase === "summary"
                ? "View your last session results?"
                : resumable.phase === "grading"
                  ? "Resume grading your session?"
                  : `Resume at item ${resumable.index + 1} of ${resumable.items.length}?`}
            </p>
            <button className="btn btn-primary btn-lg btn-block" onClick={resume}>
              Resume
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
          <div className="card hero-card stack center">
            <span className="pill">{modeLabel(sessionMode)}</span>
            <div className="spanish-phrase" style={{ fontSize: "2.6rem" }}>¿Listo?</div>
            <p className="muted">
              {sessionMode === "learn"
                ? "Learn the meaning, Spanish logic, traps, and audio before this phrase enters timed recall."
                : sessionMode === "practice"
                  ? "Practice introduced phrases anytime. This does not update FSRS."
                  : sessionMode === "misses"
                    ? "Fix failed or partial items from previous sessions. This does not update FSRS."
                    : "Recall each prompt aloud before the timer ends. The backend grades your spoken answers."}
            </p>
            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={start}
              disabled={sessionMode !== "learn" && !supported}
            >
              {sessionMode === "learn" ? "Aprender" : "Empieza"}
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
        <button
          className="btn btn-primary btn-block"
          onClick={() => {
            setError(null);
            setStatus("idle");
          }}
        >
          Back
        </button>
      </div>
    );
  }

  // ── render: SUMMARY ───────────────────────────────────────────────────────
  if (phase === "summary") {
    return <Summary graded={graded} recordings={recordingsRef.current} />;
  }

  // ── render: GRADING ───────────────────────────────────────────────────────
  if (phase === "grading") {
    return (
      <div className="card stack center" style={{ padding: 36 }}>
        <div className="spinner" aria-hidden="true" />
        <p className="muted">Grading your answers…</p>
        {error && (
          <>
            <div className="alert alert-error" style={{ margin: 0 }}>{error}</div>
            <button
              className="btn btn-block"
              onClick={() => runGrading(sessionIdRef.current, loadSession()?.jobId ?? 0)}
            >
              Retry grading
            </button>
          </>
        )}
      </div>
    );
  }

  // ── render: LEARN ─────────────────────────────────────────────────────────
  if (phase === "learn" && item) {
    const learning = item.learning_card;
    return (
      <div className="stack">
        <div className="row between small faint">
          <span>Learn {index + 1} / {items.length}</span>
          <button
            className="btn btn-ghost"
            style={{ minHeight: 32, padding: "4px 10px" }}
            onClick={quit}
          >
            End
          </button>
        </div>

        <div className="card notebook-card stack">
          <div className="row between">
            <span className="pill">cuaderno · sin FSRS</span>
            <span className="small faint">sin prisa</span>
          </div>

          <div className="alert" style={{ margin: 0 }}>
            Mira la idea, escucha la música de la frase y luego la producimos sin andamios.
          </div>

          <div>
            <div className="small faint">Frase española</div>
            <h2 style={{ margin: "4px 0 0" }}>{item.spanish}</h2>
          </div>

          {item.source_audio_url && <AudioPlayer src={item.source_audio_url} label="Native audio" />}

          <div>
            <div className="small faint">Meaning</div>
            <div style={{ fontWeight: 600 }}>{item.english_meaning || item.english}</div>
          </div>

          {item.context_clue && (
            <div>
              <div className="small faint">Context cue</div>
              <div>{item.context_clue}</div>
            </div>
          )}

          {learning?.spanish_logic && (
            <div className="alert" style={{ margin: 0 }}>
              <strong>Spanish logic:</strong> {learning.spanish_logic}
            </div>
          )}

          {learning?.english_trap && (
            <div className="alert" style={{ margin: 0 }}>
              <strong>English trap:</strong> {learning.english_trap}
            </div>
          )}

          {learning?.grammar_focus && (
            <div>
              <div className="small faint">Pattern</div>
              <span className="pill">{learning.grammar_focus}</span>
            </div>
          )}

          {!!learning?.examples?.length && (
            <div>
              <div className="small faint">Related examples</div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {learning.examples.map((ex) => <li key={ex}>{ex}</li>)}
              </ul>
            </div>
          )}

          {error && <div className="alert alert-error" style={{ margin: 0 }}>{error}</div>}

          <button className="btn btn-primary btn-lg btn-block" onClick={acknowledgeLearned}>
            {index + 1 < items.length ? "I understand · next" : "I understand · finish"}
          </button>
          <a className="btn btn-ghost btn-block" href="/session?mode=practice">
            Practice introduced phrases instead
          </a>
        </div>
      </div>
    );
  }

  // ── render: UPLOADING (with retry on failure) ─────────────────────────────
  if (phase === "uploading") {
    return (
      <div className="card stack center" style={{ padding: 36 }}>
        {error ? (
          <>
            <div className="alert alert-error" style={{ margin: 0 }}>{error}</div>
            <button
              className="btn btn-primary btn-block"
              onClick={() => submitRef.current()}
            >
              Retry upload
            </button>
          </>
        ) : (
          <>
            <div className="spinner" aria-hidden="true" />
            <p className="muted">Uploading…</p>
          </>
        )}
      </div>
    );
  }

  // ── render: RECALL (prompt · countdown · recording state · submit) ─────────
  const secs = remainingSeconds(deadline);
  const totalSecs = durationMs ? Math.round(durationMs / 1000) : 1;
  const pct = deadline
    ? Math.max(0, Math.min(100, (remainingMs(deadline) / (durationMs || 1)) * 100))
    : 0;
  const danger = secs <= 3;

  return (
    <div className="stack recall-shell">
      <div className="row between small faint">
        <span>
          frase {index + 1} / {items.length}
        </span>
        <button
          className="btn btn-ghost"
          style={{ minHeight: 32, padding: "4px 10px" }}
          onClick={quit}
        >
          salir
        </button>
      </div>

      <div className="card hero-card voice-card stack center">
        <div className="timer-num" style={{ color: danger ? "var(--bad)" : undefined }}>
          {secs}
        </div>
        <div
          style={{
            height: 8,
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

        <div className="mic-orb" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
            <path d="M19 11a7 7 0 0 1-14 0" />
            <path d="M12 18v3" />
            <path d="M8 21h8" />
          </svg>
        </div>
        <div className="waveform" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>

        <p className="small faint" style={{ margin: "8px 0 0" }}>
          {item?.prompt_type === "audio_shadow"
            ? "Escucha y repite con calma"
            : item?.prompt_type === "cloze"
              ? "Completa la frase en voz alta"
              : danger ? "Rápido — suéltalo" : "Respira, piensa en la idea, habla en español"}
        </p>
        <h2 style={{ margin: "2px 0 0" }}>{item ? promptText(item) : ""}</h2>
        {item?.context_clue && (
          <p className="small faint" style={{ margin: 0 }}>{item.context_clue}</p>
        )}

        {sessionMode === "misses" && item?.feedback && (
          <div className="alert" style={{ margin: "8px 0 0", textAlign: "left" }}>
            <strong>Casi…</strong> {item.feedback}
          </div>
        )}

        {item?.prompt_type === "audio_shadow" && (
          <AudioPlayer src={item.source_audio_url} />
        )}

        <div className="row" style={{ gap: 8, marginTop: 6, justifyContent: "center" }}>
          <span
            aria-hidden="true"
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: "var(--rioja)",
              animation: "pulse 1.2s infinite",
            }}
          />
          <span className="small" style={{ color: "var(--rioja)", fontWeight: 800 }}>
            grabando · {totalSecs - secs}s
          </span>
        </div>

        <button
          className="btn btn-primary btn-lg btn-block"
          style={{ marginTop: 10 }}
          onClick={() => submitRef.current()}
        >
          {index + 1 < items.length ? "Comprobar y seguir" : "Comprobar y calificar"}
        </button>
        {error && <div className="alert alert-error" style={{ margin: "8px 0 0" }}>{error}</div>}
      </div>
    </div>
  );
}

// ── Summary view ────────────────────────────────────────────────────────────
function Summary({
  graded,
  recordings,
}: {
  graded: Session | null;
  recordings: Map<number, string>;
}) {
  const summary = graded?.summary;
  const items = graded?.items ?? [];
  const mode = graded?.mode;
  const misses = items.filter((it) => it.result === "fail" || it.result === "partial");

  if (!items.length) {
    const title = mode === "learn" ? "No new phrases" : mode === "misses" ? "No misses waiting" : "Nothing due";
    const body = mode === "learn"
      ? "Everything new has already been introduced."
      : mode === "misses"
        ? "No failed or partial items are waiting for a workout."
        : "No items were scheduled for this session.";
    return (
      <div className="card stack center">
        <h2>{title}</h2>
        <p className="muted">{body}</p>
        {mode !== "learn" && (
          <a className="btn btn-primary btn-block" href="/session?mode=learn">Learn first queue</a>
        )}
        {mode !== "practice" && (
          <a className="btn btn-block" href="/session?mode=practice">Practice anytime</a>
        )}
        <a className="btn btn-ghost btn-block" href="/">Home</a>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card stack center">
        <h2 style={{ margin: 0 }}>{graded?.mode === "learn" ? "Listo para hablar" : summary && summary.failed === 0 && summary.partial === 0 ? "¡Olé!" : "Sesión calificada"}</h2>
        {graded?.mode === "learn" && (
          <p className="muted">These phrases are now introduced. Next step: produce them from English under the timer.</p>
        )}
        {graded?.mode === "misses" && (
          <p className="muted">Misses workout complete. Passing here resolves weak spots without touching FSRS.</p>
        )}
        {summary && (
          <>
            <div className="stat-grid" style={{ width: "100%" }}>
              <div className="stat">
                <div className="num">{Math.round(summary.score)}</div>
                <div className="lbl">Score</div>
              </div>
              <div className="stat">
                <div className="num">{summary.passed}</div>
                <div className="lbl">Passed</div>
              </div>
              <div className="stat">
                <div className="num">{summary.failed}</div>
                <div className="lbl">Failed</div>
              </div>
            </div>
            <div className="small faint">
              {summary.partial} partial · {summary.overtime_count} overtime ·{" "}
              {summary.total} total
            </div>
          </>
        )}
      </div>

      {graded?.mode === "learn" && (
        <div className="card stack center">
          <h3 style={{ margin: 0 }}>Ready for timed production</h3>
          <p className="muted">Practice uses clear English prompts and does not update FSRS.</p>
          <a className="btn btn-primary btn-block" href="/session?mode=practice">
            Practice these now
          </a>
          <a className="btn btn-block" href="/session?mode=review">
            Review due cards instead
          </a>
        </div>
      )}

      {graded?.mode !== "learn" && misses.length > 0 && (
        <div className="card stack center">
          <h3 style={{ margin: 0 }}>Work the misses next</h3>
          <p className="muted">{misses.length} failed/partial item{misses.length === 1 ? "" : "s"} ready for targeted retry.</p>
          <a className="btn btn-primary btn-block" href="/session?mode=misses">
            Start misses workout
          </a>
        </div>
      )}

      {items.map((it) => {
        const userUrl = it.recording_audio_url || recordings.get(it.sprint_item_id);
        const cls =
          it.result === "pass"
            ? "pill-good"
            : it.result === "partial"
              ? "pill-warn"
              : "pill-bad";
        return (
          <div className="card stack" key={it.sprint_item_id}>
            <div className="row between">
              <span className={`pill ${cls}`}>
                {it.result ?? "pending"}
                {it.score != null ? ` · ${Math.round(it.score)}` : ""}
              </span>
              <span className="small faint">
                {it.fsrs_rating ? `FSRS ${it.fsrs_rating}` : ""}
                {it.timed_out ? " · ⏱ overtime" : ""}
              </span>
            </div>

            <div>
              <div className="small faint">Answer</div>
              <div style={{ fontWeight: 600 }}>{it.spanish}</div>
              <div className="small faint">{it.english}</div>
            </div>

            {it.user_transcript_segment != null && (
              <div>
                <div className="small faint">You said</div>
                <div style={{ color: "var(--text-dim)" }}>
                  {it.user_transcript_segment || (
                    <em className="faint">(no transcript)</em>
                  )}
                </div>
              </div>
            )}

            {it.feedback && (
              <div className="alert" style={{ margin: 0 }}>{it.feedback}</div>
            )}

            <AudioPlayer src={it.source_audio_url} label="Native audio" />
            {userUrl && <AudioPlayer src={userUrl} label="Your recording" />}
          </div>
        );
      })}

      <div className="btn-row">
        <a className="btn btn-primary" href="/session?mode=misses">Misses workout</a>
        <a className="btn" href="/session?mode=learn">Learn first queue</a>
        <a className="btn" href="/">Home</a>
      </div>
    </div>
  );
}
