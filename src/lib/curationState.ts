import type {
  CurationDraft,
  CurationImport,
  TranscriptSegment,
} from "./curationTypes";

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function canonicalYouTubeVideoId(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    let id = "";
    if (host === "youtu.be") id = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    else if (host === "youtube.com" || host === "m.youtube.com") {
      if (parsed.pathname === "/watch") id = parsed.searchParams.get("v") ?? "";
      else {
        const [kind, candidate] = parsed.pathname.split("/").filter(Boolean);
        if (kind === "shorts" || kind === "embed") id = candidate ?? "";
      }
    }
    return YOUTUBE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function toggleContiguousSegment(
  current: number[],
  index: number,
): { indices: number[]; error: string | null } {
  const sorted = [...new Set(current)].sort((a, b) => a - b);
  const at = sorted.indexOf(index);
  if (at >= 0) {
    if (sorted.length === 1) return { indices: [], error: null };
    if (at !== 0 && at !== sorted.length - 1) {
      return { indices: sorted, error: "Remove a line from either end so the selection stays adjacent." };
    }
    return { indices: sorted.filter((candidate) => candidate !== index), error: null };
  }
  if (sorted.length === 0 || index === sorted[0] - 1 || index === sorted[sorted.length - 1] + 1) {
    return { indices: [...sorted, index].sort((a, b) => a - b), error: null };
  }
  return { indices: sorted, error: "Choose a line adjacent to the current selection, or clear it and start a new phrase." };
}

export function selectedSegmentText(segments: TranscriptSegment[], indices: number[]): string {
  const wanted = new Set(indices);
  return segments
    .filter((item) => wanted.has(item.index))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function newerDraft(current: CurationDraft | undefined, incoming: CurationDraft): CurationDraft {
  if (!current) return incoming;
  if (incoming.revision > current.revision) return incoming;
  if (incoming.revision < current.revision) return current;
  return timestamp(incoming.updated_at) >= timestamp(current.updated_at) ? incoming : current;
}

/** Merge polling data without allowing an older response to undo a mutation ack. */
export function mergeImportSnapshot(
  current: CurationImport | null,
  incoming: CurationImport,
): CurationImport {
  if (!current || current.id !== incoming.id) return incoming;
  const byId = new Map(current.drafts.map((item) => [item.id, item]));
  for (const item of incoming.drafts ?? []) byId.set(item.id, newerDraft(byId.get(item.id), item));
  // Keep current-only drafts: a GET started before createDrafts returned may be
  // missing the just-created row. Explicit delete handlers remove rows locally.
  const drafts = [...byId.values()].sort((left, right) => left.id - right.id);
  return { ...current, ...incoming, drafts };
}

export type DraftEditorField = "spanish" | "english" | "start_time" | "end_time";

export interface DraftEditorState {
  id: number;
  baseRevision: number;
  spanish: string;
  english: string;
  start_time: number;
  end_time: number;
  dirtyFields: DraftEditorField[];
  server: CurationDraft;
}

export function createDraftEditorState(draft: CurationDraft): DraftEditorState {
  return {
    id: draft.id,
    baseRevision: draft.revision,
    spanish: draft.spanish,
    english: draft.english,
    start_time: draft.start_time,
    end_time: draft.end_time,
    dirtyFields: [],
    server: draft,
  };
}

/**
 * Polling may refresh status/audio while an edit is in progress, but local field
 * values and the revision they were based on remain authoritative until save.
 */
export function reconcileDraftEditor(
  current: DraftEditorState,
  incoming: CurationDraft,
): DraftEditorState {
  if (current.id !== incoming.id || current.dirtyFields.length === 0) return createDraftEditorState(incoming);
  const dirty = new Set(current.dirtyFields);
  return {
    ...current,
    spanish: dirty.has("spanish") ? current.spanish : incoming.spanish,
    english: dirty.has("english") ? current.english : incoming.english,
    start_time: dirty.has("start_time") ? current.start_time : incoming.start_time,
    end_time: dirty.has("end_time") ? current.end_time : incoming.end_time,
    server: incoming,
  };
}

export interface ActionGate {
  tryAcquire(key: string): boolean;
  release(key: string): void;
  isLocked(key?: string): boolean;
}

export function createActionGate(): ActionGate {
  const locked = new Set<string>();
  return {
    tryAcquire(key) {
      if (locked.has(key)) return false;
      locked.add(key);
      return true;
    },
    release(key) {
      locked.delete(key);
    },
    isLocked(key) {
      return key ? locked.has(key) : locked.size > 0;
    },
  };
}

export function importNeedsPolling(item: CurationImport | null | undefined): boolean {
  return Boolean(item && (
    item.status === "queued"
    || item.status === "loading"
    || item.drafts?.some((draft) => draft.status === "queued" || draft.status === "preparing")
  ));
}

export function curationDeepLink(importId: number, draftId?: number | null): string {
  const params = new URLSearchParams({ import: String(importId) });
  if (draftId != null) params.set("draft", String(draftId));
  return `/ingest/?${params.toString()}`;
}
