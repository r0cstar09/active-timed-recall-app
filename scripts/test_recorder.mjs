import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const cjsRequire = createRequire(import.meta.url);
const source = fs.readFileSync(new URL("../src/lib/recorder.ts", import.meta.url), "utf8");
const recallSource = fs.readFileSync(new URL("../src/components/RecallSession.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

let lastRecorder = null;
class FakeMediaRecorder extends EventTarget {
  static emitStart = true;
  static startError = false;
  static rejectTypedConstructor = false;
  static constructorAttempts = 0;

  static isTypeSupported(type) {
    return type === "audio/mp4";
  }

  constructor(stream, options = {}) {
    super();
    FakeMediaRecorder.constructorAttempts += 1;
    if (FakeMediaRecorder.rejectTypedConstructor && options.mimeType) {
      throw new DOMException("Typed recorder rejected", "NotSupportedError");
    }
    this.stream = stream;
    this.mimeType = options.mimeType || "audio/mp4";
    this.state = "inactive";
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this.requested = false;
    this.stopCalls = 0;
    lastRecorder = this;
  }

  start() {
    if (FakeMediaRecorder.startError) {
      setTimeout(() => this.dispatchEvent(new Event("error")), 5);
      return;
    }
    this.state = "recording";
    if (FakeMediaRecorder.emitStart) {
      setTimeout(() => this.dispatchEvent(new Event("start")), 5);
    }
  }

  requestData() {
    this.requested = true;
    this.ondataavailable?.({ data: new Blob(["audio-frame"], { type: this.mimeType }) });
  }

  stop() {
    this.stopCalls += 1;
    this.state = "inactive";
    setTimeout(() => {
      // Match actual browser ordering: state changes now, terminal data later.
      this.ondataavailable?.({ data: new Blob(["final-audio"]) });
      this.dispatchEvent(new Event("stop"));
      this.onstop?.();
    }, 5);
  }

  interrupt() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["interrupted-audio"], { type: this.mimeType }) });
    this.dispatchEvent(new Event("stop"));
    this.onstop?.();
  }
}

function makeStream() {
  const track = { readyState: "live", stop() { this.readyState = "ended"; } };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}
let micRequests = 0;
const context = {
  module: { exports: {} },
  exports: {},
  require: cjsRequire,
  console,
  setTimeout,
  clearTimeout,
  navigator: { mediaDevices: { getUserMedia: async () => { micRequests += 1; return makeStream(); } } },
  MediaRecorder: FakeMediaRecorder,
  Blob,
  Event,
  EventTarget,
  DOMException,
  Date,
};
context.exports = context.module.exports;
vm.runInNewContext(compiled, context, { filename: "recorder.js" });
const { Recorder } = context.module.exports;

async function testNormalLifecycle() {
  const recorder = new Recorder();
  await recorder.init();
  const startPromise = recorder.start(20);
  const startStillPendingAtHalfway = await Promise.race([
    startPromise.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 10)),
  ]);
  assert.equal(startStillPendingAtHalfway, true, "pre-roll resolved before its halfway point");
  await startPromise;
  assert.equal(recorder.isRecording, true);

  const stopPromise = recorder.stop(20);
  const stopStillPendingAtHalfway = await Promise.race([
    stopPromise.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 10)),
  ]);
  assert.equal(stopStillPendingAtHalfway, true, "post-roll resolved before its halfway point");
  const result = await stopPromise;
  assert.equal(result.interrupted, false, "normal submission must remain gradeable");
  assert.equal(lastRecorder.requested, false, "stop should not force an extra MP4 fragment");
  assert.ok(result.blob.size > 0, "recording blob was empty");
  assert.equal(result.mimeType, "audio/mp4");
  assert.equal(result.filename, "recall.m4a");
  recorder.dispose();
}

async function testMissingStartEventFallback() {
  FakeMediaRecorder.emitStart = false;
  const recorder = new Recorder();
  await recorder.init();
  const startedAt = Date.now();
  await recorder.start();
  const readyMs = Date.now() - startedAt;
  assert.equal(recorder.isRecording, true);
  assert.ok(readyMs < 80, `state fallback added a hidden delay (${readyMs}ms)`);
  await recorder.stop();
  recorder.dispose();
  FakeMediaRecorder.emitStart = true;
}

async function testTypedConstructorFallback() {
  FakeMediaRecorder.rejectTypedConstructor = true;
  FakeMediaRecorder.constructorAttempts = 0;
  const recorder = new Recorder();
  await recorder.init();
  await recorder.start();
  assert.equal(FakeMediaRecorder.constructorAttempts, 2, "browser-default constructor was not retried");
  const result = await recorder.stop();
  assert.equal(result.mimeType, "audio/mp4");
  recorder.dispose();
  FakeMediaRecorder.rejectTypedConstructor = false;
}

async function testInterruptionDuringPrerollIsRejected() {
  const recorder = new Recorder();
  await recorder.init();
  const startPromise = recorder.start(30);
  setTimeout(() => lastRecorder.interrupt(), 5);
  await assert.rejects(
    startPromise,
    /stopped before the prompt was shown/,
    "the prompt would be shown after capture had already stopped",
  );
  assert.equal(recorder.isRecording, false);
  recorder.dispose();
}

async function testInterruptionBeforeSubmitPreservesCapture() {
  const recorder = new Recorder();
  await recorder.init();
  await recorder.start();
  lastRecorder.interrupt();
  const result = await recorder.stop();
  assert.ok(result.blob.size > 0, "audio delivered before the interruption was discarded");
  assert.equal(result.mimeType, "audio/mp4");
  recorder.dispose();
}

async function testInterruptionDuringPostroll() {
  const recorder = new Recorder();
  await recorder.init();
  await recorder.start();
  const resultPromise = recorder.stop(100);
  setTimeout(() => lastRecorder.interrupt(), 10);
  const result = await resultPromise;
  assert.ok(result.blob.size > 0, "interrupted capture was discarded");
  recorder.dispose();
}

async function testPausedCaptureCanStillStop() {
  const recorder = new Recorder();
  await recorder.init();
  await recorder.start();
  lastRecorder.state = "paused";
  const result = await recorder.stop();
  assert.ok(result.blob.size > 0, "pausing before submit discarded the capture");
  assert.equal(lastRecorder.stopCalls, 1);
  recorder.dispose();
}

async function testDuplicateStopSharesCapture() {
  const recorder = new Recorder();
  await recorder.init();
  await recorder.start();
  const fake = lastRecorder;
  const [first, second] = await Promise.all([recorder.stop(20), recorder.stop(20)]);
  assert.equal(fake.stopCalls, 1, "duplicate stop called MediaRecorder.stop twice");
  assert.equal(first.blob.size, second.blob.size);
  recorder.dispose();
}

async function testStartErrorIsSurfaced() {
  FakeMediaRecorder.startError = true;
  const recorder = new Recorder();
  await recorder.init();
  await assert.rejects(() => recorder.start(), /failed to start/);
  recorder.dispose();
  FakeMediaRecorder.startError = false;
}

function testInlineRetryWarmsMicrophoneBeforeNetwork() {
  const retryComponent = recallSource.slice(recallSource.indexOf("function RetryRecorder"));
  const begin = retryComponent.slice(
    retryComponent.indexOf("async function begin()"),
    retryComponent.indexOf("async function finish"),
  );
  const initAt = begin.indexOf("await recRef.current.init()");
  const requestAt = begin.indexOf("await api.retryItem");
  assert.ok(initAt >= 0 && requestAt >= 0, "retry setup calls changed unexpectedly");
  assert.ok(
    initAt < requestAt,
    "inline retry waits on the network before warming the microphone, which can lose iPhone user activation",
  );
}

function testScoredBoundariesExcludeEncoderMargins() {
  const beginItem = recallSource.slice(
    recallSource.indexOf("async function beginItem"),
    recallSource.indexOf("async function armRecorder"),
  );
  assert.ok(
    beginItem.indexOf("await recorderRef.current?.start(ENCODER_PREROLL_MS)")
      < beginItem.indexOf("promptShownAtRef.current ="),
    "the scored prompt clock starts before encoder pre-roll completes",
  );

  const submit = recallSource.slice(
    recallSource.indexOf("const submit = useCallback"),
    recallSource.indexOf("useEffect(() => {\n    submitRef.current = submit"),
  );
  assert.ok(
    submit.indexOf("const answeredAtMs = Date.now()")
      < submit.indexOf("stop(ENCODER_POSTROLL_MS)"),
    "main answer timing includes encoder post-roll",
  );

  const retryComponent = recallSource.slice(
    recallSource.indexOf("function RetryRecorder"),
    recallSource.indexOf("// ── Transcript feedback"),
  );
  const finish = retryComponent.slice(
    retryComponent.indexOf("async function finish"),
    retryComponent.indexOf("async function uploadAndGrade"),
  );
  assert.ok(
    finish.indexOf("const answeredAtMs = Date.now()")
      < finish.indexOf("stop(ENCODER_POSTROLL_MS)"),
    "retry answer timing includes encoder post-roll",
  );
}

function testCapturedBlobUploadRetryIsDirect() {
  const uploadRender = recallSource.slice(
    recallSource.indexOf('if (phase === "uploading")'),
    recallSource.indexOf("// ── render: RECALL"),
  );
  assert.match(uploadRender, /onClick=\{\(\) => void uploadPendingAndAdvance\(\)\}/);
  assert.doesNotMatch(uploadRender, /submitRef\.current/);
  assert.match(recallSource, /pendingUploadRef\.current = pending/);
  assert.match(recallSource, /keep pendingUploadRef so the Retry button resends the same blob/);
}

function testInlineRetryPreservesNoisyMode() {
  const retryComponent = recallSource.slice(
    recallSource.indexOf("function RetryRecorder"),
    recallSource.indexOf("// ── Transcript feedback"),
  );
  assert.match(retryComponent, /noisyMode: boolean/, "retry recorder does not receive the selected capture mode");
  assert.match(
    retryComponent,
    /filename: pending\.filename,\s*noisyMode,/,
    "retry upload silently drops noisy-mode preprocessing metadata",
  );
  assert.match(
    recallSource,
    /<RetryRecorder[\s\S]*?noisyMode=\{noisyMode\}/,
    "session noisy mode is not forwarded to the retry recorder",
  );
}

async function testInactiveStateWaitsForFinalData() {
  const recorder = new Recorder();
  await recorder.init();
  await recorder.start();
  lastRecorder.requestData();
  lastRecorder.stop();
  const captured = await recorder.stop();
  assert.equal(await captured.blob.text(), "audio-framefinal-audio", "queued final words were dropped");
  assert.equal(captured.interrupted, true, "interrupted capture must not be graded as complete");
  assert.match(recallSource, /rec\.blob\.size === 0 \|\| rec\.interrupted/, "submit must reject incomplete capture before upload");
  recorder.dispose();
}

async function testEndedMicrophoneIsReacquired() {
  const recorder = new Recorder();
  await recorder.init();
  const requests = micRequests;
  await recorder.init();
  assert.equal(micRequests, requests, "live mic should be reused");
  recorder.getStream().getTracks().forEach(track => track.stop());
  await recorder.init();
  assert.equal(micRequests, requests + 1);
  assert.equal(recorder.getStream().getAudioTracks()[0].readyState, "live");
  recorder.getStream().getTracks().forEach(track => track.stop());
  await recorder.start(); // beginItem retries start directly, without init.
  assert.equal(micRequests, requests + 2);
  assert.equal((await recorder.stop()).interrupted, false);
  recorder.dispose();
}

await testInactiveStateWaitsForFinalData();
await testEndedMicrophoneIsReacquired();
await testNormalLifecycle();
await testMissingStartEventFallback();
await testTypedConstructorFallback();
await testInterruptionDuringPrerollIsRejected();
await testInterruptionBeforeSubmitPreservesCapture();
await testInterruptionDuringPostroll();
await testPausedCaptureCanStillStop();
await testDuplicateStopSharesCapture();
await testStartErrorIsSurfaced();
testInlineRetryWarmsMicrophoneBeforeNetwork();
testScoredBoundariesExcludeEncoderMargins();
testCapturedBlobUploadRetryIsDirect();
testInlineRetryPreservesNoisyMode();
console.log("recorder lifecycle tests passed");
