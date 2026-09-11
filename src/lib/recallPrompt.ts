import type { SessionItem, SessionMode } from "./types";

function firstCue(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const cue = String(value ?? "").trim();
    if (cue) return cue;
  }
  return "Say the Spanish answer.";
}

export type RecallCueKind = "english" | "cloze" | "audio_shadow";

export interface RecallPromptPresentation {
  cue: string;
  cueKind: RecallCueKind;
  /** Source audio is the prompt only in an explicitly selected audio-shadow session. */
  expectsSourceAudio: boolean;
  /** Safe to render before the answer is revealed. */
  showSourceAudio: boolean;
  sourceAudioUnavailable: boolean;
}

function englishCue(item: SessionItem): string {
  // Do not let a stale graduated `prompt` (audio instructions, a cloze, or a
  // shared grammar label) replace the sentence's English production cue.
  return firstCue(item.english, item.english_meaning, item.context_clue);
}

/**
 * Decide both the visible cue and whether source-answer audio is safe to show.
 *
 * Normal Review, Practice, and Misses are always English → spoken Spanish,
 * regardless of a stale cached `audio`, `cloze`, or `minimal` prompt type. The
 * only pre-answer source-audio exception is the intentionally selected legacy
 * `audio_shadow` mode. Explicit legacy cloze sessions may still use a cloze.
 */
export function recallPromptPresentation(
  item: SessionItem,
  sessionMode: SessionMode,
  sourceAudioUsable = Boolean(item.source_audio_url),
): RecallPromptPresentation {
  const english = englishCue(item);
  const explicitAudioShadow = sessionMode === "audio_shadow" && item.prompt_type === "audio_shadow";
  const playableSourceAudio = Boolean(item.source_audio_url) && sourceAudioUsable;

  if (explicitAudioShadow && playableSourceAudio) {
    return {
      cue: firstCue(item.prompt, "Listen, then shadow the Spanish."),
      cueKind: "audio_shadow",
      expectsSourceAudio: true,
      showSourceAudio: true,
      sourceAudioUnavailable: false,
    };
  }

  if (explicitAudioShadow) {
    return {
      cue: english,
      cueKind: "english",
      expectsSourceAudio: true,
      showSourceAudio: false,
      sourceAudioUnavailable: true,
    };
  }

  if (sessionMode === "cloze" && item.prompt_type === "cloze") {
    return {
      cue: firstCue(item.cloze_prompt, item.prompt, english),
      cueKind: "cloze",
      expectsSourceAudio: false,
      showSourceAudio: false,
      sourceAudioUnavailable: false,
    };
  }

  return {
    cue: english,
    cueKind: "english",
    expectsSourceAudio: false,
    showSourceAudio: false,
    sourceAudioUnavailable: false,
  };
}

export function recallPromptText(
  item: SessionItem,
  sessionMode: SessionMode = item.mode ?? "review",
  sourceAudioUsable = Boolean(item.source_audio_url),
): string {
  return recallPromptPresentation(item, sessionMode, sourceAudioUsable).cue;
}
