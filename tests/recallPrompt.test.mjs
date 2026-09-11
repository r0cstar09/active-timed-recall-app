import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { recallPromptPresentation, recallPromptText } from "../src/lib/recallPrompt.ts";

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
  answer_visible: false,
};

const recallSessionSource = readFileSync(
  new URL("../src/components/RecallSession.tsx", import.meta.url),
  "utf8",
);

for (const mode of ["review", "practice", "misses"]) {
  test(`${mode} always uses English for stale graduated prompt payloads`, () => {
    for (const prompt_type of ["audio", "cloze", "minimal"]) {
      const item = {
        ...base,
        mode,
        prompt_type,
        prompt: prompt_type === "audio" ? "Listen once, then produce the Spanish." : base.prompt,
        source_audio_url: "https://api.example/source-answer.mp3",
      };
      const presentation = recallPromptPresentation(item, mode, true);
      assert.equal(presentation.cue, base.english);
      assert.equal(presentation.cueKind, "english");
      assert.equal(presentation.showSourceAudio, false);
      assert.equal(presentation.sourceAudioUnavailable, false);
      assert.equal(recallPromptText(item, mode, true), base.english);
    }
  });
}

test("a stale cached normal-review audio payload cannot leak source-answer audio before the answer", () => {
  const staleAudio = {
    ...base,
    mode: "review",
    prompt_type: "audio",
    prompt: "Listen once, then produce the Spanish.",
    source_audio_url: "https://api.example/source-answer.mp3",
    answer_visible: false,
  };
  const presentation = recallPromptPresentation(staleAudio, "review", true);
  assert.equal(presentation.cue, base.english);
  assert.equal(presentation.showSourceAudio, false);
  assert.equal(presentation.expectsSourceAudio, false);
});

test("normal English prompts do not expose optional source audio before reveal", () => {
  const presentation = recallPromptPresentation({
    ...base,
    mode: "practice",
    prompt_type: "english",
    prompt: base.english,
    source_audio_url: "https://api.example/source-answer.mp3",
  }, "practice", true);
  assert.equal(presentation.cue, base.english);
  assert.equal(presentation.showSourceAudio, false);
});

test("the recall component renders cue and pre-answer audio from the shared policy", () => {
  assert.match(
    recallSessionSource,
    /recallPromptPresentation\(item, sessionMode, sourceAudioUsable\)/,
  );
  assert.match(recallSessionSource, /promptPresentation\?\.showSourceAudio/);
  assert.doesNotMatch(
    recallSessionSource,
    /item\?\.source_audio_url && item\.prompt_type !== "audio_shadow" && item\.answer_visible === false/,
  );
  assert.doesNotMatch(recallSessionSource, /item\?\.prompt_type === "cloze"/);
});

test("explicit legacy audio shadow keeps its listening cue and pre-answer player", () => {
  const shadow = {
    ...base,
    mode: "audio_shadow",
    prompt_type: "audio_shadow",
    prompt: "Listen once, then shadow the Spanish.",
    source_audio_url: "https://api.example/audio.mp3",
  };
  const presentation = recallPromptPresentation(shadow, "audio_shadow", true);
  assert.equal(presentation.cue, shadow.prompt);
  assert.equal(presentation.cueKind, "audio_shadow");
  assert.equal(presentation.showSourceAudio, true);
  assert.equal(presentation.expectsSourceAudio, true);
  assert.equal(presentation.sourceAudioUnavailable, false);
});

test("explicit audio shadow falls back to English when playback is unavailable", () => {
  const shadow = {
    ...base,
    mode: "audio_shadow",
    prompt_type: "audio_shadow",
    prompt: "Listen once, then shadow the Spanish.",
    source_audio_url: "https://api.example/audio.mp3",
  };
  const presentation = recallPromptPresentation(shadow, "audio_shadow", false);
  assert.equal(presentation.cue, base.english);
  assert.equal(presentation.cueKind, "english");
  assert.equal(presentation.showSourceAudio, false);
  assert.equal(presentation.expectsSourceAudio, true);
  assert.equal(presentation.sourceAudioUnavailable, true);
});

test("explicit cloze mode retains its cloze cue without source audio", () => {
  const cloze = { ...base, mode: "cloze", prompt_type: "cloze", source_audio_url: "https://api.example/audio.mp3" };
  const presentation = recallPromptPresentation(cloze, "cloze", true);
  assert.equal(presentation.cue, base.cloze_prompt);
  assert.equal(presentation.cueKind, "cloze");
  assert.equal(presentation.showSourceAudio, false);
});
