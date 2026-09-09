import { getApiBaseUrl, resolveUrl } from "./config";
import type {
  CurationDraft,
  CurationImport,
  CurationLibraryCard,
  DraftPatch,
  DraftRevisionRef,
  DraftSelection,
  PromoteResponse,
} from "./curationTypes";

export class CurationApiError extends Error {
  status: number;
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "CurationApiError";
    this.status = status;
    this.body = body;
  }
}

function endpoint(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalized}`;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new CurationApiError(
      `Backend returned malformed JSON (${response.status}).`,
      response.status,
      { preview: text.trim().slice(0, 240) },
    );
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpoint(path), {
      ...init,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new CurationApiError(
      `Network error reaching the curation service. Check connectivity and retry. (${error instanceof Error ? error.message : String(error)})`,
      0,
    );
  }

  const body = await responseBody(response);
  if (!response.ok) {
    const detail = body && typeof body === "object" && "detail" in body
      ? String((body as { detail: unknown }).detail)
      : response.statusText || "Request failed";
    throw new CurationApiError(`Request failed (${response.status}): ${detail}`, response.status, body);
  }
  return body as T;
}

function requestJson<T>(path: string, method: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function hydrateDraft(item: CurationDraft): CurationDraft {
  return { ...item, audio_url: item.audio_url ? resolveUrl(item.audio_url) : null };
}

function hydrateImport(item: CurationImport): CurationImport {
  return {
    ...item,
    transcript: Array.isArray(item.transcript) ? item.transcript : [],
    drafts: Array.isArray(item.drafts) ? item.drafts.map(hydrateDraft) : [],
    source_audio_url: item.source_audio_url ? resolveUrl(item.source_audio_url) : null,
  };
}

function arrayFrom<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

export const curationApi = {
  async createImport(sourceUrl: string): Promise<CurationImport> {
    return hydrateImport(await requestJson<CurationImport>("/api/curation/imports", "POST", { url: sourceUrl }));
  },

  async listImports(limit = 50, offset = 0): Promise<{ imports: CurationImport[]; total: number }> {
    const result = await request<{ imports: CurationImport[]; total: number }>(
      `/api/curation/imports?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`,
    );
    return {
      imports: Array.isArray(result?.imports) ? result.imports.map(hydrateImport) : [],
      total: typeof result?.total === "number" ? result.total : 0,
    };
  },

  async getImport(importId: number | string): Promise<CurationImport> {
    return hydrateImport(await request<CurationImport>(
      `/api/curation/imports/${encodeURIComponent(String(importId))}`,
    ));
  },

  async createDrafts(importId: number | string, selections: DraftSelection[]): Promise<CurationDraft[]> {
    const result = await requestJson<{ drafts: CurationDraft[] }>(
      `/api/curation/imports/${encodeURIComponent(String(importId))}/drafts`,
      "POST",
      { selections },
    );
    return (result.drafts ?? []).map(hydrateDraft);
  },

  async patchDraft(draftId: number | string, patch: DraftPatch): Promise<CurationDraft> {
    return hydrateDraft(await requestJson<CurationDraft>(
      `/api/curation/drafts/${encodeURIComponent(String(draftId))}`,
      "PATCH",
      patch,
    ));
  },

  deleteDraft(draftId: number | string, revision: number): Promise<{ ok: true }> {
    return request<{ ok: true }>(
      `/api/curation/drafts/${encodeURIComponent(String(draftId))}?revision=${encodeURIComponent(String(revision))}`,
      { method: "DELETE" },
    );
  },

  async prepareDrafts(drafts: DraftRevisionRef[]): Promise<CurationDraft[]> {
    const result = await requestJson<{ drafts: CurationDraft[] }>("/api/curation/prepare", "POST", { drafts });
    return (result.drafts ?? []).map(hydrateDraft);
  },

  async promoteDrafts(drafts: DraftRevisionRef[]): Promise<PromoteResponse> {
    const result = await requestJson<PromoteResponse>("/api/curation/promote", "POST", { drafts });
    return { ...result, drafts: (result.drafts ?? []).map(hydrateDraft) };
  },

  async createRepairDraft(phraseId: number | string): Promise<CurationDraft> {
    return hydrateDraft(await requestJson<CurationDraft>(
      `/api/cards/${encodeURIComponent(String(phraseId))}/repair`,
      "POST",
      {},
    ));
  },

  async listCards(active: boolean): Promise<CurationLibraryCard[]> {
    const cards: CurationLibraryCard[] = [];
    const requestedLimit = 100;
    let offset = 0;

    while (true) {
      const result = await request<unknown>(
        `/api/cards?active=${active ? "1" : "0"}&limit=${requestedLimit}&offset=${offset}`,
      );
      const page = arrayFrom<CurationLibraryCard>(result, ["cards", "items", "results", "data"]);
      cards.push(...page);

      if (!result || typeof result !== "object" || Array.isArray(result)) break;
      const metadata = result as Record<string, unknown>;
      const total = typeof metadata.total === "number" && Number.isFinite(metadata.total)
        ? Math.max(0, metadata.total)
        : page.length;
      if (cards.length >= total) break;

      const responseOffset = typeof metadata.offset === "number" && Number.isFinite(metadata.offset)
        ? metadata.offset
        : offset;
      const responseLimit = typeof metadata.limit === "number" && Number.isFinite(metadata.limit) && metadata.limit > 0
        ? metadata.limit
        : page.length;
      const nextOffset = responseOffset + responseLimit;
      if (page.length === 0 || nextOffset <= offset) {
        throw new CurationApiError("Backend card pagination ended before all cards were returned.", 0, result);
      }
      offset = nextOffset;
    }

    return cards.map((card) => ({
      ...card,
      active: typeof card.active === "boolean" ? card.active : active,
      audio_url: card.audio_url ? resolveUrl(card.audio_url) : "",
    }));
  },

  reactivateCard(phraseId: number | string): Promise<{ ok: true }> {
    return requestJson<{ ok: true }>(
      `/api/cards/${encodeURIComponent(String(phraseId))}/reactivate`,
      "POST",
      {},
    );
  },
};
