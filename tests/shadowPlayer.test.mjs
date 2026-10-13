import assert from 'node:assert/strict';
import test from 'node:test';
import { ShadowPlayer } from '../src/lib/shadowPlayer.ts';

const AUDIO_A = 'https://audio.example.test/a.mp3';
const AUDIO_B = 'https://audio.example.test/b.mp3';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeAudio extends EventTarget {
  src = '';
  preload = '';
  currentTime = 0;
  duration = 4;
  playbackRate = 1;
  preservesPitch = false;
  webkitPreservesPitch = false;
  paused = true;
  ended = false;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  removeSourceCalls = 0;
  playResults = [];

  enqueuePlay(result) {
    this.playResults.push(result);
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    this.ended = false;
    const result = this.playResults.shift();
    return result ?? Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }

  load() {
    this.loadCalls += 1;
    this.ended = false;
  }

  removeAttribute(name) {
    if (name === 'src') {
      this.removeSourceCalls += 1;
      this.src = '';
    }
  }

  emitPlaying() {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event('playing'));
  }

  emitTime(position) {
    this.currentTime = position;
    this.dispatchEvent(new Event('timeupdate'));
  }

  naturalEnd() {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    // Browsers may queue pause immediately before ended at natural completion.
    this.dispatchEvent(new Event('pause'));
    this.dispatchEvent(new Event('ended'));
  }

  failLoad() {
    this.dispatchEvent(new Event('error'));
  }
}

function harness(options = {}) {
  const audios = [];
  const changes = [];
  let completions = 0;
  const player = new ShadowPlayer({
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio;
    },
    onChange: (snapshot) => changes.push(snapshot),
    onComplete: () => { completions += 1; },
    loadTimeoutMs: options.loadTimeoutMs ?? 200,
  });
  return {
    player,
    audios,
    changes,
    completions: () => completions,
  };
}

test('selection is paused, start is explicit, rate changes are in-place, and only ended completes', async () => {
  const h = harness();
  try {
    h.player.select(AUDIO_A);
    const audio = h.audios[0];
    assert.equal(h.audios.length, 1);
    assert.equal(audio.src, AUDIO_A);
    assert.equal(audio.playCalls, 0);
    assert.equal(h.player.snapshot.phase, 'paused');

    const copy = h.player.snapshot;
    copy.phase = 'error';
    assert.equal(h.player.snapshot.phase, 'paused', 'snapshot callers cannot mutate internal state');

    h.player.start();
    assert.equal(h.player.snapshot.phase, 'loading');
    assert.equal(audio.playbackRate, 0.75);
    await flush();
    assert.equal(h.player.snapshot.phase, 'playing');

    audio.emitTime(1.25);
    assert.equal(h.player.snapshot.position, 1.25);
    assert.equal(h.player.snapshot.duration, 4);
    audio.emitTime(4);
    assert.equal(h.completions(), 0, 'time reaching duration is not completion without ended');

    h.player.configure({ rate: 1, gapSeconds: 0.05, mode: 'repeat', showSpanish: false });
    assert.equal(audio.playbackRate, 1);
    assert.equal(audio.playCalls, 1, 'rate configuration does not restart playback');
    assert.equal(audio.currentTime, 4);

    h.player.pause();
    assert.equal(h.player.snapshot.phase, 'paused');
    assert.equal(h.completions(), 0, 'manual pause at duration does not complete');
    h.player.start();
    await flush();
    audio.naturalEnd();
    assert.equal(h.completions(), 1);
    assert.equal(h.player.snapshot.phase, 'gap');
    audio.dispatchEvent(new Event('ended'));
    assert.equal(h.completions(), 1, 'duplicate ended while in the gap is fenced');
    h.player.pause();
  } finally {
    h.player.dispose();
  }
});

test('repeat gap pause freezes remaining time and resume does not overlap', async () => {
  const h = harness({ loadTimeoutMs: 500 });
  try {
    h.player.configure({ rate: 0.75, gapSeconds: 0.15, mode: 'repeat', showSpanish: true });
    h.player.select(AUDIO_A);
    const audio = h.audios[0];
    h.player.start();
    await flush();
    audio.naturalEnd();
    assert.equal(h.completions(), 1);
    assert.equal(h.player.snapshot.phase, 'gap');

    await wait(25);
    h.player.pause();
    assert.equal(h.player.snapshot.phase, 'gap-paused');
    await wait(180);
    assert.equal(audio.playCalls, 1, 'paused gap owns no running timer');

    h.player.start();
    assert.equal(h.player.snapshot.phase, 'gap');
    await wait(60);
    assert.equal(audio.playCalls, 1, 'resume uses the frozen remainder, not an immediate loop');
    await wait(100);
    await flush();
    assert.equal(audio.playCalls, 2);
    assert.equal(h.player.snapshot.phase, 'playing');
  } finally {
    h.player.dispose();
  }
});

test('configuring a gap resets the full delay and preserves running versus paused state', async () => {
  const h = harness({ loadTimeoutMs: 500 });
  try {
    h.player.configure({ rate: 0.75, gapSeconds: 0.08, mode: 'repeat', showSpanish: true });
    h.player.select(AUDIO_A);
    const audio = h.audios[0];
    h.player.start();
    await flush();
    audio.naturalEnd();
    await wait(35);

    h.player.configure({ rate: 1, gapSeconds: 0.12, mode: 'repeat', showSpanish: true });
    assert.equal(h.player.snapshot.phase, 'gap');
    assert.equal(audio.playbackRate, 1);
    await wait(75);
    assert.equal(audio.playCalls, 1, 'new full running gap replaced the nearly-expired timer');
    await wait(65);
    await flush();
    assert.equal(audio.playCalls, 2);

    audio.naturalEnd();
    h.player.pause();
    assert.equal(h.player.snapshot.phase, 'gap-paused');
    h.player.configure({ rate: 0.5, gapSeconds: 0.06, mode: 'repeat', showSpanish: true });
    assert.equal(h.player.snapshot.phase, 'gap-paused');
    await wait(85);
    assert.equal(audio.playCalls, 2, 'reconfigured paused gaps stay paused');
    h.player.start();
    await wait(25);
    assert.equal(audio.playCalls, 2);
    await wait(50);
    await flush();
    assert.equal(audio.playCalls, 3);
  } finally {
    h.player.dispose();
  }
});

test('shadow-along loops immediately while an onComplete pause can still fence looping', async () => {
  const h = harness();
  try {
    h.player.configure({ rate: 1, gapSeconds: 8, mode: 'along', showSpanish: true });
    h.player.select(AUDIO_A);
    const audio = h.audios[0];
    h.player.start();
    await flush();
    audio.naturalEnd();
    assert.equal(h.completions(), 1);
    assert.equal(audio.playCalls, 2, 'along mode starts its next playback without a delay');
    assert.equal(audio.currentTime, 0);
    await flush();
    assert.equal(h.player.snapshot.phase, 'playing');
  } finally {
    h.player.dispose();
  }

  const audio = new FakeAudio();
  let player;
  let completions = 0;
  player = new ShadowPlayer({
    createAudio: () => audio,
    onChange: () => {},
    onComplete: () => {
      completions += 1;
      player.pause();
    },
    loadTimeoutMs: 200,
  });
  try {
    player.configure({ rate: 1, gapSeconds: 0, mode: 'along', showSpanish: true });
    player.select(AUDIO_A);
    player.start();
    await flush();
    audio.naturalEnd();
    assert.equal(completions, 1);
    assert.equal(player.snapshot.phase, 'gap-paused');
    assert.equal(audio.playCalls, 1, 'a synchronous stop decision in onComplete fences auto-loop');
  } finally {
    player.dispose();
  }
});

test('mode changes during a gap reset to zero but preserve a paused gap', async () => {
  const h = harness();
  try {
    h.player.configure({ rate: 0.75, gapSeconds: 1, mode: 'repeat', showSpanish: true });
    h.player.select(AUDIO_A);
    const audio = h.audios[0];
    h.player.start();
    await flush();
    audio.naturalEnd();
    assert.equal(h.player.snapshot.phase, 'gap');
    h.player.configure({ rate: 0.75, gapSeconds: 1, mode: 'along', showSpanish: true });
    assert.equal(audio.playCalls, 2, 'running gap switches to along immediately');
    await flush();

    h.player.configure({ rate: 0.75, gapSeconds: 1, mode: 'repeat', showSpanish: true });
    audio.naturalEnd();
    h.player.pause();
    assert.equal(h.player.snapshot.phase, 'gap-paused');
    h.player.configure({ rate: 0.75, gapSeconds: 1, mode: 'along', showSpanish: true });
    assert.equal(h.player.snapshot.phase, 'gap-paused');
    assert.equal(audio.playCalls, 2, 'paused gap remains paused when switched to along');
    h.player.start();
    assert.equal(audio.playCalls, 3, 'resume consumes the new zero-length gap');
  } finally {
    h.player.dispose();
  }
});

test('late play settlement cannot undo pause, a newer attempt, or a source switch', async () => {
  const h = harness({ loadTimeoutMs: 500 });
  try {
    h.player.select(AUDIO_A);
    const oldAudio = h.audios[0];
    const first = deferred();
    const second = deferred();
    oldAudio.enqueuePlay(first.promise);
    oldAudio.enqueuePlay(second.promise);

    h.player.start();
    assert.equal(h.player.snapshot.phase, 'loading');
    h.player.pause();
    assert.equal(h.player.snapshot.phase, 'paused');
    h.player.start();
    const pausesBeforeLateResolve = oldAudio.pauseCalls;
    first.resolve();
    await flush();
    assert.equal(h.player.snapshot.phase, 'loading');
    assert.equal(oldAudio.pauseCalls, pausesBeforeLateResolve, 'old resolution does not pause a newer attempt');
    second.resolve();
    await flush();
    assert.equal(h.player.snapshot.phase, 'playing');

    const stale = deferred();
    oldAudio.enqueuePlay(stale.promise);
    h.player.replay();
    assert.equal(h.player.snapshot.phase, 'loading');
    h.player.select(AUDIO_B);
    const newAudio = h.audios[1];
    assert.equal(oldAudio.src, '');
    assert.equal(oldAudio.removeSourceCalls, 1);
    assert.equal(newAudio.src, AUDIO_B);
    assert.equal(h.player.snapshot.phase, 'paused');
    stale.reject(new Error('old source failed late'));
    await flush();
    oldAudio.naturalEnd();
    assert.equal(h.player.snapshot.phase, 'paused');
    assert.equal(h.completions(), 0);
  } finally {
    h.player.dispose();
  }
});

test('timeout and play rejection are actionable, do not complete, and can retry', async () => {
  const h = harness({ loadTimeoutMs: 20 });
  try {
    h.player.select(AUDIO_A);
    const audio = h.audios[0];
    audio.enqueuePlay(new Promise(() => {}));
    h.player.start();
    await wait(35);
    assert.equal(h.player.snapshot.phase, 'error');
    assert.match(h.player.snapshot.error, /Retry audio/);
    assert.equal(h.completions(), 0);
    assert.equal(audio.paused, true);

    h.player.replay();
    await flush();
    const retryAudio = h.audios[1];
    assert.equal(h.audios.length, 2, 'retry fences the failed element with a fresh one');
    assert.equal(audio.src, '');
    assert.equal(h.player.snapshot.phase, 'playing');
    assert.equal(retryAudio.currentTime, 0);
    assert.equal(retryAudio.playCalls, 1);
  } finally {
    h.player.dispose();
  }

  const rejected = harness();
  try {
    rejected.player.select(AUDIO_A);
    rejected.audios[0].enqueuePlay(Promise.reject(new Error('autoplay blocked')));
    rejected.player.start();
    await flush();
    assert.equal(rejected.player.snapshot.phase, 'error');
    assert.match(rejected.player.snapshot.error, /Retry audio/);
    assert.equal(rejected.completions(), 0);
  } finally {
    rejected.player.dispose();
  }
});

test('media errors are actionable and never inferred as completion', () => {
  const h = harness();
  try {
    h.player.select(AUDIO_A);
    h.audios[0].failLoad();
    assert.equal(h.player.snapshot.phase, 'error');
    assert.match(h.player.snapshot.error, /choose another clip/);
    assert.equal(h.completions(), 0);
  } finally {
    h.player.dispose();
  }
});

test('starting another instance stops and detaches the previous module owner', async () => {
  const one = harness();
  const two = harness();
  try {
    one.player.select(AUDIO_A);
    two.player.select(AUDIO_B);
    one.player.start();
    await flush();
    assert.equal(one.player.snapshot.phase, 'playing');

    two.player.start();
    await flush();
    assert.equal(two.player.snapshot.phase, 'playing');
    assert.equal(one.player.snapshot.phase, 'idle');
    assert.equal(one.audios[0].src, '');
    one.audios[0].naturalEnd();
    assert.equal(one.completions(), 0);
    assert.equal(two.audios[0].paused, false);
  } finally {
    one.player.dispose();
    two.player.dispose();
  }
});

test('stop cancels gaps, detaches media, and requires a fresh element plus gesture to resume', async () => {
  const h = harness();
  try {
    h.player.configure({ rate: 0.75, gapSeconds: 0.04, mode: 'repeat', showSpanish: true });
    h.player.select(AUDIO_A);
    const oldAudio = h.audios[0];
    h.player.start();
    await flush();
    oldAudio.naturalEnd();
    h.player.stop();
    assert.equal(h.player.snapshot.phase, 'idle');
    assert.equal(oldAudio.src, '');
    await wait(70);
    assert.equal(oldAudio.playCalls, 1, 'stopped gap does not loop');

    h.player.start();
    assert.equal(h.audios.length, 2);
    assert.equal(h.player.snapshot.phase, 'loading');
    await flush();
    assert.equal(h.player.snapshot.phase, 'playing');
    h.player.dispose();
    h.audios[1].naturalEnd();
    assert.equal(h.completions(), 1, 'disposed media listeners cannot report stale completion');
  } finally {
    h.player.dispose();
  }
});

test('invalid sources and audio factory failures stay contained', () => {
  const h = harness();
  h.player.select('javascript:alert(1)');
  assert.equal(h.audios.length, 0);
  assert.equal(h.player.snapshot.phase, 'error');
  assert.match(h.player.snapshot.error, /Choose another clip/);
  h.player.dispose();

  const player = new ShadowPlayer({
    createAudio: () => { throw new Error('media unavailable'); },
    onChange: () => {},
    onComplete: () => { throw new Error('must not run'); },
  });
  player.select(AUDIO_A);
  assert.equal(player.snapshot.phase, 'error');
  assert.match(player.snapshot.error, /could not be prepared/);
  player.dispose();
});

test('hostile load timeout values are capped at fifteen seconds', () => {
  const originalSetTimeout = globalThis.setTimeout;
  let observedDelay = null;
  globalThis.setTimeout = ((callback, delay) => {
    observedDelay = delay;
    return 12345;
  });
  const audio = new FakeAudio();
  audio.enqueuePlay(new Promise(() => {}));
  const player = new ShadowPlayer({
    createAudio: () => audio,
    onChange: () => {},
    onComplete: () => {},
    loadTimeoutMs: 60_000,
  });
  try {
    player.select(AUDIO_A);
    player.start();
    assert.equal(observedDelay, 15_000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    player.dispose();
  }
});

test('synchronous change callbacks can cancel startup and cannot resurrect disposal', () => {
  const audio = new FakeAudio();
  let player;
  let cancelStartup = true;
  let restartOnIdle = false;
  player = new ShadowPlayer({
    createAudio: () => audio,
    onChange: (snapshot) => {
      if (cancelStartup && snapshot.phase === 'loading') {
        cancelStartup = false;
        player.pause();
      }
      if (restartOnIdle && snapshot.phase === 'idle') player.start();
    },
    onComplete: () => {},
    loadTimeoutMs: 50,
  });

  player.select(AUDIO_A);
  player.start();
  assert.equal(player.snapshot.phase, 'paused');
  assert.equal(audio.playCalls, 0, 'cancellation during loading notification fences play()');

  restartOnIdle = true;
  player.dispose();
  assert.equal(player.snapshot.phase, 'idle');
  assert.equal(audio.playCalls, 0, 'dispose latches before its final notification');
  assert.equal(audio.src, '');
});
