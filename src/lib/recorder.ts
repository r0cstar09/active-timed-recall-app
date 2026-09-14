/**
 * MediaRecorder helper tuned for iPhone Safari.
 *
 * Safari (iOS 14.3+) supports MediaRecorder but typically only produces
 * `audio/mp4` (AAC), NOT `audio/webm`. We probe `isTypeSupported` and pick the
 * best available container so uploads work across Safari, Chrome and Firefox.
 */

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  /** Suggested filename (extension matches the container). */
  filename: string;
  durationMs: number;
  /** Capture ended before the learner submitted; never grade as a full answer. */
  interrupted: boolean;
}

/**
 * Let the browser encoder settle before the prompt appears, then retain a
 * short tail after the learner submits. These margins are deliberately below
 * the server's two-second MediaRecorder grace and do not change answer timing.
 */
export const ENCODER_PREROLL_MS = 250;
export const ENCODER_POSTROLL_MS = 250;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const PREFERRED_TYPES = [
  "audio/mp4", // Safari / iOS
  "audio/webm;codecs=opus", // Chrome / Firefox
  "audio/webm",
  "video/mp4", // some Safari builds only report this for AAC capture
  "audio/wav",
];

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of PREFERRED_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return ""; // let the browser choose its default
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "audio";
}

export class Recorder {
  private stream: MediaStream | null = null;
  private streamRequestGeneration = 0;
  private recorder: MediaRecorder | null = null;
  private stopPromise: Promise<RecordingResult> | null = null;
  private chunks: BlobPart[] = [];
  private startTime = 0;
  private mimeType = "";
  private captureIssueValue: string | null = null;
  private monitoredRecorder: MediaRecorder | null = null;
  private removeCaptureMonitors: (() => void) | null = null;
  private finalized = new WeakSet<MediaRecorder>();
  private submitted = new WeakSet<MediaRecorder>();
  private interrupted = new WeakSet<MediaRecorder>();

  private streamHealthIssue(stream: MediaStream | null = this.stream): string | null {
    const tracks = stream?.getAudioTracks() ?? [];
    if (tracks.length === 0) return "Microphone audio track is missing. Please record again.";
    if (tracks.some((track) => track.readyState !== "live")) {
      return "Microphone track ended. Please record again.";
    }
    if (tracks.some((track) => !track.enabled)) {
      return "Microphone track is disabled. Please record again.";
    }
    if (tracks.some((track) => track.muted)) {
      return "Microphone track is muted. Please record again.";
    }
    return null;
  }

  private invalidateStream(stream: MediaStream | null = this.stream): void {
    if (!stream || this.stream !== stream) return;
    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    });
  }

  private latchCaptureIssue(rec: MediaRecorder, issue: string): void {
    if (this.recorder !== rec || this.submitted.has(rec) || this.captureIssueValue) return;
    this.captureIssueValue = issue;
    this.interrupted.add(rec);
    // Do not let a subsequent attempt reuse a route/device that just failed.
    // Keep the stream object long enough for stop() to preserve queued chunks;
    // init()/start() will see its ended tracks and reacquire the microphone.
    this.invalidateStream(rec.stream);
  }

  private clearCaptureMonitors(rec?: MediaRecorder): void {
    if (rec && this.monitoredRecorder !== rec) return;
    this.removeCaptureMonitors?.();
    this.removeCaptureMonitors = null;
    this.monitoredRecorder = null;
  }

  private monitorCapture(rec: MediaRecorder): void {
    this.clearCaptureMonitors();
    const stream = rec.stream;
    const tracks = stream.getAudioTracks();
    const onStop = () => {
      this.latchCaptureIssue(rec, "Audio capture stopped unexpectedly. Please record again.");
    };
    const onError = () => {
      this.latchCaptureIssue(rec, "Audio recorder failed during capture. Please record again.");
    };
    const onPause = () => {
      this.latchCaptureIssue(rec, "Audio capture was paused. Please record again.");
    };
    const onEnded = () => {
      this.latchCaptureIssue(rec, "Microphone track ended. Please record again.");
    };
    const onMute = () => {
      this.latchCaptureIssue(rec, "Microphone track is muted. Please record again.");
    };

    rec.addEventListener("stop", onStop);
    rec.addEventListener("error", onError);
    rec.addEventListener("pause", onPause);
    tracks.forEach((track) => {
      track.addEventListener("ended", onEnded);
      track.addEventListener("mute", onMute);
    });
    this.monitoredRecorder = rec;
    this.removeCaptureMonitors = () => {
      rec.removeEventListener("stop", onStop);
      rec.removeEventListener("error", onError);
      rec.removeEventListener("pause", onPause);
      tracks.forEach((track) => {
        track.removeEventListener("ended", onEnded);
        track.removeEventListener("mute", onMute);
      });
    };
  }

  /** Request mic permission and prepare a healthy stream. */
  async init(): Promise<void> {
    if (!isRecordingSupported()) {
      throw new Error("Audio recording is not supported in this browser.");
    }
    if (this.stream && !this.streamHealthIssue(this.stream)) return;
    const generation = ++this.streamRequestGeneration;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    try {
      // A newly opened route can briefly be muted while the device warms up.
      // Wait before showing/scoring the prompt; never use loudness as readiness.
      const readyDeadline = Date.now() + 1000;
      const tracks = stream.getAudioTracks();
      while (tracks.some((track) => track.muted) && tracks.every((track) => track.readyState === "live" && track.enabled) && Date.now() < readyDeadline) {
        if (generation !== this.streamRequestGeneration) throw new Error("Microphone setup was cancelled.");
        await wait(25);
      }
      if (generation !== this.streamRequestGeneration) throw new Error("Microphone setup was cancelled.");
      const issue = this.streamHealthIssue(stream);
      if (issue) throw new Error(issue);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    this.stream = stream;
    this.mimeType = pickMimeType();
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  /** Latched failure from the current pre-submit capture, suitable for UI polling. */
  get captureIssue(): string | null {
    const rec = this.recorder;
    if (!this.captureIssueValue && rec && !this.submitted.has(rec)) {
      if (rec.state !== "recording") {
        this.latchCaptureIssue(rec, rec.state === "paused" ? "Audio capture was paused. Please record again." : "Audio capture stopped unexpectedly. Please record again.");
      } else {
        const issue = this.streamHealthIssue(rec.stream);
        if (issue) this.latchCaptureIssue(rec, issue);
      }
    }
    return this.captureIssueValue;
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  async start(prerollMs = 0): Promise<void> {
    if (this.stopPromise || (this.recorder && this.recorder.state !== "inactive")) {
      throw new Error("Recorder is already active.");
    }
    if (!this.stream) throw new Error("Recorder not initialized.");
    if (this.streamHealthIssue(this.stream)) await this.init();
    const stream = this.stream;
    if (!stream) throw new Error("Recorder not initialized.");

    this.captureIssueValue = null;
    this.clearCaptureMonitors();
    this.chunks = [];
    const options: MediaRecorderOptions = this.mimeType
      ? { mimeType: this.mimeType }
      : {};
    let rec: MediaRecorder;
    try {
      try {
        rec = new MediaRecorder(stream, options);
      } catch (preferredTypeError) {
        if (!this.mimeType) throw preferredTypeError;
        // Some Safari builds claim an MP4 type is supported but reject that
        // exact constructor option. Let the browser choose rather than losing
        // recording entirely.
        this.mimeType = "";
        rec = new MediaRecorder(stream);
      }
    } catch (error) {
      this.invalidateStream(stream);
      throw error;
    }
    this.recorder = rec;
    rec.addEventListener("stop", () => this.finalized.add(rec), { once: true });
    rec.ondataavailable = (e) => {
      // An old recorder may deliver queued events after dispose/new capture.
      if (this.recorder === rec && e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.monitorCapture(rec);

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let stateCheckId: ReturnType<typeof setTimeout> | null = null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (stateCheckId != null) clearTimeout(stateCheckId);
          if (timeoutId != null) clearTimeout(timeoutId);
          rec.removeEventListener("start", onStart);
          rec.removeEventListener("error", onError);
          rec.removeEventListener("stop", onStop);
        };
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else {
            this.startTime = Date.now();
            resolve();
          }
        };
        const onStart = () => finish();
        const onError = (event: Event) => {
          const mediaError = (event as Event & { error?: DOMException }).error;
          finish(mediaError instanceof Error ? mediaError : new Error("Audio recorder failed to start."));
        };
        const onStop = () => finish(new Error("Audio recorder stopped before the prompt was shown."));
        rec.addEventListener("start", onStart);
        rec.addEventListener("error", onError);
        rec.addEventListener("stop", onStop);
        timeoutId = setTimeout(() => {
          if (rec.state === "recording") finish();
          else finish(new Error("Audio recorder did not start."));
        }, 1000);
        try {
          rec.start();
          // Safari can omit `start`, but a synchronous state mutation alone is
          // too early to expose the prompt: queued error/stop events must get a
          // chance to win first. Use one bounded delayed state fallback.
          stateCheckId = setTimeout(() => {
            if (rec.state === "recording") finish();
          }, 100);
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      });

      if (prerollMs > 0) await wait(prerollMs);
      // A route change, lock-screen transition, or audio-device interruption can
      // stop iOS MediaRecorder during the hidden pre-roll. Never reveal the
      // prompt and start the scored clock unless this exact recorder and track
      // are still actively capturing.
      const issue = this.captureIssueValue || this.streamHealthIssue(stream);
      if (issue && !this.captureIssueValue) this.latchCaptureIssue(rec, issue);
      if (this.recorder !== rec || rec.state !== "recording" || issue) {
        throw new Error("Audio recorder stopped before the prompt was shown.");
      }
    } catch (error) {
      this.latchCaptureIssue(rec, "Audio recorder failed to start. Please record again.");
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {
        /* already stopped */
      }
      this.clearCaptureMonitors(rec);
      if (this.recorder === rec) this.recorder = null;
      throw error;
    }
  }

  private resultFrom(rec: MediaRecorder): RecordingResult {
    const chunkType = this.chunks.find(
      (chunk): chunk is Blob => chunk instanceof Blob && chunk.size > 0 && !!chunk.type,
    )?.type;
    const type = rec.mimeType || chunkType || this.mimeType || "audio/webm";
    const blob = new Blob(this.chunks, { type });
    this.clearCaptureMonitors(rec);
    if (this.recorder === rec) this.recorder = null;
    return {
      blob,
      mimeType: type,
      filename: `recall.${extensionFor(type)}`,
      durationMs: Date.now() - this.startTime,
      interrupted: this.interrupted.has(rec) || !this.submitted.has(rec),
    };
  }

  stop(postrollMs = 0): Promise<RecordingResult> {
    if (this.stopPromise) return this.stopPromise;
    const rec = this.recorder;
    if (!rec) {
      return Promise.reject(new Error("Not recording."));
    }
    // Catch a device change between the UI's health poll and this submit.
    void this.captureIssue;
    if (rec.state !== "inactive") this.submitted.add(rec);
    if (rec.state === "inactive" && this.finalized.has(rec)) {
      // iOS can stop MediaRecorder while the page backgrounds or the audio
      // route changes. If its final data event already arrived, preserve those
      // frames when the learner submits instead of forcing a destructive retry.
      const result = this.resultFrom(rec);
      return result.blob.size > 0
        ? Promise.resolve(result)
        : Promise.reject(new Error("Not recording."));
    }

    const stopPromise = new Promise<RecordingResult>((resolve, reject) => {
      let settled = false;
      let postrollId: ReturnType<typeof setTimeout> | null = null;
      let finalEventTimeout: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (postrollId != null) clearTimeout(postrollId);
        if (finalEventTimeout != null) clearTimeout(finalEventTimeout);
        rec.removeEventListener("stop", onStop);
        rec.removeEventListener("error", onError);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.interrupted.add(rec);
        this.invalidateStream(rec.stream);
        try {
          if (rec.state !== "inactive") rec.stop();
        } catch {
          /* already stopped */
        }
        this.clearCaptureMonitors(rec);
        if (this.recorder === rec) this.recorder = null;
        reject(error);
      };
      const onError = (event: Event) => {
        const mediaError = (event as Event & { error?: DOMException }).error;
        fail(mediaError instanceof Error ? mediaError : new Error("Audio recorder failed."));
      };
      const onStop = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(this.resultFrom(rec));
      };
      const requestStop = () => {
        if (settled) return;
        finalEventTimeout = setTimeout(() => fail(new Error("Audio recorder did not finalize. Please record again.")), 3000);
        if (rec.state === "inactive") {
          // Inactive is synchronous, but final data/stop events are queued.
          // Only the actual stop event proves all encoded audio arrived.
          if (this.finalized.has(rec)) onStop();
          return;
        }
        try {
          rec.stop();
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      };

      // Install interruption handlers before the tail wait. iOS may stop a
      // recorder when the app backgrounds or the audio route changes.
      rec.addEventListener("stop", onStop);
      rec.addEventListener("error", onError);
      if (postrollMs > 0) postrollId = setTimeout(requestStop, Math.max(0, postrollMs));
      else requestStop();
    });
    this.stopPromise = stopPromise;
    void stopPromise.finally(() => {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    }).catch(() => undefined);
    return stopPromise;
  }

  /** Release the microphone (call when leaving the session). */
  dispose(): void {
    this.streamRequestGeneration += 1;
    this.clearCaptureMonitors();
    try {
      this.recorder?.stop();
    } catch {
      /* ignore */
    }
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
