import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, pollJob } from "../lib/api";
import { MAX_RECALL_SECONDS, RECALL_SECONDS } from "../lib/config";
import type { ActiveRecallV2Evidence, Job, ServerDashboardStats, Session, SessionItem, SessionMode, WordAlignmentOperation } from "../lib/types";
import PipelineProgress from "./PipelineProgress";
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

type PendingUpload = {
  item: SessionItem;
  itemIndex: number;
  blob: Blob;
  mimeType: string;
  filename: string;
  promptShownAtMs: number;
  answeredAtMs: number;
  responseSeconds: number;
  timedOut: boolean;
};

const isoFromMs = (ms: number) => new Date(ms).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;
const WAVE_BARS = 5;

function pulseDevice(pattern: number | number[]) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
  } catch {
    /* haptics are best-effort */
  }
}

const VALID_MODES = new Set<SessionMode>(["learn", "review", "practice", "misses", "cloze", "english_to_spanish", "audio_shadow"]);

function explicitModeFromUrl(): SessionMode | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("mode");
  return raw && VALID_MODES.has(raw as SessionMode) ? (raw as SessionMode) : null;
}

function modeLabel(mode: SessionMode): string {
  return {
    learn: "Learn queue · no FSRS yet",
    review: "Due review · FSRS on",
    practice: "Free practice · FSRS off",
    misses: "Misses workout · FSRS off",
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
  // Timed recall is fixed at 15s. Ignore adaptive/server legacy values so the
  // UI never deviates between review/practice/misses/redo sessions.
  void item;
  return Math.min(RECALL_SECONDS, MAX_RECALL_SECONDS);
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
  const [gradingJob, setGradingJob] = useState<Job | null>(null);
  const [sessionMode, setSessionMode] = useState<SessionMode>("review");
  const sessionModeRef = useRef<SessionMode>("review");
  const [routeReady, setRouteReady] = useState(false);
  const [showModePicker, setShowModePicker] = useState(false);
  const [queueStats, setQueueStats] = useState<ServerDashboardStats | null>(null);
  const [noisyMode, setNoisyMode] = useState(false);
  const [micLevels, setMicLevels] = useState<number[]>(Array.from({ length: WAVE_BARS }, () => 0.35));
  const [, setTick] = useState(0);

  const sessionIdRef = useRef<number>(0);
  const promptShownAtRef = useRef<number>(0);
  const uploadedRef = useRef<number[]>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const recordingsRef = useRef<Map<number, string>>(new Map());
  const pendingUploadRef = useRef<PendingUpload | null>(null);
  const submitRef = useRef<() => void>(() => {});
  const supported = isRecordingSupported();

  const item = items[index];

  // ── persistence ─────────────────────────────────────────────────────────
  const persist = useCallback(
    (over: Partial<PersistedSession> = {}) => {
      saveSession({
        sessionId: sessionIdRef.current,
        mode: sessionModeRef.current,
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
    const explicitMode = explicitModeFromUrl();
    const mode = explicitMode ?? "review";
    sessionModeRef.current = mode;
    setSessionMode(mode);
    setShowModePicker(explicitMode == null);
    setRouteReady(true);
    if (explicitMode == null) {
      void api.getDashboardCounts().then(setQueueStats).catch(() => setQueueStats(null));
    }
    if (status !== "idle") return;
    const saved = loadSession();
    if (saved?.mode && (explicitMode == null || saved.phase === "grading")) {
      sessionModeRef.current = saved.mode;
      setSessionMode(saved.mode);
    }
    if (saved?.phase === "grading" && saved.jobId != null) {
      sessionIdRef.current = saved.sessionId;
      uploadedRef.current = saved.uploadedItemIds ?? [];
      setItems(saved.items);
      setIndex(saved.index);
      setPhase("grading");
      setStatus("active");
      void runGrading(saved.sessionId, saved.jobId);
    } else {
      setResumable(saved);
    }
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

  // ── live mic amplitude drives the ritual waveform ─────────────────────────
  useEffect(() => {
    if (status !== "active" || phase !== "recall") return;
    const stream = recorderRef.current?.getStream();
    if (!stream || typeof AudioContext === "undefined") return;
    let raf = 0;
    const AudioCtx = AudioContext;
    const ctx = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      analyser.getByteFrequencyData(data);
      const bucketSize = Math.max(1, Math.floor(data.length / WAVE_BARS));
      const levels = Array.from({ length: WAVE_BARS }, (_, i) => {
        const start = i * bucketSize;
        const bucket = data.slice(start, start + bucketSize);
        const avg = bucket.reduce((sum, v) => sum + v, 0) / Math.max(1, bucket.length);
        return Math.max(0.18, Math.min(1, avg / 110));
      });
      setMicLevels(levels);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void ctx.close();
      setMicLevels(Array.from({ length: WAVE_BARS }, () => 0.35));
    };
  }, [status, phase, index]);

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
      mode: sessionModeRef.current,
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
    const mode = explicitModeFromUrl() ?? sessionMode;
    sessionModeRef.current = mode;
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
      const actualMode = session.mode ?? mode;
      sessionIdRef.current = session.session_id;
      uploadedRef.current = [];
      setItems(session.items);
      sessionModeRef.current = actualMode;
      setSessionMode(actualMode);
      setStatus("active");
      if (actualMode === "learn") {
        setIndex(0);
        setPhase("learn");
        saveSession({
          sessionId: session.session_id,
          mode: actualMode,
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
    let restoredMode = saved.mode ?? saved.graded?.mode;
    if (!restoredMode) {
      try {
        restoredMode = (await api.getSession(saved.sessionId)).mode;
      } catch {
        /* Older offline saves can still resume; review was the historical default. */
      }
    }
    if (restoredMode) {
      sessionModeRef.current = restoredMode;
      setSessionMode(restoredMode);
    }
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
          mode: sessionModeRef.current,
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

  const uploadPendingAndAdvance = useCallback(async (pending = pendingUploadRef.current) => {
    if (!pending) return;
    setPhase("uploading");
    setError(null);
    persist({ phase: "uploading" });

    try {
      await api.uploadRecording(sessionIdRef.current, pending.item.sprint_item_id, pending.blob, {
        mimeType: pending.mimeType,
        promptShownAt: isoFromMs(pending.promptShownAtMs),
        answeredAt: isoFromMs(pending.answeredAtMs),
        responseSeconds: pending.responseSeconds,
        timedOut: pending.timedOut,
        filename: pending.filename,
        noisyMode,
      });
      if (!uploadedRef.current.includes(pending.item.sprint_item_id)) {
        uploadedRef.current.push(pending.item.sprint_item_id);
      }
      pendingUploadRef.current = null;
    } catch (err) {
      setError(
        `${err instanceof ApiError ? err.message : String(err)} — tap to retry.`,
      );
      return; // keep pendingUploadRef so the Retry button resends the same blob
    }

    if (pending.itemIndex + 1 < items.length) {
      beginItem(pending.itemIndex + 1, items, null);
    } else {
      startGrading();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, persist, noisyMode]);

  const submit = useCallback(async () => {
    if (phase !== "recall" || !item) return;
    const answeredAtMs = Date.now();
    const timedOut = deadline != null && remainingMs(deadline) <= 0;
    if (timedOut) pulseDevice([35, 35, 80]);
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

    const pending: PendingUpload = {
      item,
      itemIndex: index,
      blob: rec.blob,
      mimeType: rec.mimeType,
      filename: rec.filename,
      promptShownAtMs: promptShownAtRef.current,
      answeredAtMs,
      responseSeconds,
      timedOut,
    };
    pendingUploadRef.current = pending;
    await uploadPendingAndAdvance(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, item, deadline, index, items, persist, uploadPendingAndAdvance]);

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
        mode: sessionModeRef.current,
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
      await pollJob(jobId, { timeoutMs: 15 * 60_000, onUpdate: setGradingJob });
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
  if (status === "idle" && !routeReady) {
    return <div className="card muted center">Loading speaking modes…</div>;
  }
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
        ) : showModePicker ? (
          <div className="stack speak-mode-picker">
            <div className="card hero-card stack center">
              <div className="spanish-kicker">speak</div>
              <div className="spanish-phrase" style={{ fontSize: "2.25rem" }}>Choose what this session does</div>
              <p className="muted" style={{ margin: 0 }}>
                Only <strong>Due Review</strong> grades your cards into FSRS and changes what is due next.
              </p>
            </div>

            <div className="session-mode-grid">
              <a className="card session-mode-choice session-mode-fsrs" href="/session?mode=review">
                <div className="row between">
                  <span className="pill">FSRS ON</span>
                  <strong>{queueStats ? `${queueStats.due_count} due now` : "Due now"}</strong>
                </div>
                <div>
                  <h2>Due Review</h2>
                  <p className="muted">Practice the cards scheduled for now. Every grade updates the next due date and reduces or reschedules the due queue.</p>
                </div>
                <span className="btn btn-primary btn-block">Review due cards</span>
              </a>

              <a className="card session-mode-choice" href="/session?mode=learn">
                <div className="row between">
                  <span className="pill">LEARN FIRST</span>
                  <strong>{queueStats ? `${queueStats.new_count} new` : "New cards"}</strong>
                </div>
                <div>
                  <h2>Learn New Cards</h2>
                  <p className="muted">Preview meaning, Spanish logic, traps, and audio. The cards enter the FSRS due queue only after you learn them.</p>
                </div>
                <span className="btn btn-block">Open Learn queue</span>
              </a>

              <a className="card session-mode-choice session-mode-free" href="/session?mode=practice">
                <div className="row between">
                  <span className="pill">FSRS OFF</span>
                  <strong>Rotating cards</strong>
                </div>
                <div>
                  <h2>Free Practice</h2>
                  <p className="muted">Speak random introduced cards for extra reps. Feedback is saved, but due dates and the due count do not change.</p>
                </div>
                <span className="btn btn-block">Practice without scheduling</span>
              </a>
            </div>
          </div>
        ) : (
          <div className="card hero-card stack center session-launch-card">
            <span className="pill">{modeLabel(sessionMode)}</span>
            <div className="spanish-phrase" style={{ fontSize: "2.6rem" }}>¿Listo?</div>
            <p className="muted">
              {sessionMode === "learn"
                ? "Preview new sentences here. They enter the FSRS due queue after you finish learning them; this step does not grade the schedule."
                : sessionMode === "practice"
                  ? "FSRS is OFF. Cards rotate for extra speaking practice, but feedback does not change due dates or the due count."
                  : sessionMode === "misses"
                    ? "FSRS is OFF. Fix failed or partial items from previous sessions without changing their schedule."
                    : "FSRS is ON. These are cards due now; every grade updates the next due date and the due queue."}
            </p>
            {sessionMode !== "learn" && (
              <label className="alert row between" style={{ margin: 0, width: "100%", textAlign: "left", cursor: "pointer" }}>
                <span>
                  <strong>Noisy environment mode</strong>
                  <br />
                  <span className="small faint">Train / cafe / background voices. Uses stronger server-side audio cleanup before transcription.</span>
                </span>
                <input
                  className="mode-toggle"
                  type="checkbox"
                  checked={noisyMode}
                  onChange={(event) => setNoisyMode(event.currentTarget.checked)}
                  aria-label="Enable noisy environment mode"
                />
              </label>
            )}
            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={start}
              disabled={sessionMode !== "learn" && !supported}
            >
              {sessionMode === "learn"
                ? "Start learning"
                : sessionMode === "review"
                  ? "Start due review · FSRS ON"
                  : sessionMode === "practice"
                    ? "Start free practice · FSRS OFF"
                    : "Start speaking · FSRS OFF"}
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
    return (
      <Summary
        graded={graded}
        recordings={recordingsRef.current}
        onRefresh={(g) => {
          setGraded(g);
          saveLastGraded(g);
        }}
      />
    );
  }

  // ── render: GRADING ───────────────────────────────────────────────────────
  if (phase === "grading") {
    return (
      <div className="card stack" style={{ padding: 36 }}>
        <div className="spanish-kicker">grading pipeline</div>
        <PipelineProgress progress={gradingJob?.progress} fallbackStatus={gradingJob?.status || "processing"} />
        {error && (
          <>
            <div className="alert alert-error" style={{ margin: 0 }}>{error}</div>
            <button
              className="btn btn-block"
              onClick={() => {
                const saved = loadSession();
                if (saved?.jobId != null) void runGrading(saved.sessionId, saved.jobId);
              }}
            >
              Reconnect to grading
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
            <span className="pill">notebook · no FSRS</span>
            <span className="small faint">no timer</span>
          </div>

          <div className="alert" style={{ margin: 0 }}>
            Look at the idea, listen to the shape of the phrase, then we’ll produce it without scaffolds.
          </div>

          <div>
            <div className="small faint">Spanish phrase</div>
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
              onClick={() => void uploadPendingAndAdvance()}
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
      <div className="row between wrap small faint">
        <span className="pill">{modeLabel(sessionMode)}</span>
        <span>phrase {index + 1} / {items.length}</span>
        <button
          className="btn btn-ghost"
          style={{ minHeight: 32, padding: "4px 10px" }}
          onClick={quit}
        >
          Exit
        </button>
      </div>

      <div className="card hero-card voice-card stack center">
        <div
          className={`mic-timer-ring ${danger ? "danger" : ""}`}
          style={{ "--pct": `${pct}%` } as React.CSSProperties}
          aria-label={`${secs} seconds remaining`}
        >
          <div className="mic-orb" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
              <path d="M19 11a7 7 0 0 1-14 0" />
              <path d="M12 18v3" />
              <path d="M8 21h8" />
            </svg>
          </div>
          <div className="timer-num" style={{ color: danger ? "var(--bad)" : undefined }}>
            {secs}
          </div>
        </div>

        <div className="waveform live" aria-hidden="true">
          {micLevels.map((level, i) => (
            <span key={i} style={{ transform: `scaleY(${level})`, opacity: 0.42 + level * 0.58 }} />
          ))}
        </div>

        <p className="small faint" style={{ margin: "8px 0 0" }}>
          {item?.prompt_type === "audio_shadow"
            ? "Listen, then shadow it calmly"
            : item?.prompt_type === "cloze"
              ? "Complete the phrase out loud"
              : danger ? "Fast now — say it" : "Breathe, think of the idea, speak in Spanish"}
        </p>
        <h2 style={{ margin: "2px 0 0" }}>{item ? promptText(item) : ""}</h2>
        {item?.context_clue && (
          <p className="small faint" style={{ margin: 0 }}>{item.context_clue}</p>
        )}

        {sessionMode === "misses" && item?.feedback && (
          <div className="alert" style={{ margin: "8px 0 0", textAlign: "left" }}>
            <strong>Almost…</strong> {item.feedback}
          </div>
        )}

        {item?.prompt_type === "audio_shadow" && (
          <AudioPlayer src={item.source_audio_url} />
        )}

        {item?.source_audio_url && item.prompt_type !== "audio_shadow" && item.answer_visible === false && (
          <div style={{ width: "100%", textAlign: "left" }}>
            <AudioPlayer src={item.source_audio_url} label="Pronunciation audio" />
          </div>
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
            recording{noisyMode ? " · noisy mode" : ""} · {totalSecs - secs}s
          </span>
        </div>

        {uploadedRef.current.length > 0 && (
          <div className="small faint" aria-live="polite">
            {uploadedRef.current.length} {uploadedRef.current.length === 1 ? "answer" : "answers"} uploaded · grading continues in the background.
          </div>
        )}

        <button
          className="btn btn-primary btn-lg btn-block"
          style={{ marginTop: 10 }}
          onClick={() => submitRef.current()}
        >
          {index + 1 < items.length ? "Check and continue" : "Check and grade"}
        </button>
        {error && <div className="alert alert-error" style={{ margin: "8px 0 0" }}>{error}</div>}
      </div>
    </div>
  );
}

// ── Inline re-record for transcription_unclear items ───────────────────────
type RetryPhase = "idle" | "arming" | "recording" | "uploading" | "grading" | "error";

function RetryRecorder({
  sessionId,
  item,
  onDone,
}: {
  sessionId: number;
  item: SessionItem;
  onDone: (fresh: Session) => void;
}) {
  const [phase, setPhase] = useState<RetryPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const recRef = useRef<Recorder | null>(null);
  const targetRef = useRef<{ id: number; limit: number } | null>(null);
  const shownAtRef = useRef(0);
  const deadlineRef = useRef(0);
  const finishingRef = useRef(false);
  const pendingRef = useRef<{ blob: Blob; mimeType: string; filename: string; answeredAtMs: number; timedOut: boolean } | null>(null);

  useEffect(() => () => recRef.current?.dispose(), []);

  // countdown + auto-stop at the limit (recording stops automatically)
  useEffect(() => {
    if (phase !== "recording") return;
    const id = setInterval(() => {
      const left = Math.max(0, deadlineRef.current - Date.now());
      setSecs(Math.ceil(left / 1000));
      if (left <= 0) void finish(true);
    }, 200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function begin() {
    setError(null);
    setPhase("arming");
    try {
      const retry = await api.retryItem(sessionId, item.sprint_item_id);
      // Retry/re-record uses the same fixed 15s contract as the main recall flow.
      const limit = Math.min(RECALL_SECONDS, MAX_RECALL_SECONDS);
      targetRef.current = { id: retry.sprint_item_id, limit };
      if (!recRef.current) recRef.current = new Recorder();
      await recRef.current.init();
      recRef.current.start();
      finishingRef.current = false;
      pendingRef.current = null;
      shownAtRef.current = Date.now();
      deadlineRef.current = shownAtRef.current + limit * 1000;
      setSecs(limit);
      setPhase("recording");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("error");
    }
  }

  async function finish(timedOut: boolean) {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setPhase("uploading");
    try {
      const rec = await recRef.current!.stop();
      if (!rec || rec.blob.size === 0) throw new Error("No audio was captured — try again.");
      pendingRef.current = { blob: rec.blob, mimeType: rec.mimeType, filename: rec.filename, answeredAtMs: Date.now(), timedOut };
      await uploadAndGrade();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setPhase("error");
      finishingRef.current = false;
    }
  }

  // Upload retry preserves the captured Blob: tapping retry re-sends it.
  async function uploadAndGrade() {
    const pending = pendingRef.current;
    const target = targetRef.current;
    if (!pending || !target) return;
    setPhase("uploading");
    setError(null);
    try {
      await api.uploadRecording(sessionId, target.id, pending.blob, {
        mimeType: pending.mimeType,
        promptShownAt: new Date(shownAtRef.current).toISOString(),
        answeredAt: new Date(pending.answeredAtMs).toISOString(),
        responseSeconds: Math.round(((pending.answeredAtMs - shownAtRef.current) / 1000) * 10) / 10,
        timedOut: pending.timedOut,
        filename: pending.filename,
      });
      setPhase("grading");
      const { job_id } = await api.gradeItem(sessionId, target.id);
      await pollJob(job_id);
      const fresh = await api.getSession(sessionId);
      recRef.current?.dispose();
      recRef.current = null;
      onDone(fresh);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setPhase("error");
      finishingRef.current = false;
    }
  }

  if (phase === "idle") {
    return (
      <button className="btn btn-primary btn-block" onClick={() => void begin()}>
        Re-record now
      </button>
    );
  }
  if (phase === "arming") {
    return <p className="small faint" style={{ margin: 0 }}>Getting the microphone ready…</p>;
  }
  if (phase === "recording") {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div className="row between">
          <span className="small" style={{ color: "var(--rioja)", fontWeight: 800 }}>
            ● recording — say it now
          </span>
          <span className="small" style={{ fontWeight: 800 }}>{secs}s</span>
        </div>
        <button className="btn btn-primary btn-block" onClick={() => void finish(false)}>
          Done — grade it
        </button>
      </div>
    );
  }
  if (phase === "uploading" || phase === "grading") {
    return (
      <p className="small faint" style={{ margin: 0 }}>
        {phase === "uploading" ? "Uploading…" : "Grading your retry…"}
      </p>
    );
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="alert alert-error" style={{ margin: 0 }}>{error}</div>
      {pendingRef.current ? (
        <button className="btn btn-primary btn-block" onClick={() => void uploadAndGrade()}>
          Retry upload
        </button>
      ) : (
        <button className="btn btn-block" onClick={() => void begin()}>
          Try again
        </button>
      )}
    </div>
  );
}

// ── Summary view ────────────────────────────────────────────────────────────
function Summary({
  graded,
  recordings,
  onRefresh,
}: {
  graded: Session | null;
  recordings: Map<number, string>;
  onRefresh?: (fresh: Session) => void;
}) {
  const [deletedPhraseIds, setDeletedPhraseIds] = useState<Set<number>>(() => new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingPhraseId, setDeletingPhraseId] = useState<number | null>(null);
  const summary = graded?.summary;
  const items = (graded?.items ?? []).filter((item) => !deletedPhraseIds.has(item.phrase_id));
  const mode = graded?.mode;
  const misses = items.filter((it) => it.result === "fail" || it.result === "partial");
  const maxPassStreak = items.reduce(
    (acc, it) => {
      const current = it.result === "pass" ? acc.current + 1 : 0;
      return { current, best: Math.max(acc.best, current) };
    },
    { current: 0, best: 0 },
  ).best;
  const cleanRecall = graded?.mode !== "learn" && !!summary && summary.failed === 0 && summary.partial === 0;
  const celebrationTier = graded?.mode === "learn" || !summary ? null : cleanRecall ? "¡Olé!" : summary.failed === 0 ? "¡Eso es!" : summary.partial > 0 ? "¡Casi!" : null;

  useEffect(() => {
    if (!summary || graded?.mode === "learn") return;
    if (cleanRecall) pulseDevice([18, 35, 18, 55, 90]);
    else if (summary.failed > 0) pulseDevice([90, 45, 90]);
    else pulseDevice(35);
  }, [cleanRecall, graded?.mode, summary]);

  async function deleteCard(item: SessionItem) {
    if (!window.confirm(`Delete “${item.spanish || item.english}” from future practice?\n\nIts existing review history will be preserved.`)) return;
    setDeletingPhraseId(item.phrase_id);
    setDeleteError(null);
    try {
      await api.removeCard(item.phrase_id);
      setDeletedPhraseIds((current) => new Set(current).add(item.phrase_id));
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setDeletingPhraseId(null);
    }
  }

  if (!items.length) {
    const title = mode === "learn"
      ? "No new cards"
      : mode === "misses"
        ? "No misses waiting"
        : mode === "practice"
          ? "Nothing available for Free Practice"
          : "Nothing due";
    const body = mode === "learn"
      ? "Your Learn queue is empty. Newly generated packs will appear here before entering FSRS review."
      : mode === "misses"
        ? "No failed or partial items are waiting for a workout."
        : mode === "practice"
          ? "Learn at least one new card, then return for schedule-neutral speaking practice."
          : "No cards are scheduled for Due Review right now.";
    return (
      <div className="card stack center">
        <h2>{title}</h2>
        <p className="muted">{body}</p>
        {mode !== "learn" && (
          <a className="btn btn-block" href="/session?mode=learn">Open Learn queue</a>
        )}
        {mode !== "review" && (
          <a className="btn btn-primary btn-block" href="/session?mode=review">Due Review · FSRS ON</a>
        )}
        {mode !== "practice" && (
          <a className="btn btn-block" href="/session?mode=practice">Free Practice · FSRS OFF</a>
        )}
        <a className="btn btn-ghost btn-block" href="/">Home</a>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card stack center">
        {celebrationTier && (
          <>
            <div className={`ole-burst ${cleanRecall ? "" : "soft"}`} aria-hidden="true">{celebrationTier}</div>
            <div className="petal-burst" aria-hidden="true">
              {Array.from({ length: cleanRecall ? 18 : 10 }).map((_, i) => <span key={i} />)}
            </div>
          </>
        )}
        <h2 style={{ margin: 0 }}>{graded?.mode === "learn" ? "Ready for Due Review" : cleanRecall ? "Clean recall" : "Session graded"}</h2>
        {graded?.mode === "learn" && (
          <p className="muted">These cards are now introduced and due. Start Due Review when you want your spoken grades to begin scheduling them.</p>
        )}
        {graded?.affects_fsrs && (
          <div className="alert alert-ok" style={{ margin: 0, width: "100%" }}>
            <strong>FSRS ON:</strong> these grades updated the cards’ next due dates.
          </div>
        )}
        {graded?.mode === "practice" && (
          <div className="alert" style={{ margin: 0, width: "100%" }}>
            <strong>FSRS OFF:</strong> Free Practice feedback was saved, but due dates and the due count were not changed.
          </div>
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
              <div className="stat">
                <div className="num">🔥 {maxPassStreak}</div>
                <div className="lbl">Best combo</div>
              </div>
            </div>
            <div className="small faint">
              {summary.partial} partial · {summary.overtime_count} overtime
              {summary.unclear ? ` · ${summary.unclear} unclear (retryable)` : ""} ·{" "}
              {summary.total} total
            </div>
          </>
        )}
      </div>

      {graded?.mode === "learn" && (
        <div className="card stack center">
          <h3 style={{ margin: 0 }}>Ready to schedule these cards</h3>
          <p className="muted">Due Review is the FSRS step: your spoken grades set each card’s next review date.</p>
          <a className="btn btn-primary btn-block" href="/session?mode=review">
            Start Due Review · FSRS ON
          </a>
          <a className="btn btn-block" href="/session?mode=practice">
            Free Practice instead · FSRS OFF
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

      {deleteError && <div className="alert alert-error" role="alert">{deleteError}</div>}

      {items.map((it) => {
        const userUrl = it.recording_audio_url || recordings.get(it.sprint_item_id);
        const unclear = it.error_type === "transcription_unclear";
        const alignment = (it.asr?.active_recall_v2 as ActiveRecallV2Evidence | undefined);
        const wordFeedback = Array.isArray(alignment?.word_feedback)
          ? alignment.word_feedback.filter(
              (word): word is WordAlignmentOperation =>
                Boolean(word && typeof word === "object" && typeof word.op === "string"),
            )
          : [];
        const cls =
          it.result === "pass"
            ? "pill-good"
            : it.result === "partial" || unclear
              ? "pill-warn"
              : "pill-bad";
        return (
          <div className="card stack" key={it.sprint_item_id}>
            <div className="row between">
              <span className={`pill ${cls}`}>
                {unclear ? "unclear · retry" : (it.result ?? "pending")}
                {!unclear && it.score != null ? ` · ${Math.round(it.score)}` : ""}
              </span>
              <span className="small faint">
                {graded?.affects_fsrs && it.fsrs_rating && !unclear ? `FSRS ${it.fsrs_rating} · schedule updated` : ""}
                {!graded?.affects_fsrs && !unclear ? "FSRS off · schedule unchanged" : ""}
                {unclear ? "not counted against you" : ""}
                {it.timed_out ? " · ⏱ timed out" : it.over_time ? " · ⏱ over time" : ""}
              </span>
            </div>

            <div>
              <div className="small faint">Answer</div>
              <div style={{ fontWeight: 600 }}>{it.spanish || "Answer hidden until grading completes"}</div>
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

            {wordFeedback.length > 0 && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="small faint">Word check</div>
                <div className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-start" }}>
                  {wordFeedback.map((word, wordIndex) => {
                    const label = word.op === "insert"
                      ? `+ ${word.heard ?? ""}`
                      : word.op === "substitute"
                        ? `${word.heard} → ${word.expected}`
                        : `${word.expected || word.heard || "word"}${word.op === "accent" ? " · accent" : ""}`;
                    const color = word.op === "match"
                      ? "var(--good)"
                      : word.op === "accent"
                        ? "var(--warn)"
                        : "var(--bad)";
                    return (
                      <span
                        key={`${word.op}-${word.expected_index ?? "x"}-${word.heard_index ?? "x"}-${wordIndex}`}
                        className="pill"
                        style={{ borderColor: color, color }}
                        title={word.op}
                      >
                        {label}{word.op === "delete" ? " · missing" : ""}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {it.feedback && (
              <div className="alert" style={{ margin: 0 }}>{it.feedback}</div>
            )}

            <AudioPlayer src={it.source_audio_url} label="Native audio" />
            {userUrl && <AudioPlayer src={userUrl} label="Your recording" />}

            {unclear && graded?.session_id && onRefresh && (
              <RetryRecorder
                sessionId={graded.session_id}
                item={it}
                onDone={onRefresh}
              />
            )}

            <button
              className="btn btn-small btn-danger"
              type="button"
              disabled={deletingPhraseId === it.phrase_id}
              onClick={() => void deleteCard(it)}
            >
              {deletingPhraseId === it.phrase_id ? "Deleting…" : "Delete malformed card"}
            </button>
          </div>
        );
      })}

      <div className="btn-row">
        <a className="btn btn-primary" href="/session?mode=misses">Misses workout</a>
        <a className="btn" href="/session?mode=learn">Open Learn queue</a>
        <a className="btn" href="/">Home</a>
      </div>
    </div>
  );
}
