import type { Session } from "./types";

const KEY = "atr.writtenSession";
export type WrittenMode = "learn" | "review" | "practice";
export type WrittenPhase = "learn" | "answer" | "grading" | "results";
export type SavedAnswer = { answer: string; response_seconds: number };
export type WrittenSnapshot = {
  version: 1;
  sessionId: number;
  phraseIds: number[];
  mode: WrittenMode;
  targetVerb: string;
  /** null = deliberate Mix all; absent = legacy/unknown practice scope. */
  practiceTopicId?: string | null;
  index: number;
  phase: WrittenPhase;
  answers: Record<number, SavedAnswer>;
  draft: string;
  promptStartedAt: number;
};

export function loadWrittenSession(): WrittenSnapshot | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as WrittenSnapshot;
    if (saved.version !== 1 || !Number.isSafeInteger(saved.sessionId) || saved.sessionId <= 0 ||
        !Array.isArray(saved.phraseIds) || !saved.phraseIds.length ||
        saved.phraseIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        !["learn", "review", "practice"].includes(saved.mode) ||
        !["learn", "answer", "grading", "results"].includes(saved.phase) ||
        !Number.isInteger(saved.index) || saved.index < 0 || saved.index >= saved.phraseIds.length ||
        typeof saved.draft !== "string" || typeof saved.targetVerb !== "string" ||
        (saved.practiceTopicId !== undefined && saved.practiceTopicId !== null &&
          (typeof saved.practiceTopicId !== "string" || !saved.practiceTopicId.trim())) ||
        !Number.isFinite(saved.promptStartedAt) || saved.promptStartedAt < 0 ||
        !saved.answers || typeof saved.answers !== "object" ||
        Object.values(saved.answers).some(answer => !answer || typeof answer.answer !== "string" ||
          !Number.isFinite(answer.response_seconds) || answer.response_seconds < 0)) throw new Error("Invalid saved batch");
    return saved;
  } catch {
    // Do not silently reset to the Review queue when an existing save is invalid.
    throw new Error("The saved written batch could not be restored. Retry or explicitly exit this batch.");
  }
}

export function saveWrittenSession(saved: WrittenSnapshot): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(saved));
}

export function clearWrittenSession(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(KEY);
}

/** Storage keeps identity/drafts only; server-owned cards and grades are always reloaded. */
export function reconcileWrittenSession(saved: WrittenSnapshot, session: Session): WrittenSnapshot {
  if (session.session_id !== saved.sessionId || session.response_mode !== "written" ||
      (session.target_verb || "") !== saved.targetVerb ||
      session.items.length !== saved.phraseIds.length ||
      session.items.some((item, i) => item.phrase_id !== saved.phraseIds[i])) {
    throw new Error("The saved written batch does not match the server. No other queue cards will be shown.");
  }
  if (session.mode === "learn") {
    const pending = session.items.findIndex(item => (item.result || "pending") === "pending");
    return { ...saved, phase: "learn", index: pending < 0 ? session.items.length - 1 : pending };
  }
  const complete = session.status === "complete" || session.status === "complete_overtime";
  return { ...saved, phase: complete ? "results" : "answer" };
}
