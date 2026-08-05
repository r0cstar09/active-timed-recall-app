import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

const cjsRequire = createRequire(import.meta.url);
const source = fs.readFileSync(new URL("../src/lib/recorder.ts", import.meta.url), "utf8");
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
    this.ondataavailable?.({ data: new Blob(["final-audio"]) });
    setTimeout(() => {
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

const stream = { getTracks: () => [{ stop() {} }] };
const context = {
  module: { exports: {} },
  exports: {},
  require: cjsRequire,
  console,
  setTimeout,
  clearTimeout,
  navigator: { mediaDevices: { getUserMedia: async () => stream } },
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

await testNormalLifecycle();
await testMissingStartEventFallback();
await testTypedConstructorFallback();
await testInterruptionDuringPostroll();
await testDuplicateStopSharesCapture();
await testStartErrorIsSurfaced();
console.log("recorder lifecycle tests passed");
