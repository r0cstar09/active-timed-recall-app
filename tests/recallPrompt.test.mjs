import assert from "node:assert/strict";
import test from "node:test";

import { recallPromptText } from "../src/lib/recallPrompt.ts";

const base = {
  sprint_item_id: 1,
  phrase_id: 10,
  position: 1,
  prompt: "ir — go",
  prompt_type: "minimal",
  english: "When you leave, let me know if you're going to stop by the pharmacy.",
  english_meaning: "When you leave, let me know if you're going to stop by the pharmacy.",
  context_clue: "Uses irse and a command.",
  cloze_prompt: "Cuando te vayas, ____.",
  source_audio_url: null,
};

test("stale minimal payloads show the sentence-specific English meaning", () => {
  assert.equal(recallPromptText(base), base.english);
  assert.notEqual(recallPromptText(base), base.prompt);
});

test("audio prompts use English when the clip is missing or playback failed", () => {
  const audio = {
    ...base,
    prompt_type: "audio",
    prompt: "Listen once, then produce the Spanish.",
    source_audio_url: "https://api.example/audio.mp3",
  };
  assert.equal(recallPromptText(audio, false), base.english);
  assert.equal(recallPromptText({ ...audio, source_audio_url: null }), base.english);
});

test("playable audio prompts keep their listening instruction", () => {
  const audio = {
    ...base,
    prompt_type: "audio",
    prompt: "Listen once, then produce the Spanish.",
    source_audio_url: "https://api.example/audio.mp3",
  };
  assert.equal(recallPromptText(audio, true), audio.prompt);
});

test("cloze and English prompts retain their intended sentence cues", () => {
  assert.equal(recallPromptText({ ...base, prompt_type: "cloze" }), base.cloze_prompt);
  assert.equal(recallPromptText({ ...base, prompt_type: "english", prompt: base.english }), base.english);
});
