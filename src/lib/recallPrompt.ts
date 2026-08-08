import type { SessionItem } from "./types";

function firstCue(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const cue = String(value ?? "").trim();
    if (cue) return cue;
  }
  return "Say the Spanish answer.";
}

/**
 * Return a sentence-specific recall cue.
 *
 * `minimal` is retained only for stale browser payloads; the backend no longer
 * emits it because a shared grammar label cannot identify one sentence. Audio
 * prompts also fall back to English whenever the clip is absent or has failed.
 */
export function recallPromptText(
  item: SessionItem,
  sourceAudioUsable = Boolean(item.source_audio_url),
): string {
  const englishCue = firstCue(item.english, item.english_meaning, item.context_clue, item.prompt);

  if (item.prompt_type === "minimal") return englishCue;
  if ((item.prompt_type === "audio" || item.prompt_type === "audio_shadow") && !sourceAudioUsable) {
    return englishCue;
  }
  if (item.prompt_type === "cloze") {
    return firstCue(item.cloze_prompt, item.prompt, englishCue);
  }
  return firstCue(item.prompt, englishCue);
}
