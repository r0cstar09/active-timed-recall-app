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

  static isTypeSupported(type) {
    return type === "audio/mp4";
  }

  constructor(stream, options) {
    super();
    this.stream = stream;
    this.mimeType = options.mimeType || "audio/mp4";
    this.state = "inactive";
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this.requested = false;
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
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["final-audio"]) });
    setTimeout(() => this.onstop?.(), 5);
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
  const startedAt = Date.now();
  await recorder.start(20);
  const readyMs = Date.now() - startedAt;
  assert.equal(recorder.isRecording, true);
  assert.ok(readyMs >= 20, `pre-roll was not awaited (${readyMs}ms)`);

  const stoppedAt = Date.now();
  const result = await recorder.stop(20);
  const stopMs = Date.now() - stoppedAt;
  assert.ok(stopMs >= 20, `post-roll was not awaited (${stopMs}ms)`);
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
  assert.ok(readyMs >= 80 && readyMs < 500, `state fallback resolved outside safe window (${readyMs}ms)`);
  await recorder.stop();
  recorder.dispose();
  FakeMediaRecorder.emitStart = true;
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
await testStartErrorIsSurfaced();
console.log("recorder lifecycle tests passed");
