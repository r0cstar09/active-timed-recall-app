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
  private recorder: MediaRecorder | null = null;
  private stopPromise: Promise<RecordingResult> | null = null;
  private chunks: BlobPart[] = [];
  private startTime = 0;
  private mimeType = "";

  /** Request mic permission and prepare the stream (acceptance test #2). */
  async init(): Promise<void> {
    if (!isRecordingSupported()) {
      throw new Error("Audio recording is not supported in this browser.");
    }
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.mimeType = pickMimeType();
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  async start(prerollMs = 0): Promise<void> {
    if (!this.stream) throw new Error("Recorder not initialized.");
    if (this.recorder && this.recorder.state !== "inactive") {
      throw new Error("Recorder is already active.");
    }
    this.chunks = [];
    const options: MediaRecorderOptions = this.mimeType
      ? { mimeType: this.mimeType }
      : {};
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(this.stream, options);
    } catch (preferredTypeError) {
      if (!this.mimeType) throw preferredTypeError;
      // Some Safari builds claim an MP4 type is supported but reject that
      // exact constructor option. Let the browser choose rather than losing
      // recording entirely.
      this.mimeType = "";
      rec = new MediaRecorder(this.stream);
    }
    this.recorder = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let stateCheckId: ReturnType<typeof setTimeout> | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (stateCheckId != null) clearTimeout(stateCheckId);
        if (timeoutId != null) clearTimeout(timeoutId);
        rec.removeEventListener("start", onStart);
        rec.removeEventListener("error", onError);
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
      rec.addEventListener("start", onStart);
      rec.addEventListener("error", onError);
      timeoutId = setTimeout(() => {
        if (rec.state === "recording") finish();
        else finish(new Error("Audio recorder did not start."));
      }, 1000);
      try {
        rec.start();
        // Safari can transition state correctly while delaying or omitting the
        // `start` event. State is sufficient confirmation and avoids adding a
        // hidden delay before the intentional pre-roll.
        if (rec.state === "recording") finish();
        else {
          stateCheckId = setTimeout(() => {
            if (rec.state === "recording") finish();
          }, 100);
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    if (prerollMs > 0) await wait(prerollMs);
  }

  stop(postrollMs = 0): Promise<RecordingResult> {
    if (this.stopPromise) return this.stopPromise;
    const rec = this.recorder;
    if (!rec || rec.state === "inactive") {
      return Promise.reject(new Error("Not recording."));
    }

    const stopPromise = new Promise<RecordingResult>((resolve, reject) => {
      let settled = false;
      let postrollId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (postrollId != null) clearTimeout(postrollId);
        rec.removeEventListener("stop", onStop);
        rec.removeEventListener("error", onError);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          if (rec.state !== "inactive") rec.stop();
        } catch {
          /* already stopped */
        }
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
        const chunkType = this.chunks.find(
          (chunk): chunk is Blob => chunk instanceof Blob && chunk.size > 0 && !!chunk.type,
        )?.type;
        const type = rec.mimeType || chunkType || this.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type });
        if (this.recorder === rec) this.recorder = null;
        resolve({
          blob,
          mimeType: type,
          filename: `recall.${extensionFor(type)}`,
          durationMs: Date.now() - this.startTime,
        });
      };
      const requestStop = () => {
        if (settled) return;
        if (rec.state === "inactive") {
          // An external interruption may transition state before dispatching a
          // stop event. Finalize chunks already delivered instead of rejecting
          // a usable recording.
          onStop();
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
