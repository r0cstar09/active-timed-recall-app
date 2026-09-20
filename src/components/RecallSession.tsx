import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, pollJob } from "../lib/api";
import { RECALL_SECONDS } from "../lib/config";
import { itemForDuration, recallSecondsFromServer } from "../lib/recallDuration";
import type { ActiveRecallV2Evidence, Job, ResumableSessionSummary, ServerDashboardStats, Session, SessionItem, SessionMode, WordAlignmentOperation } from "../lib/types";
import PipelineProgress from "./PipelineProgress";
import { ENCODER_POSTROLL_MS, ENCODER_PREROLL_MS, Recorder, isRecordingSupported } from "../lib/recorder";
import {
  clearSession,
  loadSession,
  remainingMs,
  remainingSeconds,
  saveCompletedSession,
  saveSession,
  type PersistedSession,
  type Phase,
} from "../lib/timer";
import AudioPlayer from "./AudioPlayer";
import { recallPromptPresentation } from "../lib/recallPrompt";
import { correctionPhraseIds, latestSessionItems } from "../lib/sessionCorrections";
import { isIncompleteRecordingError } from "../lib/recordingRecovery";
import { requirePracticeTopicPhraseIds } from "../lib/practiceTopics";
import PracticeTopicPicker, { type PracticeTopicPickerStatus } from "./PracticeTopicPicker";

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

function topicFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("topic")?.trim();
  return value || null;
}

function setTopicInUrl(topicId: string | null) {
  if (typeof window === "undefined") return;
  const next = new URL(window.location.href);
  if (topicId) next.searchParams.set("topic", topicId);
  else next.searchParams.delete("topic");
  window.history.replaceState({}, "", next);
}

function writtenPracticeHref(topicId: string | null): string {
  const params = new URLSearchParams({ mode: "practice" });
  if (topicId) params.set("topic", topicId);
  return `/write?${params.toString()}`;
}

function modeLabel(mode: SessionMode): string {
  return {
    learn: "Learn queue · no FSRS yet",
    review: "Due review · FSRS on",
    practice: "Free practice · FSRS off",
    misses: "Misses workout · FSRS on",
    cloze: "Cloze recall · FSRS on",
    english_to_spanish: "English → Spanish · FSRS on",
    audio_shadow: "Audio shadow · FSRS on",
  }[mode];
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
  const [serverResumable, setServerResumable] = useState<ResumableSessionSummary | null>(null);
  const [launching, setLaunching] = useState(false);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [topicSelectionReady, setTopicSelectionReady] = useState(false);
  const [advancingLearn, setAdvancingLearn] = useState(false);
  const [noisyMode, setNoisyMode] = useState(false);
  const [micLevels, setMicLevels] = useState<number[]>(Array.from({ length: WAVE_BARS }, () => 0.35));
  const [failedSourceAudioItems, setFailedSourceAudioItems] = useState<Set<number>>(() => new Set());
  const [, setTick] = useState(0);

  const sessionIdRef = useRef<number>(0);
  const promptShownAtRef = useRef<number>(0);
  const uploadedRef = useRef<number[]>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const recordingsRef = useRef<Map<number, string>>(new Map());
  const pendingUploadRef = useRef<PendingUpload | null>(null);
  const submitRef = useRef<() => void>(() => {});
  const submitInFlightRef = useRef(false);
  const uploadInFlightRef = useRef(false);
  const launchInFlightRef = useRef(false);
  const learnAdvanceInFlightRef = useRef(false);
  const itemStartTokenRef = useRef(0);
  const microphoneStartInFlightRef = useRef(false);
  const selectedTopicIdRef = useRef<string | null>(null);
  const topicLaunchVersionRef = useRef(0);
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
    // This effect reruns when a session becomes active. Never let that rerun
    // replace the persisted mode restored by resume() with the route/default.
    if (status !== "idle") return;
    const explicitMode = explicitModeFromUrl();
    const mode = explicitMode ?? "review";
    sessionModeRef.current = mode;
    setSessionMode(mode);
    setShowModePicker(explicitMode == null);
    const topicId = mode === "practice" ? topicFromUrl() : null;
    selectedTopicIdRef.current = topicId;
    setSelectedTopicId(topicId);
    setTopicSelectionReady(mode !== "practice");
    setRouteReady(true);
    if (explicitMode == null) {
      void api.getDashboardCounts().then(setQueueStats).catch(() => setQueueStats(null));
    }
    const saved = loadSession();
    if (saved?.mode && (explicitMode == null || saved.phase === "grading")) {
      sessionModeRef.current = saved.mode;
      setSessionMode(saved.mode);
    }
    if (saved?.phase === "grading") {
      sessionIdRef.current = saved.sessionId;
      uploadedRef.current = saved.uploadedItemIds ?? [];
      setItems(saved.items);
      setIndex(saved.index);
      setPhase("grading");
      setStatus("active");
      void startGrading(saved);
    } else {
      setResumable(saved?.phase === "summary" && explicitMode && saved.mode !== explicitMode ? null : saved);
    }
  }, [status]);

  const choosePracticeTopic = useCallback((topicId: string | null) => {
    if (launchInFlightRef.current) return;
    topicLaunchVersionRef.current += 1;
    selectedTopicIdRef.current = topicId;
    setSelectedTopicId(topicId);
    setTopicSelectionReady(false);
    setError(null);
    setTopicInUrl(topicId);
  }, []);

  const receiveTopicPickerStatus = useCallback((picker: PracticeTopicPickerStatus) => {
    setTopicSelectionReady(!picker.loading && !picker.loadError && picker.selectionValid);
  }, []);

  // ── countdown tick + auto-resync on visibility/refocus ───────────────────
  useEffect(() => {
    if (status !== "active" || phase !== "recall") return;
    const checkCapture = () => {
      if (!submitInFlightRef.current) {
        const issue = recorderRef.current?.captureIssue;
        if (issue) {
          recoverMicrophone(issue);
          return;
        }
      }
      setTick((t) => t + 1);
    };
    const id = setInterval(checkCapture, 200);
    const onVisible = checkCapture;
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [status, phase, index, persist]);

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
      itemStartTokenRef.current += 1;
      recorderRef.current?.dispose();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  function recoverMicrophone(message: string) {
    // Broken capture is not an upload retry. Wait for a fresh gesture on the same card.
    itemStartTokenRef.current += 1;
    submitInFlightRef.current = true;
    recorderRef.current?.dispose();
    recorderRef.current = null;
    pendingUploadRef.current = null;
    setPhase("arming");
    setDeadline(null);
    setError(`${message} This attempt won't be graded. Tap Retry microphone to record this card again.`);
    persist({ phase: "arming", deadline: null, promptShownAt: null });
  }

  async function beginItem(i: number, list: SessionItem[], preserveDeadline: number | null) {
    if (microphoneStartInFlightRef.current) return;
    microphoneStartInFlightRef.current = true;
    const startToken = ++itemStartTokenRef.current;
    const dur = Math.max(1, itemForDuration(list[i]) ?? RECALL_SECONDS) * 1000;
    submitInFlightRef.current = false;
    setIndex(i);
    setPhase("arming");
    setDeadline(null);
    setDurationMs(dur);
    setError(null);
    // Persist the next item before the asynchronous pre-roll. A refresh during
    // microphone setup must not resume the previously uploaded card.
    saveSession({
      sessionId: sessionIdRef.current,
      mode: sessionModeRef.current,
      items: list,
      index: i,
      phase: "arming",
      deadline: preserveDeadline,
      durationMs: dur,
      promptShownAt: null,
      uploadedItemIds: uploadedRef.current,
      jobId: null,
      graded: null,
      savedAt: Date.now(),
    });

    try {
      if (!recorderRef.current) recorderRef.current = new Recorder();
      const recorder = recorderRef.current;
      await recorder.init();
      if (startToken !== itemStartTokenRef.current) {
        recorder.dispose();
        return;
      }
      await recorder.start(ENCODER_PREROLL_MS);
    } catch (err) {
      if (startToken === itemStartTokenRef.current) {
        recorderRef.current?.dispose();
        recorderRef.current = null;
        setError(err instanceof Error ? err.message : "Could not start recording.");
      }
      return;
    } finally {
      microphoneStartInFlightRef.current = false;
    }
    if (startToken !== itemStartTokenRef.current) return;

    let dl = preserveDeadline;
    if (dl == null || remainingMs(dl) < 1000) dl = Date.now() + dur;
    promptShownAtRef.current = dl - dur;
    setPhase("recall");
    setDurationMs(dur);
    setDeadline(dl);
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
    if (launchInFlightRef.current) return;
    launchInFlightRef.current = true;
    const launchVersion = ++topicLaunchVersionRef.current;
    setLaunching(true);
    try {
      const mode = explicitModeFromUrl() ?? sessionMode;
      sessionModeRef.current = mode;
      setSessionMode(mode);
      setError(null);
      if (mode === "practice" && !topicSelectionReady) {
        setError("Wait for the practice topics to load, then choose a valid focus.");
        return;
      }
      if (mode !== "learn") {
        if (!supported) {
          setError("This browser does not support audio recording.");
          return;
        }
        if (!(await armRecorder())) return;
      }
      let phraseIds: number[] | undefined;
      const chosenTopicId = mode === "practice" ? selectedTopicIdRef.current : null;
      if (chosenTopicId) {
        const topicCards = await api.getPracticeTopicCards(chosenTopicId, 10);
        if (launchVersion !== topicLaunchVersionRef.current || selectedTopicIdRef.current !== chosenTopicId) return;
        phraseIds = requirePracticeTopicPhraseIds(topicCards, chosenTopicId);
      }
      const session = phraseIds
        ? await api.createSession("practice", phraseIds.length, phraseIds)
        : await api.createSession(mode);
      if (launchVersion !== topicLaunchVersionRef.current) return;
      if (!session.items?.length) {
        clearSession();
        setServerResumable(session.resumable_session ?? null);
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
      // Topic lookups fail closed on the launcher. Never reinterpret a failed
      // filtered request as an unfiltered Mix all session.
      recorderRef.current?.dispose();
      recorderRef.current = null;
      if (sessionModeRef.current !== "practice") setStatus("error");
    } finally {
      launchInFlightRef.current = false;
      setLaunching(false);
    }
  }

  async function resume() {
    if (launchInFlightRef.current) return;
    const saved = loadSession();
    if (!saved) { setResumable(null); return; }
    launchInFlightRef.current = true;
    setLaunching(true);
    setError(null);
    const startToken = itemStartTokenRef.current;
    const snapshot = JSON.stringify(saved);
    const stillCurrent = () => {
      if (startToken !== itemStartTokenRef.current) return false;
      const current = loadSession();
      if (JSON.stringify(current) === snapshot) return true;
      setResumable(current);
      return false;
    };
    try {
      let restoredMode = saved.mode ?? saved.graded?.mode;
      if (!restoredMode) {
        try {
          restoredMode = (await api.getSession(saved.sessionId)).mode;
        } catch {
          /* Older offline saves can still resume; review was the historical default. */
        }
        if (!stillCurrent()) return;
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
        try {
          const fresh = await api.getSession(saved.sessionId);
          if (!stillCurrent()) return;
          if (fresh.session_id !== saved.sessionId || fresh.response_mode === "written") throw new Error("Saved batch mismatch");
          // Refresh grades, not batch membership (including locally removed cards).
          const allowed = new Set(saved.items.map(item => item.phrase_id));
          const scoped = { ...fresh, items: fresh.items.filter(item => allowed.has(item.phrase_id)) };
          saveCompletedSession(scoped);
          setItems(scoped.items);
          setGraded(scoped);
          setPhase("summary");
          setStatus("active");
        } catch (err) {
          if (stillCurrent()) setError(`Could not restore this batch: ${err instanceof Error ? err.message : String(err)}. Retry; no other cards were requested.`);
        }
        return;
      }
      if (saved.phase === "grading") {
        setPhase("grading");
        setStatus("active");
        void startGrading(saved);
        return;
      }
      // recall / uploading → need the mic again; resume preserving the countdown
      const armed = await armRecorder();
      if (!stillCurrent()) return;
      if (!armed) {
        setStatus("idle");
        return;
      }
      setStatus("active");
      beginItem(saved.index, saved.items, saved.deadline);
    } finally {
      launchInFlightRef.current = false;
      setLaunching(false);
    }
  }

  async function continueServerSession() {
    const resumable = serverResumable;
    if (!resumable) return;
    setError(null);
    if (resumable.mode !== "learn") {
      if (!supported) {
        setError("This browser does not support audio recording.");
        setStatus("error");
        return;
      }
      if (!(await armRecorder())) {
        setStatus("error");
        return;
      }
    }

    try {
      const session = await api.getSession(resumable.session_id);
      const actualMode = session.mode ?? resumable.mode;
      const remainingItems = session.items.filter(
        (candidate) => candidate.result === "pending" && !candidate.recording_id && !candidate.timed_out,
      );
      sessionIdRef.current = session.session_id;
      sessionModeRef.current = actualMode;
      uploadedRef.current = session.items
        .filter((candidate) => Boolean(candidate.recording_id) || Boolean(candidate.timed_out))
        .map((candidate) => candidate.sprint_item_id);
      setSessionMode(actualMode);
      setServerResumable(null);

      if (!remainingItems.length) {
        const saved: PersistedSession = {
          sessionId: session.session_id,
          mode: actualMode,
          items: session.items,
          index: Math.max(0, session.items.length - 1),
          phase: "grading",
          deadline: null,
          durationMs: null,
          promptShownAt: null,
          uploadedItemIds: uploadedRef.current,
          jobId: null,
          graded: null,
          savedAt: Date.now(),
        };
        setItems(session.items);
        setIndex(saved.index);
        setPhase("grading");
        setStatus("active");
        void startGrading(saved);
        return;
      }

      setItems(remainingItems);
      setIndex(0);
      setStatus("active");
      beginItem(0, remainingItems, null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setStatus("error");
    }
  }

  async function acknowledgeLearned() {
    if (!item || learnAdvanceInFlightRef.current) return;
    learnAdvanceInFlightRef.current = true;
    setAdvancingLearn(true);
    setError(null);
    const finishingBatch = index + 1 >= items.length;
    try {
      // Request the microphone from the final explicit learner gesture before
      // any network awaits; iPhone Safari can otherwise drop user activation.
      if (finishingBatch) {
        if (!supported) {
          setError("This browser cannot record the immediate spoken test. Open the app in Safari or Chrome.");
          return;
        }
        if (!(await armRecorder())) return;
      }

      await api.introducePhrase(item.phrase_id);
      if (!finishingBatch) {
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
        return;
      }

      const learnedPhraseIds = items.map((learnedItem) => learnedItem.phrase_id);
      const practice = await api.createSession("practice", learnedPhraseIds.length, learnedPhraseIds);
      if (!practice.items?.length) {
        throw new Error("The just-learned test could not be created. Tap again to retry.");
      }

      clearSession();
      sessionIdRef.current = practice.session_id;
      sessionModeRef.current = "practice";
      uploadedRef.current = [];
      setSessionMode("practice");
      setItems(practice.items);
      setIndex(0);
      setGraded(null);
      setResumable(null);
      setServerResumable(null);
      setFailedSourceAudioItems(new Set());
      if (typeof window !== "undefined") {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set("mode", "practice");
        nextUrl.searchParams.delete("topic");
        window.history.replaceState({}, "", nextUrl);
      }
      await beginItem(0, practice.items, null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      learnAdvanceInFlightRef.current = false;
      setAdvancingLearn(false);
    }
  }

  async function correctBatch(phraseIds: number[]) {
    if (launchInFlightRef.current || !graded || !phraseIds.length) return;
    const allowed = new Set(correctionPhraseIds(graded.items));
    if (phraseIds.some((id) => !allowed.has(id))) return;
    launchInFlightRef.current = true;
    setLaunching(true);
    setError(null);
    try {
      // Explicit gesture before network calls, as in the initial Learn handoff.
      if (!(await armRecorder())) return;
      const fresh = await api.getSession(graded.session_id);
      if (fresh.session_id !== graded.session_id || fresh.response_mode === "written") throw new Error("Saved batch mismatch");
      const scope = new Set(graded.items.map(item => item.phrase_id));
      const scoped = { ...fresh, items: fresh.items.filter(item => scope.has(item.phrase_id)) };
      setGraded(scoped);
      saveCompletedSession(scoped);
      if (latestSessionItems(scoped.items).some(item => item.result === "pending")) {
        throw new Error("Resume the unfinished re-recording in this batch before starting corrections.");
      }
      const remaining = new Set(correctionPhraseIds(scoped.items));
      phraseIds = phraseIds.filter(id => remaining.has(id));
      if (!phraseIds.length) return;
      const practice = await api.createSession("practice", phraseIds.length, phraseIds);
      sessionIdRef.current = practice.session_id;
      sessionModeRef.current = "practice";
      uploadedRef.current = [];
      pendingUploadRef.current = null;
      setSessionMode("practice");
      setItems(practice.items);
      setGraded(null);
      setResumable(null);
      setServerResumable(null);
      setFailedSourceAudioItems(new Set());
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("mode", "practice");
      window.history.replaceState({}, "", nextUrl);
      await beginItem(0, practice.items, null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      launchInFlightRef.current = false;
      setLaunching(false);
    }
  }

  const uploadPendingAndAdvance = useCallback(async (pending = pendingUploadRef.current) => {
    if (!pending || uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    try {
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
        if (isIncompleteRecordingError(err)) {
          recoverMicrophone("The browser captured only part of your audio.");
          return;
        }
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
    } finally {
      uploadInFlightRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, persist, noisyMode]);

  const submit = useCallback(async () => {
    if (submitInFlightRef.current || phase !== "recall" || !item) return;
    submitInFlightRef.current = true;
    const answeredAtMs = Date.now();
    const timedOut = deadline != null && remainingMs(deadline) <= 0;
    if (timedOut) pulseDevice([35, 35, 80]);
    const responseSeconds = round1((answeredAtMs - promptShownAtRef.current) / 1000);

    setPhase("uploading");
    persist({ phase: "uploading" });

    let rec: { blob: Blob; mimeType: string; filename: string; interrupted: boolean } | null = null;
    try {
      rec = await recorderRef.current!.stop(ENCODER_POSTROLL_MS);
    } catch {
      /* no recording captured */
    }

    if (!rec || rec.blob.size === 0 || rec.interrupted) {
      recoverMicrophone(rec?.interrupted ? "Microphone was interrupted." : "No audio was captured.");
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

  async function startGrading(saved?: PersistedSession) {
    // Release the session stream before inline retries open another microphone.
    recorderRef.current?.dispose();
    recorderRef.current = null;
    const sessionId = saved?.sessionId ?? sessionIdRef.current;
    const gradingItems = saved?.items ?? items;
    const gradingIndex = saved?.index ?? index;
    const uploadedItemIds = saved?.uploadedItemIds ?? uploadedRef.current;
    sessionIdRef.current = sessionId;
    uploadedRef.current = uploadedItemIds;
    setPhase("grading");
    setError(null);
    setGradingJob(null);
    if (saved) {
      saveSession({ ...saved, phase: "grading", jobId: null, graded: null, savedAt: Date.now() });
    } else {
      persist({ phase: "grading" });
    }
    try {
      const { job_id } = await api.gradeSession(sessionId);
      saveSession({
        sessionId,
        mode: sessionModeRef.current,
        items: gradingItems,
        index: gradingIndex,
        phase: "grading",
        deadline: null,
        durationMs: null,
        promptShownAt: null,
        uploadedItemIds,
        jobId: job_id,
        graded: null,
        savedAt: Date.now(),
      });
      void runGrading(sessionId, job_id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function runGrading(sessionId: number, jobId: string | number) {
    setPhase("grading");
    setError(null);
    try {
      await pollJob(jobId, { timeoutMs: 15 * 60_000, onUpdate: setGradingJob });
      const gradedSession = await api.getSession(sessionId);
      setGraded(gradedSession);
      saveCompletedSession(gradedSession);
      setPhase("summary");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  function reconnectGrading() {
    void startGrading(loadSession() ?? undefined);
  }

  function quit() {
    clearSession();
    itemStartTokenRef.current += 1;
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
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {resumable ? (
          <div className="card hero-card stack center">
            <div className="spanish-kicker">Right where you left off</div>
            <p className="muted">
              {resumable.phase === "summary"
                ? "View your last session results?"
                : resumable.phase === "grading"
                  ? "Resume grading your session?"
                  : `Resume at item ${resumable.index + 1} of ${resumable.items.length}?`}
            </p>
            <button className="btn btn-primary btn-lg btn-block" onClick={resume} disabled={launching}>
              Resume
            </button>
            <button
              className="btn btn-ghost btn-block"
              disabled={launching}
              onClick={() => {
                if (launchInFlightRef.current) return;
                clearSession();
                setResumable(null);
              }}
            >
              Discard & start fresh
            </button>
          </div>
        ) : showModePicker ? (
          <div className="stack speak-mode-picker">
            <header className="page-intro">
              <span className="eyebrow">The speaking studio</span>
              <h1>A thought.<br />Your words. In Spanish.</h1>
              <p>Keep familiar phrases fresh, discover something new, or simply find your rhythm. Choose your practice.</p>
            </header>

            <div className="session-mode-grid">
              <a className="card session-mode-choice session-mode-fsrs" href="/session?mode=review">
                <div className="row between">
                  <span className="pill">FSRS ON</span>
                  <strong>{queueStats ? `${queueStats.due_count} due now` : "Due now"}</strong>
                </div>
                <div>
                  <h2>Due Review</h2>
                  <p className="muted">The right phrases, at the right time. Review what is due and set its next place in your schedule.</p>
                </div>
                <span className="btn btn-primary btn-block">Review due cards</span>
              </a>

              <a className="card session-mode-choice session-mode-learn" href="/session?mode=learn">
                <div className="row between">
                  <span className="pill">LEARN FIRST</span>
                  <strong>{queueStats ? `${queueStats.new_count} new` : "New cards"}</strong>
                </div>
                <div>
                  <h2>Learn New Cards</h2>
                  <p className="muted">Meaning first. Explore a phrase and hear how it sounds before introducing it to your review queue.</p>
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
                  <p className="muted">A little extra room to find your voice. Rotate through familiar cards without changing their due dates.</p>
                </div>
                <span className="btn btn-block">Practice without scheduling</span>
              </a>
            </div>
            <p className="session-mode-note"><strong>Your schedule stays intentional.</strong> Due Review and fresh Misses attempts update FSRS. Learn introduces cards; Free Practice leaves their due dates alone.</p>
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
                    ? "FSRS is ON. Recalling a missed card is a real review: every clear grade updates its next due date and schedule."
                    : "FSRS is ON. These are cards due now; every grade updates the next due date and the due queue."}
            </p>
            {sessionMode !== "learn" && (
              <p className="small faint" style={{ margin: 0 }}>
                Numbers can be spoken in English, Spanish, or digits. The numeric value and any stated currency must match.
              </p>
            )}
            {sessionMode === "practice" && (
              <PracticeTopicPicker
                idPrefix="spoken-practice-topic"
                selectedTopicId={selectedTopicId}
                onChange={choosePracticeTopic}
                onStatusChange={receiveTopicPickerStatus}
                disabled={launching}
              />
            )}
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
              disabled={launching || (sessionMode !== "learn" && !supported) || (sessionMode === "practice" && !topicSelectionReady)}
            >
              {launching
                ? "Opening session…"
                : sessionMode === "learn"
                ? "Start learning"
                : sessionMode === "review"
                  ? "Start due review · FSRS ON"
                  : sessionMode === "practice"
                    ? "Start free practice · FSRS OFF"
                    : sessionMode === "misses"
                      ? "Start misses workout · FSRS ON"
                      : "Start scheduled recall · FSRS ON"}
            </button>
            {sessionMode === "practice" && (
              <a className="practice-topic-modality-link small" href={writtenPracticeHref(selectedTopicId)}>
                Write this practice focus instead
              </a>
            )}
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
        noisyMode={noisyMode}
        serverResumable={serverResumable}
        onContinueServerSession={() => void continueServerSession()}
        onCorrectBatch={(phraseIds) => void correctBatch(phraseIds)}
        onPracticeAgain={() => {
          clearSession();
          setItems([]);
          setGraded(null);
          setResumable(null);
          setServerResumable(null);
          setError(null);
          setStatus("idle");
        }}
        correcting={launching}
        correctionError={error}
        onRefresh={(g) => {
          // An older inline retry may finish after a correction round starts.
          if (g.session_id !== sessionIdRef.current) return;
          setGraded(current => {
            const allowed = new Set((current?.items ?? g.items).map(item => item.phrase_id));
            const scoped = { ...g, items: g.items.filter(item => allowed.has(item.phrase_id)) };
            saveCompletedSession(scoped);
            return scoped;
          });
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
              onClick={reconnectGrading}
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

          <button
            className="btn btn-primary btn-lg btn-block"
            onClick={acknowledgeLearned}
            disabled={advancingLearn}
          >
            {advancingLearn
              ? "Preparing your test…"
              : index + 1 < items.length
                ? "I understand · next"
                : "I understand · test these now"}
          </button>
          <a className="btn btn-ghost btn-block" href="/session?mode=practice">
            Practice introduced phrases instead
          </a>
        </div>
      </div>
    );
  }

  // ── render: ARMING ──────────────────────────────────────────────────────────
  if (phase === "arming") {
    return (
      <div className="card stack center capture-wait" data-recording-pending>
        {error ? (
          <>
            <div className="alert alert-error" style={{ margin: 0 }}>{error}</div>
            <button className="btn btn-primary btn-block" onClick={() => void beginItem(index, items, null)}>
              Retry microphone
            </button>
          </>
        ) : (
          <>
            <div className="spinner" aria-hidden="true" />
            <h2>Finding your voice.</h2>
            <p className="muted" role="status">Preparing microphone… Your prompt and timer will start when it is ready.</p>
          </>
        )}
      </div>
    );
  }

  // ── render: UPLOADING (with retry on failure) ─────────────────────────────
  if (phase === "uploading") {
    return (
      <div className="card stack center capture-wait" data-recording-pending>
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
            <h2>Keeping your words.</h2>
            <p className="muted" role="status">Uploading… Keep this screen open while your recording is saved.</p>
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
  const sourceAudioUsable = Boolean(
    item?.source_audio_url && !failedSourceAudioItems.has(item.sprint_item_id),
  );
  const promptPresentation = item
    ? recallPromptPresentation(item, sessionMode, sourceAudioUsable)
    : null;
  const sourceAudioUnavailable = Boolean(promptPresentation?.sourceAudioUnavailable);
  const markSourceAudioFailed = () => {
    if (!item) return;
    setFailedSourceAudioItems((previous) => {
      if (previous.has(item.sprint_item_id)) return previous;
      const next = new Set(previous);
      next.add(item.sprint_item_id);
      return next;
    });
  };

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
        <div className="recall-cue">
          <p className="eyebrow">{promptPresentation?.cueKind === "audio_shadow" ? "Listen and shadow" : promptPresentation?.cueKind === "cloze" ? "Complete the thought" : "Say it in Spanish"}</p>
          <h2 style={{ margin: "2px 0 0" }}>{promptPresentation?.cue ?? ""}</h2>
          {item?.context_clue && (
            <p className="small faint" style={{ margin: 0 }}>{item.context_clue}</p>
          )}
        </div>
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
          {promptPresentation?.cueKind === "audio_shadow"
            ? "Listen, then shadow it calmly"
            : promptPresentation?.cueKind === "cloze"
              ? "Complete the phrase out loud"
              : danger ? "Finish your thought" : "Take a breath. You know more than you think."}
        </p>

        {sessionMode === "misses" && item?.feedback && (
          <div className="alert" style={{ margin: "8px 0 0", textAlign: "left" }}>
            <strong>Almost…</strong> {item.feedback}
          </div>
        )}

        {promptPresentation?.showSourceAudio && item?.source_audio_url && (
          <div style={{ width: "100%", textAlign: "left" }}>
            <AudioPlayer
              src={item.source_audio_url}
              label="Shadow audio"
              onError={markSourceAudioFailed}
            />
          </div>
        )}

        {sourceAudioUnavailable && item && (
          <div className="alert" style={{ margin: "8px 0 0", textAlign: "left" }}>
            <strong>Audio unavailable.</strong> Use the full English meaning shown above.
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
  noisyMode,
  onDone,
  disabled,
  onBusyChange,
}: {
  sessionId: number;
  item: SessionItem;
  noisyMode: boolean;
  onDone: (fresh: Session) => void;
  disabled: boolean;
  onBusyChange: (itemId: number, busy: boolean) => void;
}) {
  const [phase, setPhase] = useState<RetryPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const recRef = useRef<Recorder | null>(null);
  const targetRef = useRef<{ id: number; limit: number } | null>(null);
  const shownAtRef = useRef(0);
  const deadlineRef = useRef(0);
  const finishingRef = useRef(false);
  const beginningRef = useRef(false);
  const uploadInFlightRef = useRef(false);
  const uploadedTargetRef = useRef<number | null>(null);
  const gradedTargetRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const pendingRef = useRef<{ blob: Blob; mimeType: string; filename: string; answeredAtMs: number; timedOut: boolean } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recRef.current?.dispose();
      recRef.current = null;
    };
  }, []);
  useEffect(() => {
    onBusyChange(item.sprint_item_id, phase !== "idle");
    return () => onBusyChange(item.sprint_item_id, false);
  }, [phase, item.sprint_item_id, onBusyChange]);

  // countdown + auto-stop at the limit (recording stops automatically)
  useEffect(() => {
    if (phase !== "recording") return;
    const checkCapture = () => {
      if (finishingRef.current) return;
      const issue = recRef.current?.captureIssue;
      if (issue) {
        recRef.current?.dispose();
        recRef.current = null;
        setError(`${issue} This attempt won't be graded. Try again to reconnect the microphone.`);
        setPhase("error");
        return;
      }
      const left = Math.max(0, deadlineRef.current - Date.now());
      setSecs(Math.ceil(left / 1000));
      if (left <= 0) void finish(true);
    };
    const id = setInterval(checkCapture, 200);
    document.addEventListener("visibilitychange", checkCapture);
    window.addEventListener("pageshow", checkCapture);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", checkCapture);
      window.removeEventListener("pageshow", checkCapture);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function begin() {
    if (beginningRef.current || !mountedRef.current || (disabled && phase === "idle")) return;
    beginningRef.current = true;
    setError(null);
    setPhase("arming");
    try {
      // Warm the microphone from the learner's tap before the retry request.
      // iPhone Safari can reject a first getUserMedia call after a network await
      // because the original user activation is no longer available.
      if (!recRef.current) recRef.current = new Recorder();
      const recorder = recRef.current;
      await recorder.init();
      if (!mountedRef.current || recRef.current !== recorder) return;
      const retry = await api.retryItem(sessionId, item.sprint_item_id);
      if (!mountedRef.current || recRef.current !== recorder) return;
      // Retry/re-record receives the same backend-derived limit as the attempt.
      const limit = recallSecondsFromServer(retry.time_limit_seconds);
      targetRef.current = { id: retry.sprint_item_id, limit };
      await recorder.start(ENCODER_PREROLL_MS);
      if (!mountedRef.current || recRef.current !== recorder) return;
      finishingRef.current = false;
      pendingRef.current = null;
      uploadedTargetRef.current = null;
      gradedTargetRef.current = null;
      shownAtRef.current = Date.now();
      deadlineRef.current = shownAtRef.current + limit * 1000;
      setSecs(limit);
      setPhase("recording");
    } catch (err) {
      if (!mountedRef.current) return;
      recRef.current?.dispose();
      recRef.current = null;
      setError(err instanceof ApiError ? err.message : `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("error");
    } finally {
      beginningRef.current = false;
    }
  }

  async function finish(timedOut: boolean) {
    if (finishingRef.current || !mountedRef.current || !recRef.current) return;
    finishingRef.current = true;
    const recorder = recRef.current;
    setPhase("uploading");
    const answeredAtMs = Date.now();
    try {
      const rec = await recorder.stop(ENCODER_POSTROLL_MS);
      if (!mountedRef.current || recRef.current !== recorder) return;
      if (!rec || rec.blob.size === 0) throw new Error("No audio was captured — try again.");
      if (rec.interrupted) throw new Error("Microphone was interrupted. This attempt won't be graded — try again.");
      pendingRef.current = { blob: rec.blob, mimeType: rec.mimeType, filename: rec.filename, answeredAtMs, timedOut };
      await uploadAndGrade();
    } catch (err) {
      if (!mountedRef.current) return;
      recRef.current?.dispose();
      recRef.current = null;
      setError(err instanceof ApiError ? err.message : String(err));
      setPhase("error");
      finishingRef.current = false;
    }
  }

  // Retry only the unfinished stage. Once accepted, audio must never be uploaded
  // again because grading/polling/refresh failed. Grade enqueue is idempotent.
  async function uploadAndGrade() {
    const pending = pendingRef.current;
    const target = targetRef.current;
    if (!mountedRef.current || uploadInFlightRef.current || !target || (!pending && uploadedTargetRef.current !== target.id)) return;
    uploadInFlightRef.current = true;
    try {
      setError(null);
      if (uploadedTargetRef.current !== target.id) {
        if (!pending) return;
        setPhase("uploading");
        await api.uploadRecording(sessionId, target.id, pending.blob, {
          mimeType: pending.mimeType,
          promptShownAt: new Date(shownAtRef.current).toISOString(),
          answeredAt: new Date(pending.answeredAtMs).toISOString(),
          responseSeconds: Math.round(((pending.answeredAtMs - shownAtRef.current) / 1000) * 10) / 10,
          timedOut: pending.timedOut,
          filename: pending.filename,
          noisyMode,
        });
        uploadedTargetRef.current = target.id;
        pendingRef.current = null;
        recRef.current?.dispose();
        recRef.current = null;
      }
      if (!mountedRef.current) return;
      setPhase("grading");
      if (gradedTargetRef.current !== target.id) {
        const { job_id } = await api.gradeItem(sessionId, target.id);
        if (!mountedRef.current) return;
        await pollJob(job_id);
        gradedTargetRef.current = target.id;
      }
      if (!mountedRef.current) return;
      const fresh = await api.getSession(sessionId);
      if (mountedRef.current) onDone(fresh);
    } catch (err) {
      if (!mountedRef.current) return;
      if (isIncompleteRecordingError(err) && uploadedTargetRef.current !== target.id) {
        pendingRef.current = null;
        recRef.current?.dispose();
        recRef.current = null;
        setError("The browser captured only part of your audio. This attempt won't be graded — try again to reconnect the microphone.");
      } else {
        setError(err instanceof ApiError ? err.message : String(err));
      }
      setPhase("error");
      finishingRef.current = false;
    } finally {
      uploadInFlightRef.current = false;
    }
  }

  if (phase === "idle") {
    return (
      <button className="btn btn-primary btn-block" disabled={disabled} onClick={() => void begin()}>
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
      {pendingRef.current || uploadedTargetRef.current !== null ? (
        <button className="btn btn-primary btn-block" onClick={() => void uploadAndGrade()}>
          {pendingRef.current ? "Retry upload" : "Retry grading"}
        </button>
      ) : (
        <button className="btn btn-block" disabled={disabled} onClick={() => void begin()}>
          Try again
        </button>
      )}
    </div>
  );
}

// ── Transcript feedback (audit-only; never regrades or touches FSRS) ─────────
function TranscriptFeedback({ sessionId, item }: { sessionId: number; item: SessionItem }) {
  const [status, setStatus] = useState<"accurate" | "corrected" | null>(item.asr_feedback_status ?? null);
  const [corrected, setCorrected] = useState(item.asr_corrected_transcript ?? item.user_transcript_segment ?? "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRawTranscript = Boolean(item.user_transcript_segment?.trim());

  useEffect(() => {
    setStatus(item.asr_feedback_status ?? null);
    setCorrected(item.asr_corrected_transcript ?? item.user_transcript_segment ?? "");
  }, [item.asr_corrected_transcript, item.asr_feedback_status, item.user_transcript_segment]);

  async function save(nextStatus: "accurate" | "corrected") {
    const verbatim = corrected.trim();
    if (nextStatus === "corrected" && !verbatim) {
      setError("Enter what you actually said.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveAsrFeedback(sessionId, item.sprint_item_id, {
        status: nextStatus,
        ...(nextStatus === "corrected" ? { corrected_transcript: verbatim } : {}),
      });
      setStatus(result.status);
      setCorrected(result.corrected_transcript ?? item.user_transcript_segment ?? "");
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small faint">Help improve speech capture · does not change this grade</div>
      {status && !editing ? (
        <div className="alert alert-ok" style={{ margin: 0 }}>
          {status === "accurate"
            ? "Transcript marked accurate."
            : <>Verbatim correction saved: <strong>{corrected}</strong></>}
        </div>
      ) : null}
      {editing ? (
        <div className="stack" style={{ gap: 8 }}>
          <textarea
            aria-label="What you actually said"
            rows={2}
            value={corrected}
            disabled={saving}
            onChange={(event) => setCorrected(event.target.value)}
            placeholder="Type exactly what you actually said"
          />
          <div className="btn-row">
            <button className="btn btn-primary btn-small" type="button" disabled={saving} onClick={() => void save("corrected")}>
              {saving ? "Saving…" : "Save verbatim correction"}
            </button>
            <button className="btn btn-ghost btn-small" type="button" disabled={saving} onClick={() => { setEditing(false); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="btn-row">
          {hasRawTranscript ? (
            <button className="btn btn-small" type="button" disabled={saving} onClick={() => void save("accurate")}>
              {saving ? "Saving…" : "Accurate transcript"}
            </button>
          ) : null}
          <button className="btn btn-ghost btn-small" type="button" disabled={saving} onClick={() => { setEditing(true); setError(null); }}>
            Fix transcript
          </button>
        </div>
      )}
      {error && <div className="alert alert-error" style={{ margin: 0 }}>{error}</div>}
    </div>
  );
}

// ── Summary view ────────────────────────────────────────────────────────────
function Summary({
  graded,
  recordings,
  noisyMode,
  serverResumable,
  onContinueServerSession,
  onCorrectBatch,
  onPracticeAgain,
  correcting,
  correctionError,
  onRefresh,
}: {
  graded: Session | null;
  recordings: Map<number, string>;
  noisyMode: boolean;
  serverResumable?: ResumableSessionSummary | null;
  onContinueServerSession?: () => void;
  onCorrectBatch: (phraseIds: number[]) => void;
  onPracticeAgain: () => void;
  correcting: boolean;
  correctionError: string | null;
  onRefresh?: (fresh: Session) => void;
}) {
  const [deletedPhraseIds, setDeletedPhraseIds] = useState<Set<number>>(() => new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingPhraseId, setDeletingPhraseId] = useState<number | null>(null);
  const [busyRetry, setBusyRetry] = useState<number | null>(null);
  const onRetryBusy = useCallback((itemId: number, busy: boolean) => {
    setBusyRetry(current => busy ? itemId : current === itemId ? null : current);
  }, []);
  const summary = graded?.summary;
  const items = (graded?.items ?? []).filter((item) => !deletedPhraseIds.has(item.phrase_id));
  const mode = graded?.mode;
  const misses = correctionPhraseIds(items);
  const pendingRetry = latestSessionItems(items).some(item => item.result === "pending");
  const fsrsAppliedCount = items.filter((it) => it.fsrs_applied).length;
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
      if (graded) onRefresh?.({ ...graded, items: graded.items.filter((row) => row.phrase_id !== item.phrase_id) });
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
        <p className="muted">{serverResumable
          ? `${serverResumable.remaining_items} card${serverResumable.remaining_items === 1 ? " is" : "s are"} waiting in an unfinished ${serverResumable.mode === "review" ? "Due Review" : "session"}.`
          : body}</p>
        {serverResumable && onContinueServerSession && (
          <button className="btn btn-primary btn-lg btn-block" onClick={onContinueServerSession}>
            Continue unfinished {serverResumable.mode === "review" ? "review" : "session"} · {serverResumable.remaining_items} remaining
          </button>
        )}
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
        {fsrsAppliedCount > 0 && (
          <div className="alert alert-ok" style={{ margin: 0, width: "100%" }}>
            <strong>FSRS updated:</strong> {fsrsAppliedCount} first-attempt grade{fsrsAppliedCount === 1 ? "" : "s"} changed scheduling.
          </div>
        )}
        {graded?.affects_fsrs && fsrsAppliedCount === 0 && graded?.mode !== "learn" && (
          <div className="alert" style={{ margin: 0, width: "100%" }}>
            <strong>Schedule unchanged:</strong> no attempt shown here produced an FSRS review update.
          </div>
        )}
        {graded?.mode === "practice" && (
          <div className="alert" style={{ margin: 0, width: "100%" }}>
            <strong>FSRS OFF:</strong> Free Practice feedback was saved, but due dates and the due count were not changed.
          </div>
        )}
        {graded?.mode === "misses" && (
          <p className="muted">Misses workout complete. Passed cards leave the Misses queue; partial and failed cards remain.</p>
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
          <h3 style={{ margin: 0 }}>Corrections · this batch only</h3>
          <p className="muted">Repeat only the {misses.length} card{misses.length === 1 ? "" : "s"} needing correction from this batch. No other queue cards are added; FSRS stays off.</p>
          <button className="btn btn-primary btn-block" type="button" disabled={correcting || deletingPhraseId !== null || busyRetry !== null || pendingRetry} onClick={() => onCorrectBatch(misses)}>
            {correcting ? "Preparing this batch…" : "Correct this batch"}
          </button>
        </div>
      )}

      {correctionError && <div className="alert alert-error" role="alert">{correctionError}</div>}
      {pendingRetry && <div className="alert">An unfinished re-recording is still in this batch. Use Re-record on its unclear card before starting corrections.</div>}
      {deleteError && <div className="alert alert-error" role="alert">{deleteError}</div>}

      {items.map((it) => {
        const userUrl = it.recording_audio_url || recordings.get(it.sprint_item_id);
        const unclear = it.error_type === "transcription_unclear";
        const latest = latestSessionItems(items).find(item => item.phrase_id === it.phrase_id);
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
                {it.fsrs_applied && it.fsrs_rating && !unclear ? `FSRS ${it.fsrs_rating} · schedule updated` : ""}
                {!it.fsrs_applied && !unclear && it.fsrs_rating ? "schedule unchanged" : ""}
                {!it.fsrs_applied && !graded?.affects_fsrs && !unclear && !it.fsrs_rating ? "FSRS off · schedule unchanged" : ""}
                {unclear ? "not counted against you" : ""}
                {it.timed_out ? " · ⏱ timed out" : it.over_time ? " · ⏱ over time" : ""}
              </span>
            </div>

            <div>
              <div className="small faint">Answer</div>
              <div style={{ fontWeight: 600 }}>{it.spanish || "Answer hidden until grading completes"}</div>
              <div className="small faint">{it.english}</div>
            </div>

            {it.recording_id != null && (
              <div>
                <div className="small faint">You said</div>
                <div style={{ color: "var(--text-dim)" }}>
                  {it.user_transcript_segment || (
                    <em className="faint">(no transcript)</em>
                  )}
                </div>
              </div>
            )}

            {it.recording_id != null && graded?.session_id ? (
              <TranscriptFeedback sessionId={graded.session_id} item={it} />
            ) : null}

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

            {it.source_audio_url && <AudioPlayer src={it.source_audio_url} label="Native audio" />}
            {userUrl && <AudioPlayer src={userUrl} label="Your recording" />}

            {unclear && (latest?.sprint_item_id === it.sprint_item_id || latest?.result === "pending") && graded?.session_id && onRefresh && (
              <RetryRecorder
                sessionId={graded.session_id}
                item={it}
                noisyMode={noisyMode}
                onDone={onRefresh}
                disabled={correcting || (busyRetry !== null && busyRetry !== it.sprint_item_id)}
                onBusyChange={onRetryBusy}
              />
            )}

            <button
              className="btn btn-small btn-danger"
              type="button"
              disabled={correcting || deletingPhraseId !== null}
              onClick={() => void deleteCard(it)}
            >
              {deletingPhraseId === it.phrase_id ? "Deleting…" : "Delete malformed card"}
            </button>
          </div>
        );
      })}

      <div className="btn-row">
        {graded?.mode === "practice" && (
          <button className={`btn ${misses.length ? "" : "btn-primary"}`} type="button" onClick={onPracticeAgain}>
            Choose or repeat a practice topic
          </button>
        )}
        <a className={`btn ${misses.length || graded?.mode === "practice" ? "" : "btn-primary"}`} href="/session?mode=learn">Learn next batch</a>
        <a className="btn" href="/">Home</a>
      </div>
    </div>
  );
}
