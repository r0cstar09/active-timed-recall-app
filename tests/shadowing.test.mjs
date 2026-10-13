import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PREFERENCES,
  STORAGE_KEY,
  activeClips,
  pickClip,
  provenance,
  readShadow,
  safeAudioUrl,
  saveShadow,
} from '../src/lib/shadowing.ts';

function card(overrides = {}) {
  return {
    phrase_id: 1,
    spanish: 'Una frase.',
    english: 'A sentence.',
    audio_url: '/api/audio/source/abcdefghijk/clip.mp3',
    active: true,
    source_type: 'youtube',
    source_url: 'https://www.youtube.com/watch?v=abcdefghijk',
    ...overrides,
  };
}

test('storage defaults are fresh and malformed or inaccessible data is harmless', () => {
  assert.deepEqual(DEFAULT_PREFERENCES, {
    rate: 0.75,
    gapSeconds: 3,
    mode: 'repeat',
    showSpanish: true,
  });

  const empty = { getItem: () => null };
  const first = readShadow(empty);
  first.preferences.rate = 1;
  assert.deepEqual(readShadow(empty), {
    version: 1,
    clipId: null,
    preferences: { rate: 0.75, gapSeconds: 3, mode: 'repeat', showSpanish: true },
  });

  const invalid = [
    '',
    '{',
    'null',
    '[]',
    JSON.stringify({ version: 2, clipId: 4, preferences: DEFAULT_PREFERENCES }),
    JSON.stringify({ version: 1, clipId: -1, preferences: DEFAULT_PREFERENCES }),
    JSON.stringify({ version: 1, clipId: 2.5, preferences: DEFAULT_PREFERENCES }),
    JSON.stringify({ version: 1, clipId: 4, preferences: { ...DEFAULT_PREFERENCES, rate: 20 } }),
    JSON.stringify({ version: 1, clipId: 4, preferences: { ...DEFAULT_PREFERENCES, gapSeconds: -1 } }),
    JSON.stringify({ version: 1, clipId: 4, preferences: { ...DEFAULT_PREFERENCES, mode: 'grade' } }),
    JSON.stringify({ version: 1, clipId: 4, preferences: { ...DEFAULT_PREFERENCES, showSpanish: 'yes' } }),
  ];
  for (const raw of invalid) {
    assert.deepEqual(readShadow({ getItem: () => raw }), {
      version: 1,
      clipId: null,
      preferences: { ...DEFAULT_PREFERENCES },
    });
  }
  assert.doesNotThrow(() => readShadow({ getItem: () => { throw new Error('blocked'); } }));
  assert.deepEqual(readShadow({ getItem: () => { throw new Error('blocked'); } }), {
    version: 1,
    clipId: null,
    preferences: { ...DEFAULT_PREFERENCES },
  });
});

test('storage writes only the versioned minimal record and reports failures', () => {
  let key = '';
  let raw = '';
  const value = {
    version: 1,
    clipId: 91,
    preferences: { rate: 1, gapSeconds: 8, mode: 'along', showSpanish: false },
    spanish: 'must not persist',
    audio_url: 'https://private.invalid/audio',
    completed: 77,
  };
  assert.equal(saveShadow({ setItem: (nextKey, nextRaw) => { key = nextKey; raw = nextRaw; } }, value), true);
  assert.equal(key, STORAGE_KEY);
  assert.deepEqual(JSON.parse(raw), {
    version: 1,
    clipId: 91,
    preferences: { rate: 1, gapSeconds: 8, mode: 'along', showSpanish: false },
  });
  assert.equal(raw.includes('must not persist'), false);
  assert.equal(raw.includes('private.invalid'), false);
  assert.equal(saveShadow({ setItem: () => { throw new Error('quota'); } }, value), false);
  assert.equal(saveShadow({ setItem: () => { throw new Error('should not run'); } }, {
    ...value,
    clipId: 0,
  }), false);
});

test('safeAudioUrl admits only credential-free network URLs and known relative media paths', () => {
  assert.equal(safeAudioUrl(' https://cdn.example.test/a%20b.mp3?token=1 '), 'https://cdn.example.test/a%20b.mp3?token=1');
  assert.equal(safeAudioUrl('http://localhost:8000/test.wav'), 'http://localhost:8000/test.wav');
  assert.equal(safeAudioUrl('/api/audio/source/folder/test.wav?download=0'), '/api/audio/source/folder/test.wav?download=0');

  for (const unsafe of [
    '',
    'javascript:alert(1)',
    'data:audio/wav;base64,AAAA',
    'blob:https://example.test/id',
    'file:///tmp/a.wav',
    'https://user:secret@example.test/a.mp3',
    '//example.test/a.mp3',
    '/api/sessions/1',
    '/api/audio/recording/4',
    '/api/audio/source/',
    '/api/audio/source/../recording/4',
    'https:\\example.test\\a.mp3',
  ]) {
    assert.equal(safeAudioUrl(unsafe), '', unsafe);
  }
});

test('provenance is conservative about YouTube imports and synthetic audio', () => {
  assert.equal(provenance(card()), 'imported');
  assert.equal(provenance(card({ source_url: 'https://youtu.be/ZYXwvutsr10' })), 'imported');
  assert.equal(provenance(card({ source_type: 'fixture' })), 'unknown');
  assert.equal(provenance(card({ source_url: 'https://youtube.com/watch?v=short' })), 'unknown');
  assert.equal(provenance(card({ source_url: 'https://evil.test/watch?v=abcdefghijk' })), 'unknown');
  assert.equal(provenance(card({ audio_url: '' })), 'unknown');
  assert.equal(provenance(card({ audio_url: 'javascript:alert(1)' })), 'unknown');
  assert.equal(provenance(card({ audio_url: '/api/audio/source/synthetic/pattern_drills/a.mp3' })), 'generated');
  assert.equal(provenance(card({
    source_type: 'sentence-pack',
    source_url: 'sentence-packs://hermes-generated',
    audio_url: '',
  })), 'generated');
  assert.equal(provenance(card({
    source_type: 'mystery',
    source_url: null,
    audio_url: 'https://cdn.example.test/TTS/a.mp3',
  })), 'generated');
});

test('activeClips validates, deduplicates, normalizes and stable-partitions without mutation', () => {
  const rows = [
    card({ phrase_id: 2, source_type: 'sentence_pack', source_url: 'sentence-packs://hermes-generated', audio_url: '/api/audio/source/synthetic/a.mp3' }),
    card({ phrase_id: 1, spanish: 'Primera.' }),
    card({ phrase_id: 3, source_type: 'fixture', source_url: 'https://fixture.invalid/3', audio_url: 'javascript:bad' }),
    card({ phrase_id: 2, spanish: 'Duplicate must lose.' }),
    card({ phrase_id: 4, source_type: 'youtube', source_url: 'https://youtu.be/ZYXwvutsr10', audio_url: 'https://cdn.example.test/four.mp3' }),
    card({ phrase_id: 5, active: false }),
    card({ phrase_id: 0 }),
    card({ phrase_id: 6, spanish: '   ' }),
    card({ phrase_id: 7, english: '' }),
    card({ phrase_id: 8, source_type: 'fixture', source_url: 'https://fixture.invalid/8', audio_url: '' }),
  ];
  const before = structuredClone(rows);
  const result = activeClips(rows);
  assert.deepEqual(result.map((item) => item.phrase_id), [1, 4, 2, 3, 8]);
  assert.equal(result.find((item) => item.phrase_id === 3).audio_url, '');
  assert.equal(result.find((item) => item.phrase_id === 8).audio_url, '');
  assert.deepEqual(rows, before);
  assert.notEqual(result[0], rows[1]);
});

test('pickClip reconciles stale IDs then uses playable imported, playable, and visible fallbacks', () => {
  const rows = [
    card({ phrase_id: 10, source_type: 'sentence_pack', source_url: 'sentence-packs://hermes-generated', audio_url: '/api/audio/source/synthetic/ten.mp3' }),
    card({ phrase_id: 11, audio_url: '' }),
    card({ phrase_id: 12, audio_url: '/api/audio/source/abcdefghijk/twelve.mp3' }),
  ];
  assert.equal(pickClip(rows, 11)?.phrase_id, 11, 'a current saved ID is authoritative even if audio needs repair');
  assert.equal(pickClip(rows, 999)?.phrase_id, 12, 'a stale ID falls back to playable imported audio');
  assert.equal(pickClip(rows.slice(0, 2), null)?.phrase_id, 10, 'then any playable card');
  assert.equal(pickClip([rows[1]], null)?.phrase_id, 11, 'then the first actionable missing-audio card');
  assert.equal(pickClip([card({ active: false })], null), null);
});
