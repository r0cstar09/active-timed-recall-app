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
    const rec = new MediaRecorder(this.stream, options);
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
      stateCheckId = setTimeout(() => {
        // Preserve compatibility with Safari builds that transition state but
        // delay or omit the `start` event.
        if (rec.state === "recording") finish();
      }, 100);
      timeoutId = setTimeout(() => {
        if (rec.state === "recording") finish();
        else finish(new Error("Audio recorder did not start."));
      }, 1000);
      try {
        rec.start();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    if (prerollMs > 0) await wait(prerollMs);
  }

  async stop(postrollMs = 0): Promise<RecordingResult> {
    const rec = this.recorder;
    if (!rec) throw new Error("Not recording.");
    if (postrollMs > 0) await wait(postrollMs);

    return new Promise((resolve, reject) => {
      if (rec.state === "inactive") {
        reject(new Error("Not recording."));
        return;
      }
      rec.onerror = (event) => {
        const mediaError = (event as Event & { error?: DOMException }).error;
        reject(mediaError instanceof Error ? mediaError : new Error("Audio recorder failed."));
      };
      rec.onstop = () => {
        const type = rec.mimeType || this.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type });
        if (this.recorder === rec) this.recorder = null;
        resolve({
          blob,
          mimeType: type,
          filename: `recall.${extensionFor(type)}`,
          durationMs: Date.now() - this.startTime,
        });
      };
      try {
        rec.stop();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
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
