import {
  DEFAULT_PREFERENCES,
  safeAudioUrl,
  type ShadowPreferences,
} from "./shadowing.ts";

export type ShadowPhase =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "gap"
  | "gap-paused"
  | "error";

export interface ShadowSnapshot {
  phase: ShadowPhase;
  position: number;
  duration: number;
  error: string | null;
}

export interface ShadowPlayerOptions {
  createAudio: () => HTMLAudioElement;
  onChange: (snapshot: ShadowSnapshot) => void;
  onComplete: () => void;
  loadTimeoutMs?: number;
}

type MediaWithPitchControls = HTMLAudioElement & {
  mozPreservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
};

type AudioListeners = Array<[keyof HTMLMediaElementEventMap, EventListener]>;

const MAX_LOAD_TIMEOUT_MS = 15_000;
const DEFAULT_LOAD_TIMEOUT_MS = 10_000;
let activeOwner: ShadowPlayer | null = null;

function finitePosition(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function finiteDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safePause(audio: HTMLAudioElement): void {
  try {
    audio.pause();
  } catch {
    // A detached or failed media element is already effectively stopped.
  }
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const message = error.message.trim();
  return message ? ` (${message})` : "";
}

function normalizedTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LOAD_TIMEOUT_MS;
  return Math.min(MAX_LOAD_TIMEOUT_MS, Math.max(1, Math.round(value)));
}

function normalizedPreferences(
  value: ShadowPreferences,
  previous: ShadowPreferences,
): ShadowPreferences {
  const rate = typeof value?.rate === "number"
    && Number.isFinite(value.rate)
    && value.rate >= 0.25
    && value.rate <= 4
    ? value.rate
    : previous.rate;
  const gapSeconds = typeof value?.gapSeconds === "number"
    && Number.isFinite(value.gapSeconds)
    && value.gapSeconds >= 0
    && value.gapSeconds <= 60
    ? value.gapSeconds
    : previous.gapSeconds;
  const mode = value?.mode === "repeat" || value?.mode === "along"
    ? value.mode
    : previous.mode;
  const showSpanish = typeof value?.showSpanish === "boolean"
    ? value.showSpanish
    : previous.showSpanish;
  return { rate, gapSeconds, mode, showSpanish };
}

/**
 * Owns one detached media element and fences every asynchronous callback by
 * source and play-attempt generation. A module-level owner prevents separate
 * mounted players from producing overlapping audio.
 */
export class ShadowPlayer {
  private readonly createAudio: () => HTMLAudioElement;
  private readonly onChange: (snapshot: ShadowSnapshot) => void;
  private readonly onComplete: () => void;
  private readonly loadTimeoutMs: number;
  private state: ShadowSnapshot = {
    phase: "idle",
    position: 0,
    duration: 0,
    error: null,
  };
  private preferences: ShadowPreferences = { ...DEFAULT_PREFERENCES };
  private selectedUrl = "";
  private audio: HTMLAudioElement | null = null;
  private listeners: AudioListeners = [];
  private sourceGeneration = 0;
  private playAttempt = 0;
  private playbackActive = false;
  private endedHandled = true;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private gapRemainingMs = 0;
  private gapStartedAt: number | null = null;
  private disposed = false;

  constructor(options: ShadowPlayerOptions) {
    this.createAudio = options.createAudio;
    this.onChange = options.onChange;
    this.onComplete = options.onComplete;
    this.loadTimeoutMs = normalizedTimeout(options.loadTimeoutMs);
  }

  get snapshot(): ShadowSnapshot {
    return { ...this.state };
  }

  select(url: string): void {
    if (this.disposed) return;
    this.cancelTimersAndAttempt();
    this.releaseOwnership();
    this.detachAudio();
    this.selectedUrl = safeAudioUrl(url);

    if (!this.selectedUrl) {
      this.update({
        phase: "error",
        position: 0,
        duration: 0,
        error: "Audio is unavailable for this clip. Choose another clip.",
      });
      return;
    }

    if (!this.installAudio()) return;
    this.update({ phase: "paused", position: 0, duration: 0, error: null });
  }

  start(): void {
    if (this.disposed) return;
    if (!this.selectedUrl) {
      this.failCurrent("Audio is unavailable for this clip. Choose another clip.");
      return;
    }
    if (this.state.phase === "playing" || this.state.phase === "loading" || this.state.phase === "gap") {
      return;
    }

    this.claimOwnership();
    if (activeOwner !== this || this.disposed) return;
    if (this.state.phase === "gap-paused") {
      this.update({ ...this.state, phase: "gap", error: null });
      if ((this.state as ShadowSnapshot).phase !== "gap" || activeOwner !== this) return;
      if (this.gapRemainingMs <= 0) this.startAutoLoop();
      else this.scheduleGap(this.gapRemainingMs);
      return;
    }

    if (this.state.phase === "error" && this.audio) this.detachAudio();
    if (!this.audio && !this.installAudio()) return;
    this.beginPlay(false);
  }

  pause(): void {
    if (this.disposed) return;
    if (this.state.phase === "gap") {
      if (this.gapStartedAt !== null) {
        this.gapRemainingMs = Math.max(
          0,
          this.gapRemainingMs - (Date.now() - this.gapStartedAt),
        );
      }
      this.clearGapTimer();
      this.gapStartedAt = null;
      this.releaseOwnership();
      this.update({ ...this.state, phase: "gap-paused", error: null });
      return;
    }
    if (this.state.phase !== "loading" && this.state.phase !== "playing") return;

    ++this.playAttempt;
    this.playbackActive = false;
    this.endedHandled = true;
    this.clearLoadTimer();
    safePause(this.audio as HTMLAudioElement);
    this.releaseOwnership();
    this.update({
      phase: "paused",
      position: this.readPosition(),
      duration: this.readDuration(),
      error: null,
    });
  }

  replay(): void {
    if (this.disposed) return;
    if (!this.selectedUrl) {
      this.failCurrent("Audio is unavailable for this clip. Choose another clip.");
      return;
    }
    this.claimOwnership();
    if (activeOwner !== this || this.disposed) return;
    this.clearGapTimer();
    this.gapRemainingMs = 0;
    this.gapStartedAt = null;
    if (this.state.phase === "error" && this.audio) this.detachAudio();
    if (!this.audio && !this.installAudio()) return;
    this.beginPlay(true);
  }

  configure(preferences: ShadowPreferences): void {
    if (this.disposed) return;
    const before = this.preferences;
    const next = normalizedPreferences(preferences, before);
    this.preferences = next;
    this.applyPlaybackRate();

    const gapChanged = before.mode !== next.mode || before.gapSeconds !== next.gapSeconds;
    if (!gapChanged || (this.state.phase !== "gap" && this.state.phase !== "gap-paused")) return;

    this.clearGapTimer();
    this.gapStartedAt = null;
    this.gapRemainingMs = this.fullGapMs();
    if (this.state.phase === "gap-paused") {
      this.update({ ...this.state, phase: "gap-paused", error: null });
      return;
    }

    this.update({ ...this.state, phase: "gap", error: null });
    if (this.state.phase !== "gap" || activeOwner !== this) return;
    if (this.gapRemainingMs <= 0) this.startAutoLoop();
    else this.scheduleGap(this.gapRemainingMs);
  }

  stop(): void {
    if (this.disposed) return;
    this.cancelTimersAndAttempt();
    this.releaseOwnership();
    this.detachAudio();
    this.update({ phase: "idle", position: 0, duration: 0, error: null });
  }

  dispose(): void {
    if (this.disposed) return;
    // Latch disposal before notifying so a synchronous onChange callback cannot
    // resurrect media while teardown is in progress.
    this.disposed = true;
    this.cancelTimersAndAttempt();
    this.releaseOwnership();
    this.detachAudio();
    this.selectedUrl = "";
    this.update({ phase: "idle", position: 0, duration: 0, error: null });
  }

  private update(next: ShadowSnapshot): void {
    this.state = {
      phase: next.phase,
      position: finitePosition(next.position),
      duration: finiteDuration(next.duration),
      error: next.error,
    };
    try {
      this.onChange({ ...this.state });
    } catch {
      // Consumer rendering errors must not leave media/timers unfenced.
    }
  }

  private readPosition(audio: HTMLAudioElement | null = this.audio): number {
    try {
      return finitePosition(audio?.currentTime ?? 0);
    } catch {
      return 0;
    }
  }

  private readDuration(audio: HTMLAudioElement | null = this.audio): number {
    try {
      return finiteDuration(audio?.duration ?? 0);
    } catch {
      return 0;
    }
  }

  private claimOwnership(): void {
    if (activeOwner === this) return;
    const previous = activeOwner;
    activeOwner = this;
    previous?.stop();
  }

  private releaseOwnership(): void {
    if (activeOwner === this) activeOwner = null;
  }

  private clearLoadTimer(): void {
    if (this.loadTimer !== null) clearTimeout(this.loadTimer);
    this.loadTimer = null;
  }

  private clearGapTimer(): void {
    if (this.gapTimer !== null) clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }

  private cancelTimersAndAttempt(): void {
    ++this.playAttempt;
    this.playbackActive = false;
    this.endedHandled = true;
    this.clearLoadTimer();
    this.clearGapTimer();
    this.gapRemainingMs = 0;
    this.gapStartedAt = null;
  }

  private detachAudio(): void {
    const audio = this.audio;
    ++this.sourceGeneration;
    this.audio = null;
    const listeners = this.listeners;
    this.listeners = [];
    if (!audio) return;

    for (const [type, listener] of listeners) {
      try {
        audio.removeEventListener(type, listener);
      } catch {
        // Continue detaching the rest of the element.
      }
    }
    safePause(audio);
    try {
      audio.removeAttribute("src");
    } catch {
      try {
        audio.src = "";
      } catch {
        // The old element is no longer referenced even if src is read-only.
      }
    }
    try {
      audio.load();
    } catch {
      // load() is only used to release the old resource promptly.
    }
  }

  private installAudio(): boolean {
    const generation = ++this.sourceGeneration;
    let audio: HTMLAudioElement;
    try {
      audio = this.createAudio();
      if (!audio || typeof audio.addEventListener !== "function") {
        throw new Error("the browser did not create a media element");
      }
    } catch (error) {
      this.failCurrent(`Audio could not be prepared. Choose another clip${errorDetail(error)}.`);
      return false;
    }

    this.audio = audio;
    this.listeners = [];
    const listen = (type: keyof HTMLMediaElementEventMap, listener: EventListener) => {
      audio.addEventListener(type, listener);
      this.listeners.push([type, listener]);
    };
    const current = () => !this.disposed
      && this.audio === audio
      && this.sourceGeneration === generation;

    listen("loadedmetadata", () => {
      if (!current()) return;
      this.update({
        ...this.state,
        position: this.readPosition(audio),
        duration: this.readDuration(audio),
      });
    });
    listen("durationchange", () => {
      if (!current()) return;
      this.update({
        ...this.state,
        position: this.readPosition(audio),
        duration: this.readDuration(audio),
      });
    });
    listen("timeupdate", () => {
      if (!current()) return;
      this.update({
        ...this.state,
        position: this.readPosition(audio),
        duration: this.readDuration(audio),
      });
    });
    listen("playing", () => {
      if (!current()) return;
      if (!this.playbackActive || (this.state.phase !== "loading" && this.state.phase !== "playing")) {
        safePause(audio);
        return;
      }
      this.clearLoadTimer();
      this.update({
        phase: "playing",
        position: this.readPosition(audio),
        duration: this.readDuration(audio),
        error: null,
      });
    });
    listen("pause", () => {
      if (!current() || !this.playbackActive) return;
      // Natural completion may dispatch pause immediately before ended.
      if (audio.ended) return;
      ++this.playAttempt;
      this.playbackActive = false;
      this.endedHandled = true;
      this.clearLoadTimer();
      this.releaseOwnership();
      this.update({
        phase: "paused",
        position: this.readPosition(audio),
        duration: this.readDuration(audio),
        error: null,
      });
    });
    listen("ended", () => {
      if (current()) this.handleEnded(audio, generation);
    });
    listen("error", () => {
      if (!current()) return;
      this.failCurrent("Audio could not be loaded. Tap Retry audio or choose another clip.");
    });

    try {
      audio.preload = "auto";
      audio.src = this.selectedUrl;
      this.applyPlaybackRate(audio);
      audio.load();
      return true;
    } catch (error) {
      this.detachAudio();
      this.failCurrent(`Audio could not be prepared. Choose another clip${errorDetail(error)}.`);
      return false;
    }
  }

  private applyPlaybackRate(audio: HTMLAudioElement | null = this.audio): void {
    if (!audio) return;
    try {
      audio.playbackRate = this.preferences.rate;
    } catch {
      // A later play rejection/timeout is more useful than failing settings UI.
    }
    const pitchAudio = audio as MediaWithPitchControls;
    try {
      pitchAudio.preservesPitch = true;
      if ("webkitPreservesPitch" in pitchAudio) pitchAudio.webkitPreservesPitch = true;
      if ("mozPreservesPitch" in pitchAudio) pitchAudio.mozPreservesPitch = true;
    } catch {
      // Pitch preservation is best-effort on older engines.
    }
  }

  private beginPlay(fromBeginning: boolean): void {
    const audio = this.audio;
    if (!audio) {
      this.failCurrent("Audio is unavailable for this clip. Choose another clip.");
      return;
    }

    this.clearGapTimer();
    this.gapRemainingMs = 0;
    this.gapStartedAt = null;
    if (fromBeginning) {
      try {
        audio.currentTime = 0;
      } catch (error) {
        this.failCurrent(`Audio could not be replayed. Tap Retry audio${errorDetail(error)}.`);
        return;
      }
    }

    const generation = this.sourceGeneration;
    const attempt = ++this.playAttempt;
    this.endedHandled = false;
    this.playbackActive = true;
    this.applyPlaybackRate(audio);
    this.update({
      phase: "loading",
      position: this.readPosition(audio),
      duration: this.readDuration(audio),
      error: null,
    });
    // onChange is allowed to synchronously pause/stop. Do not issue play after
    // that cancellation just because this method began from an active gesture.
    if (!this.isCurrentAttempt(audio, generation, attempt)) return;
    this.clearLoadTimer();
    this.loadTimer = setTimeout(() => {
      if (!this.isCurrentAttempt(audio, generation, attempt)) return;
      this.failAttempt(
        audio,
        generation,
        attempt,
        "Audio took too long to start. Check your connection, then tap Retry audio.",
      );
    }, this.loadTimeoutMs);

    let result: Promise<void> | undefined;
    try {
      result = audio.play();
    } catch (error) {
      this.failAttempt(
        audio,
        generation,
        attempt,
        `Audio could not start. Tap Retry audio or choose another clip${errorDetail(error)}.`,
      );
      return;
    }

    if (!result || typeof result.then !== "function") {
      if (this.isCurrentAttempt(audio, generation, attempt)) {
        this.clearLoadTimer();
        this.update({
          phase: "playing",
          position: this.readPosition(audio),
          duration: this.readDuration(audio),
          error: null,
        });
      }
      return;
    }

    void Promise.resolve(result).then(
      () => {
        if (!this.isCurrentAttempt(audio, generation, attempt)) {
          // Do not pause a newer play attempt on the same element. Cancellation
          // already paused this request; detached/inactive elements are safe to
          // stop again if a browser resolves the old promise late.
          if (
            this.audio !== audio
            || !this.playbackActive
            || (this.state.phase !== "loading" && this.state.phase !== "playing")
          ) {
            safePause(audio);
          }
          return;
        }
        this.clearLoadTimer();
        this.update({
          phase: "playing",
          position: this.readPosition(audio),
          duration: this.readDuration(audio),
          error: null,
        });
      },
      (error) => {
        if (!this.isCurrentAttempt(audio, generation, attempt)) return;
        this.failAttempt(
          audio,
          generation,
          attempt,
          `Audio could not start. Tap Retry audio or choose another clip${errorDetail(error)}.`,
        );
      },
    );
  }

  private isCurrentAttempt(
    audio: HTMLAudioElement,
    generation: number,
    attempt: number,
  ): boolean {
    return !this.disposed
      && this.audio === audio
      && this.sourceGeneration === generation
      && this.playAttempt === attempt
      && this.playbackActive;
  }

  private failAttempt(
    audio: HTMLAudioElement,
    generation: number,
    attempt: number,
    message: string,
  ): void {
    if (!this.isCurrentAttempt(audio, generation, attempt)) return;
    this.failCurrent(message);
  }

  private failCurrent(message: string): void {
    ++this.playAttempt;
    this.playbackActive = false;
    this.endedHandled = true;
    this.clearLoadTimer();
    this.clearGapTimer();
    this.gapRemainingMs = 0;
    this.gapStartedAt = null;
    if (this.audio) safePause(this.audio);
    this.releaseOwnership();
    this.update({
      phase: "error",
      position: this.readPosition(),
      duration: this.readDuration(),
      error: message,
    });
  }

  private handleEnded(audio: HTMLAudioElement, generation: number): void {
    if (
      this.disposed
      || this.audio !== audio
      || this.sourceGeneration !== generation
      || !this.playbackActive
      || this.endedHandled
      || (typeof audio.ended === "boolean" && !audio.ended)
    ) {
      return;
    }

    this.endedHandled = true;
    this.playbackActive = false;
    ++this.playAttempt;
    this.clearLoadTimer();
    this.gapRemainingMs = this.fullGapMs();
    this.gapStartedAt = null;
    this.update({
      phase: "gap",
      position: this.readPosition(audio),
      duration: this.readDuration(audio),
      error: null,
    });

    try {
      this.onComplete();
    } catch {
      // Counting/rendering failures cannot create a second completion or loop.
    }

    if (
      this.disposed
      || this.audio !== audio
      || this.sourceGeneration !== generation
      || activeOwner !== this
      || this.state.phase !== "gap"
    ) {
      return;
    }
    if (this.gapRemainingMs <= 0) this.startAutoLoop();
    else this.scheduleGap(this.gapRemainingMs);
  }

  private fullGapMs(): number {
    return this.preferences.mode === "repeat"
      ? Math.max(0, Math.round(this.preferences.gapSeconds * 1000))
      : 0;
  }

  private scheduleGap(delayMs: number): void {
    this.clearGapTimer();
    this.gapRemainingMs = Math.max(0, delayMs);
    this.gapStartedAt = Date.now();
    if (this.gapRemainingMs <= 0) {
      this.startAutoLoop();
      return;
    }
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      if (this.disposed || this.state.phase !== "gap" || activeOwner !== this) return;
      this.gapRemainingMs = 0;
      this.gapStartedAt = null;
      this.startAutoLoop();
    }, this.gapRemainingMs);
  }

  private startAutoLoop(): void {
    if (this.disposed || this.state.phase !== "gap" || activeOwner !== this || !this.audio) return;
    this.clearGapTimer();
    this.gapRemainingMs = 0;
    this.gapStartedAt = null;
    this.beginPlay(true);
  }
}
