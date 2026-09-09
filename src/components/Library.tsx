import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { curationApi, CurationApiError } from "../lib/curationApi";
import type { CurationLibraryCard } from "../lib/curationTypes";
import type { Phrase, Source } from "../lib/types";
import { isStatusFailed, isStatusReady } from "../lib/types";
import AudioPlayer from "./AudioPlayer";
import { REGIONS, RegionArt, StateIllustration, regionForIndex } from "../lib/visuals";

type Tab = "sources" | "cards";
type CardView = "active" | "archived";

function StatusPill({ label, status }: { label: string; status: string | null }) {
  const cls = isStatusReady(status)
    ? "pill-good"
    : isStatusFailed(status)
      ? "pill-bad"
      : "pill-warn";
  return (
    <span className={`pill ${cls}`}>
      {label}: {status ?? "—"}
    </span>
  );
}

export default function Library() {
  const [tab, setTab] = useState<Tab>("sources");
  const [sources, setSources] = useState<Source[] | null>(null);
  const [activeCards, setActiveCards] = useState<CurationLibraryCard[] | null>(null);
  const [archivedCards, setArchivedCards] = useState<CurationLibraryCard[] | null>(null);
  const [cardView, setCardView] = useState<CardView>("active");
  const [cardSearch, setCardSearch] = useState("");
  const [targetPhraseId, setTargetPhraseId] = useState<number | null>(null);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [cardsReload, setCardsReload] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        if (tab === "sources" && !sources) {
          setSources(await api.listSources());
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    })();
  }, [tab, sources]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("q");
    const phrase = params.get("phrase");
    if (query) setCardSearch(query);
    if (phrase && /^\d+$/.test(phrase)) setTargetPhraseId(Number(phrase));
    if (query || phrase) setTab("cards");
  }, []);

  useEffect(() => {
    if (tab !== "cards") return;
    let cancelled = false;
    setCardsLoading(true);
    setCardsError(null);
    Promise.all([curationApi.listCards(true), curationApi.listCards(false)])
      .then(([active, archived]) => {
        if (cancelled) return;
        setActiveCards(active);
        setArchivedCards(archived);
      })
      .catch((err) => {
        if (!cancelled) setCardsError(err instanceof CurationApiError ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setCardsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, cardsReload]);

  useEffect(() => {
    if (targetPhraseId === null || !activeCards || !archivedCards) return;
    if (archivedCards.some((card) => card.phrase_id === targetPhraseId)) setCardView("archived");
    else if (activeCards.some((card) => card.phrase_id === targetPhraseId)) setCardView("active");
  }, [activeCards, archivedCards, targetPhraseId]);

  useEffect(() => {
    if (tab !== "cards" || targetPhraseId === null) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`library-card-${targetPhraseId}`)?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [cardView, tab, targetPhraseId, activeCards, archivedCards]);

  function adjustSourceActiveCount(sourceId: number | null | undefined, delta: number) {
    if (sourceId == null) return;
    setSources((current) => current?.map((source) => source.id === sourceId
      ? { ...source, active_count: Math.max(0, source.active_count + delta) }
      : source) ?? null);
  }

  function handleSourceCardRemoved(sourceId: number, phraseId: number) {
    setSources((current) => current?.map((source) => source.id === sourceId
      ? { ...source, active_count: Math.max(0, source.active_count - 1) }
      : source) ?? null);
    setActiveCards((current) => current?.filter((card) => card.phrase_id !== phraseId) ?? null);
    setArchivedCards(null);
  }

  function handleCardRemoved(card: CurationLibraryCard) {
    setActiveCards((current) => current?.filter((item) => item.phrase_id !== card.phrase_id) ?? null);
    setArchivedCards((current) => current && !current.some((item) => item.phrase_id === card.phrase_id)
      ? [{ ...card, active: false }, ...current]
      : current);
    adjustSourceActiveCount(card.source_id, -1);
  }

  function handleCardRestored(card: CurationLibraryCard) {
    setArchivedCards((current) => current?.filter((item) => item.phrase_id !== card.phrase_id) ?? null);
    setActiveCards((current) => current && !current.some((item) => item.phrase_id === card.phrase_id)
      ? [{ ...card, active: true }, ...current]
      : current);
    adjustSourceActiveCount(card.source_id, 1);
  }

  return (
    <div className="stack">
      <div className="seg">
        <button
          className={`seg-btn ${tab === "sources" ? "active" : ""}`}
          onClick={() => setTab("sources")}
        >
          Sources
        </button>
        <button
          className={`seg-btn ${tab === "cards" ? "active" : ""}`}
          onClick={() => setTab("cards")}
        >
          Cards
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {tab === "sources" && <RegionCards />}
      {tab === "sources" && <Sources sources={sources} onCardRemoved={handleSourceCardRemoved} />}
      {tab === "cards" && (
        <Cards
          activeCards={activeCards}
          archivedCards={archivedCards}
          cardView={cardView}
          search={cardSearch}
          targetPhraseId={targetPhraseId}
          loading={cardsLoading}
          loadError={cardsError}
          onCardViewChange={setCardView}
          onSearchChange={setCardSearch}
          onRetry={() => setCardsReload((value) => value + 1)}
          onRemoved={handleCardRemoved}
          onRestored={handleCardRestored}
        />
      )}
    </div>
  );
}

function RegionCards() {
  return (
    <div className="region-card-strip" aria-label="Flavor regions">
      {REGIONS.map((r) => (
        <article key={r.key} className="region-mini-card" style={{ "--region-accent": r.accent } as React.CSSProperties}>
          <RegionArt region={r.key} small />
          <strong>{r.name}</strong>
          <small>{r.landmark}</small>
        </article>
      ))}
    </div>
  );
}

function Sources({
  sources,
  onCardRemoved,
}: {
  sources: Source[] | null;
  onCardRemoved: (sourceId: number, phraseId: number) => void;
}) {
  const [openSourceId, setOpenSourceId] = useState<number | null>(null);
  const [phrasesBySource, setPhrasesBySource] = useState<Record<number, Phrase[]>>({});
  const [loadingSourceId, setLoadingSourceId] = useState<number | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function toggleSource(sourceId: number) {
    setConfirmingId(null);
    setNotice(null);
    if (openSourceId === sourceId) {
      setOpenSourceId(null);
      return;
    }
    setOpenSourceId(sourceId);
    setSourceError(null);
    if (phrasesBySource[sourceId]) return;
    setLoadingSourceId(sourceId);
    try {
      const phrases = await api.listSourcePhrases(sourceId);
      setPhrasesBySource((prev) => ({ ...prev, [sourceId]: phrases }));
    } catch (err) {
      setSourceError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoadingSourceId(null);
    }
  }

  async function removeSourceCard(sourceId: number, phrase: Phrase) {
    setRemovingId(phrase.id);
    setSourceError(null);
    setNotice(null);
    try {
      await api.removeCard(phrase.id);
      setPhrasesBySource((previous) => ({
        ...previous,
        [sourceId]: (previous[sourceId] ?? []).map((item) => item.id === phrase.id
          ? { ...item, active: false }
          : item),
      }));
      onCardRemoved(sourceId, phrase.id);
      setConfirmingId(null);
      setNotice(`“${phrase.spanish}” was removed from active study. Its review history was kept.`);
    } catch (err) {
      setSourceError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRemovingId(null);
    }
  }

  if (!sources) return <div className="card center stack"><StateIllustration type="loading" /><p className="faint">Loading sources…</p></div>;
  if (sources.length === 0) {
    return (
      <div className="card center stack">
        <StateIllustration type="empty" />
        <p className="muted">No sources yet.</p>
        <a className="btn btn-primary" href="/ingest">Ingest your first video</a>
      </div>
    );
  }
  return (
    <>
      {sources.map((s, i) => {
        const isOpen = openSourceId === s.id;
        const phrases = phrasesBySource[s.id] ?? [];
        return (
        <div className="card stack source-region-card" key={s.id} style={{ "--region-accent": regionForIndex(i).accent } as React.CSSProperties}>
          <RegionArt region={regionForIndex(i).key} small />
          <div>
            <div style={{ fontWeight: 600 }}>{s.title ?? s.source_url}</div>
            <div className="small faint">
              {[s.channel, s.language, s.source_type].filter(Boolean).join(" · ")}
            </div>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="pill">{s.active_count}/{s.phrase_count} active</span>
            <StatusPill label="transcript" status={s.transcript_status} />
            <StatusPill label="audio" status={s.audio_status} />
          </div>
          <div className="small faint">
            Added {new Date(s.created_at).toLocaleDateString()}
          </div>
          <button className="btn btn-small" type="button" onClick={() => toggleSource(s.id)}>
            {isOpen ? "Hide source cards" : `Load source cards (${s.phrase_count})`}
          </button>
          {isOpen && (
            <div className="stack">
              {loadingSourceId === s.id && <div className="alert">Loading cards for this source…</div>}
              {sourceError && <div className="alert alert-error">{sourceError}</div>}
              {notice && <div className="alert alert-success" role="status">{notice}</div>}
              {!loadingSourceId && phrases.length === 0 && !sourceError && (
                <div className="alert">No cards returned for this source.</div>
              )}
              {phrases.map((p) => (
                <div className="card card-tight stack" key={p.id}>
                  <div className="row between">
                    <div style={{ fontWeight: 600 }}>{p.spanish}</div>
                    <span className={`pill ${p.active ? "pill-good" : "pill-warn"}`}>{p.active ? "active" : "inactive"}</span>
                  </div>
                  <div className="small faint">{p.english}</div>
                  {p.context_clue && <div className="small faint">{p.context_clue}</div>}
                  {p.cloze_prompt && <div className="small faint"><strong>Cloze:</strong> {p.cloze_prompt}</div>}
                  {p.audio_url && <AudioPlayer src={p.audio_url} />}
                  {p.active && confirmingId !== p.id && (
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button className="btn btn-small btn-danger" type="button" onClick={() => setConfirmingId(p.id)}>
                        Remove from active study
                      </button>
                    </div>
                  )}
                  {p.active && confirmingId === p.id && (
                    <div className="remove-confirm" role="group" aria-label={`Confirm removal of ${p.spanish}`}>
                      <span>Remove this card from future study? History will be preserved.</span>
                      <div className="row wrap">
                        <button className="btn btn-small" type="button" onClick={() => setConfirmingId(null)} disabled={removingId === p.id}>
                          Keep card
                        </button>
                        <button className="btn btn-small btn-danger" type="button" onClick={() => removeSourceCard(s.id, p)} disabled={removingId === p.id}>
                          {removingId === p.id ? "Removing…" : "Yes, remove from active study"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        );
      })}
    </>
  );
}

type CardAction = "remove" | "restore" | "repair";

function actionErrorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof CurationApiError
    ? error.message
    : String(error);
}

function Cards({
  activeCards,
  archivedCards,
  cardView,
  search,
  targetPhraseId,
  loading,
  loadError,
  onCardViewChange,
  onSearchChange,
  onRetry,
  onRemoved,
  onRestored,
}: {
  activeCards: CurationLibraryCard[] | null;
  archivedCards: CurationLibraryCard[] | null;
  cardView: CardView;
  search: string;
  targetPhraseId: number | null;
  loading: boolean;
  loadError: string | null;
  onCardViewChange: (view: CardView) => void;
  onSearchChange: (value: string) => void;
  onRetry: () => void;
  onRemoved: (card: CurationLibraryCard) => void;
  onRestored: (card: CurationLibraryCard) => void;
}) {
  const actionLocks = useRef(new Set<number>());
  const [actions, setActions] = useState<Record<number, CardAction>>({});
  const [actionErrors, setActionErrors] = useState<Record<number, string>>({});
  const cards = cardView === "active" ? activeCards : archivedCards;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleCards = useMemo(() => (cards ?? []).filter((card) => {
    if (card.phrase_id === targetPhraseId) return true;
    if (!normalizedSearch) return true;
    return [card.spanish, card.english, card.context_clue, card.cloze_prompt, card.source_type]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
  }), [cards, normalizedSearch, targetPhraseId]);

  function beginAction(phraseId: number, action: CardAction): boolean {
    if (actionLocks.current.has(phraseId)) return false;
    actionLocks.current.add(phraseId);
    setActions((current) => ({ ...current, [phraseId]: action }));
    setActionErrors((current) => {
      const next = { ...current };
      delete next[phraseId];
      return next;
    });
    return true;
  }

  function finishAction(phraseId: number) {
    actionLocks.current.delete(phraseId);
    setActions((current) => {
      const next = { ...current };
      delete next[phraseId];
      return next;
    });
  }

  function failAction(phraseId: number, error: unknown) {
    setActionErrors((current) => ({ ...current, [phraseId]: actionErrorMessage(error) }));
  }

  async function removeCard(card: CurationLibraryCard) {
    if (!window.confirm(`Remove “${card.spanish}” from active study?\n\nIts source and existing review history will be preserved.`)) return;
    if (!beginAction(card.phrase_id, "remove")) return;
    try {
      await api.removeCard(card.phrase_id);
      onRemoved(card);
    } catch (error) {
      failAction(card.phrase_id, error);
    } finally {
      finishAction(card.phrase_id);
    }
  }

  async function restoreCard(card: CurationLibraryCard) {
    if (!beginAction(card.phrase_id, "restore")) return;
    try {
      await curationApi.reactivateCard(card.phrase_id);
      onRestored(card);
    } catch (error) {
      failAction(card.phrase_id, error);
    } finally {
      finishAction(card.phrase_id);
    }
  }

  async function repairCard(card: CurationLibraryCard) {
    if (!beginAction(card.phrase_id, "repair")) return;
    try {
      const draft = await curationApi.createRepairDraft(card.phrase_id);
      if (!Number.isFinite(draft.import_id) || !Number.isFinite(draft.id)) {
        throw new Error("The repair draft response did not include a valid import and draft ID.");
      }
      window.location.assign(`/ingest/?import=${encodeURIComponent(String(draft.import_id))}&draft=${encodeURIComponent(String(draft.id))}`);
    } catch (error) {
      failAction(card.phrase_id, error);
      finishAction(card.phrase_id);
    }
  }

  return (
    <div className="stack">
      <div className="seg" role="tablist" aria-label="Card status">
        <button
          className={`seg-btn ${cardView === "active" ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={cardView === "active"}
          onClick={() => onCardViewChange("active")}
        >
          Active ({activeCards?.length ?? "…"})
        </button>
        <button
          className={`seg-btn ${cardView === "archived" ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={cardView === "archived"}
          onClick={() => onCardViewChange("archived")}
        >
          Archived ({archivedCards?.length ?? "…"})
        </button>
      </div>

      <div className="row wrap">
        <label style={{ flex: "1 1 220px" }}>
          <span className="small faint">Search cards</span>
          <input
            className="input"
            type="search"
            value={search}
            placeholder="Spanish, English, or source"
            onChange={(event) => onSearchChange(event.currentTarget.value)}
          />
        </label>
        {cardView === "active" && activeCards && activeCards.length > 0 && (
          <a className="btn btn-primary" href="/session?mode=practice">Study active cards</a>
        )}
      </div>

      {loadError && (
        <div className="alert alert-error" role="alert">
          <div>Could not load cards: {loadError}</div>
          <button className="btn btn-small" type="button" onClick={onRetry} disabled={loading}>
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {loading && !cards && (
        <div className="card center stack"><StateIllustration type="loading" /><p className="faint">Loading cards…</p></div>
      )}
      {!loading && cards && cards.length === 0 && (
        <div className="card center stack">
          <StateIllustration type="empty" />
          <p className="muted">{cardView === "active" ? "No active cards yet." : "No archived cards."}</p>
          {cardView === "active" && <a className="btn btn-primary" href="/ingest">Ingest a video</a>}
        </div>
      )}
      {cards && cards.length > 0 && visibleCards.length === 0 && (
        <div className="alert">No {cardView} cards match “{search}”.</div>
      )}

      {visibleCards.map((card) => {
        const action = actions[card.phrase_id];
        const isBusy = Boolean(action);
        const isTarget = card.phrase_id === targetPhraseId;
        return (
          <div
            className="card card-tight stack"
            id={`library-card-${card.phrase_id}`}
            key={card.phrase_id}
            style={isTarget ? { outline: "2px solid var(--accent, currentColor)", outlineOffset: 2 } : undefined}
          >
            <div className="row between">
              <div style={{ fontWeight: 600 }}>{card.spanish}</div>
              <span className={`pill ${cardView === "active" ? "pill-good" : "pill-warn"}`}>
                {cardView === "active" ? (card.state ?? "active") : "archived"}
              </span>
            </div>
            <div className="small faint">{card.english}</div>
            {card.context_clue && <div className="small faint">{card.context_clue}</div>}
            {card.cloze_prompt && <div className="small faint"><strong>Cloze:</strong> {card.cloze_prompt}</div>}
            <div className="row wrap small faint" style={{ gap: 8 }}>
              {card.due_at && <span>due {new Date(card.due_at).toLocaleDateString()}</span>}
              {typeof card.reps === "number" && <span>· {card.reps} reps</span>}
              {typeof card.lapses === "number" && <span>· {card.lapses} lapses</span>}
            </div>
            {card.audio_url && <AudioPlayer src={card.audio_url} />}
            {actionErrors[card.phrase_id] && (
              <div className="alert alert-error" role="alert">
                {action === "repair" ? "Could not open repair" : cardView === "archived" ? "Could not restore card" : "Could not remove card"}: {actionErrors[card.phrase_id]}
              </div>
            )}
            <div className="row wrap" style={{ justifyContent: "flex-end" }}>
              {cardView === "archived" ? (
                <button
                  className="btn btn-small btn-primary"
                  type="button"
                  disabled={isBusy}
                  onClick={() => restoreCard(card)}
                >
                  {action === "restore" ? "Restoring…" : "Restore"}
                </button>
              ) : (
                <button
                  className="btn btn-small btn-danger"
                  type="button"
                  disabled={isBusy}
                  onClick={() => removeCard(card)}
                >
                  {action === "remove" ? "Removing…" : "Remove from active study"}
                </button>
              )}
              {card.repair_available === true && (
                <button
                  className="btn btn-small"
                  type="button"
                  disabled={isBusy}
                  onClick={() => repairCard(card)}
                >
                  {action === "repair" ? "Opening repair…" : "Repair clip"}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
