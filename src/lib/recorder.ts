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

const PREFERRED_TYPES = [
  "audio/mp4", // Safari / iOS
  "audio/webm;codecs=opus", // Chrome / Firefox
  "audio/webm",
  "audio/ogg;codecs=opus",
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

  start(): void {
    if (!this.stream) throw new Error("Recorder not initialized.");
    this.chunks = [];
    const options: MediaRecorderOptions = this.mimeType
      ? { mimeType: this.mimeType }
      : {};
    this.recorder = new MediaRecorder(this.stream, options);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.startTime = Date.now();
    this.recorder.start();
  }

  stop(): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      const rec = this.recorder;
      if (!rec) {
        reject(new Error("Not recording."));
        return;
      }
      rec.onstop = () => {
        const type = rec.mimeType || this.mimeType || "audio/webm";
        const blob = new Blob(this.chunks, { type });
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
