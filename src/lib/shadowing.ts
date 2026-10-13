import { canonicalYouTubeVideoId } from "./curationState.ts";
import type { CurationLibraryCard } from "./curationTypes.ts";

export const STORAGE_KEY = "atr.shadow.v1";

export interface ShadowPreferences {
  rate: number;
  gapSeconds: number;
  mode: "repeat" | "along";
  showSpanish: boolean;
}

export const DEFAULT_PREFERENCES: ShadowPreferences = Object.freeze({
  rate: 0.75,
  gapSeconds: 3,
  mode: "repeat",
  showSpanish: true,
});

export interface ShadowSaved {
  version: 1;
  clipId: number | null;
  preferences: ShadowPreferences;
}

export type ShadowProvenance = "imported" | "generated" | "unknown";

const MAX_PLAYBACK_RATE = 4;
const MIN_PLAYBACK_RATE = 0.25;
const MAX_GAP_SECONDS = 60;
const GENERATED_SOURCE_TYPES = new Set([
  "ai_generated",
  "generated",
  "hermes_generated",
  "sentence_pack",
  "sentence_packs",
  "synthetic",
  "text_to_speech",
  "tts",
]);

function defaultSaved(): ShadowSaved {
  return {
    version: 1,
    clipId: null,
    preferences: { ...DEFAULT_PREFERENCES },
  };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validClipId(value: unknown): value is number | null {
  return value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function normalizedPreferences(value: unknown): ShadowPreferences | null {
  const item = plainRecord(value);
  if (!item) return null;
  const { rate, gapSeconds, mode, showSpanish } = item;
  if (
    typeof rate !== "number"
    || !Number.isFinite(rate)
    || rate < MIN_PLAYBACK_RATE
    || rate > MAX_PLAYBACK_RATE
    || typeof gapSeconds !== "number"
    || !Number.isFinite(gapSeconds)
    || gapSeconds < 0
    || gapSeconds > MAX_GAP_SECONDS
    || (mode !== "repeat" && mode !== "along")
    || typeof showSpanish !== "boolean"
  ) {
    return null;
  }
  return { rate, gapSeconds, mode, showSpanish };
}

function normalizedSaved(value: unknown): ShadowSaved | null {
  const item = plainRecord(value);
  if (!item || item.version !== 1 || !validClipId(item.clipId)) return null;
  const preferences = normalizedPreferences(item.preferences);
  if (!preferences) return null;
  return { version: 1, clipId: item.clipId, preferences };
}

/** Read only the small, versioned shadowing resume record. */
export function readShadow(storage: Pick<Storage, "getItem">): ShadowSaved {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return defaultSaved();
    return normalizedSaved(JSON.parse(raw)) ?? defaultSaved();
  } catch {
    return defaultSaved();
  }
}

/**
 * Persist a deliberately minimal record. Runtime-invalid callers are rejected,
 * and quota/privacy-mode storage failures remain non-fatal to practice.
 */
export function saveShadow(
  storage: Pick<Storage, "setItem">,
  value: ShadowSaved,
): boolean {
  try {
    const saved = normalizedSaved(value);
    if (!saved) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

/**
 * Allow network media URLs, or the source-audio endpoint when the API URL is
 * same-origin. Protocol-relative URLs, credentials, executable schemes, and
 * unrelated relative endpoints are rejected.
 */
export function safeAudioUrl(value: string): string {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  if (!candidate || /[\u0000-\u001f\u007f\\]/.test(candidate)) return "";

  try {
    if (candidate.startsWith("/")) {
      if (candidate.startsWith("//")) return "";
      const parsed = new URL(candidate, "https://shadow.invalid");
      if (!parsed.pathname.startsWith("/api/audio/source/") || parsed.pathname === "/api/audio/source/") {
        return "";
      }
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }

    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || !parsed.hostname
      || parsed.username
      || parsed.password
    ) {
      return "";
    }
    return parsed.href;
  } catch {
    return "";
  }
}

function sourceType(card: CurationLibraryCard): string {
  return typeof card.source_type === "string"
    ? card.source_type.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function audioPath(value: string): string {
  try {
    const parsed = value.startsWith("/")
      ? new URL(value, "https://shadow.invalid")
      : new URL(value);
    try {
      return decodeURIComponent(parsed.pathname).toLowerCase();
    } catch {
      return parsed.pathname.toLowerCase();
    }
  } catch {
    return "";
  }
}

function hasSyntheticAudioPath(value: string): boolean {
  const path = audioPath(value);
  return /(?:^|\/)synthetic(?:\/|$)/.test(path)
    || /(?:^|\/)(?:tts|text[_-]to[_-]speech)(?:\/|$)/.test(path);
}

function isGenerated(card: CurationLibraryCard, audio: string): boolean {
  if (GENERATED_SOURCE_TYPES.has(sourceType(card))) return true;
  const sourceUrl = typeof card.source_url === "string" ? card.source_url.trim().toLowerCase() : "";
  if (/^(?:sentence-packs?|synthetic|tts):\/\//.test(sourceUrl)) return true;
  return Boolean(audio && hasSyntheticAudioPath(audio));
}

/** Classify only provenance that can be established from card metadata. */
export function provenance(card: CurationLibraryCard): ShadowProvenance {
  const audio = safeAudioUrl(card?.audio_url);
  if (isGenerated(card, audio)) return "generated";
  if (
    sourceType(card) === "youtube"
    && audio
    && typeof card.source_url === "string"
    && canonicalYouTubeVideoId(card.source_url) !== null
  ) {
    return "imported";
  }
  return "unknown";
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Return safe active practice candidates without mutating API objects. First
 * valid IDs win, and stable partitioning puts conservatively imported audio
 * first while retaining cards whose audio needs repair.
 */
export function activeClips(cards: CurationLibraryCard[]): CurationLibraryCard[] {
  if (!Array.isArray(cards)) return [];
  const seen = new Set<number>();
  const imported: CurationLibraryCard[] = [];
  const other: CurationLibraryCard[] = [];

  for (const raw of cards) {
    if (!raw || typeof raw !== "object") continue;
    const id = raw.phrase_id;
    if (
      raw.active !== true
      || !Number.isSafeInteger(id)
      || id <= 0
      || seen.has(id)
      || !validText(raw.spanish)
      || !validText(raw.english)
    ) {
      continue;
    }
    seen.add(id);
    const card: CurationLibraryCard = {
      ...raw,
      audio_url: safeAudioUrl(raw.audio_url),
    };
    (provenance(card) === "imported" ? imported : other).push(card);
  }

  return [...imported, ...other];
}

/** Reconcile a saved ID with the current active library and playable fallbacks. */
export function pickClip(
  cards: CurationLibraryCard[],
  savedId: number | null,
): CurationLibraryCard | null {
  const active = activeClips(cards);
  if (Number.isSafeInteger(savedId) && (savedId as number) > 0) {
    const restored = active.find((card) => card.phrase_id === savedId);
    if (restored) return restored;
  }
  return active.find((card) => Boolean(card.audio_url) && provenance(card) === "imported")
    ?? active.find((card) => Boolean(card.audio_url))
    ?? active[0]
    ?? null;
}
