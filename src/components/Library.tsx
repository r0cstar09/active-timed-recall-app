import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Card, Phrase, Source } from "../lib/types";
import { isStatusFailed, isStatusReady } from "../lib/types";
import AudioPlayer from "./AudioPlayer";
import { REGIONS, RegionArt, StateIllustration, regionForIndex } from "../lib/visuals";

type Tab = "sources" | "cards";

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
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        if (tab === "sources" && !sources) {
          setSources(await api.listSources());
        } else if (tab === "cards" && !cards) {
          setCards(await api.listCards());
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    })();
  }, [tab, sources, cards]);

  function handleSourceCardRemoved(sourceId: number, phraseId: number) {
    setSources((current) => current?.map((source) => source.id === sourceId
      ? { ...source, active_count: Math.max(0, source.active_count - 1) }
      : source) ?? null);
    setCards((current) => current?.filter((card) => card.phrase_id !== phraseId) ?? null);
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
          cards={cards}
          onRemoved={(phraseId) => setCards((current) => current?.filter((card) => card.phrase_id !== phraseId) ?? null)}
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
                        Delete card
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
                          {removingId === p.id ? "Deleting…" : "Yes, delete card"}
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

function Cards({ cards, onRemoved }: { cards: Card[] | null; onRemoved: (phraseId: number) => void }) {
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function removeCard(card: Card) {
    if (!window.confirm(`Delete “${card.spanish}” from future practice?\n\nIts existing review history will be preserved.`)) return;
    setRemovingId(card.phrase_id);
    setRemoveError(null);
    try {
      await api.removeCard(card.phrase_id);
      onRemoved(card.phrase_id);
    } catch (err) {
      setRemoveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRemovingId(null);
    }
  }

  if (!cards) return <div className="card center stack"><StateIllustration type="loading" /><p className="faint">Loading cards…</p></div>;
  if (cards.length === 0) {
    return (
      <div className="card center stack">
        <StateIllustration type="empty" />
        <p className="muted">No cards yet.</p>
        <a className="btn btn-primary" href="/ingest">Ingest a video</a>
      </div>
    );
  }
  return (
    <>
      {removeError && <div className="alert alert-error">Could not remove card: {removeError}</div>}
      {cards.map((c) => (
        <div className="card card-tight stack" key={c.phrase_id}>
          <div className="row between">
            <div style={{ fontWeight: 600 }}>{c.spanish}</div>
            <span className="pill">{c.state}</span>
          </div>
          <div className="small faint">{c.english}</div>
          {c.context_clue && <div className="small faint">{c.context_clue}</div>}
          <div className="row wrap small faint" style={{ gap: 8 }}>
            <span>due {new Date(c.due_at).toLocaleDateString()}</span>
            <span>· {c.reps} reps</span>
            <span>· {c.lapses} lapses</span>
          </div>
          <AudioPlayer src={c.audio_url} />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button
              className="btn btn-small btn-danger"
              type="button"
              disabled={removingId === c.phrase_id}
              onClick={() => removeCard(c)}
            >
              {removingId === c.phrase_id ? "Deleting…" : "Delete card"}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
