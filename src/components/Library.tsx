import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Card, Source } from "../lib/types";
import { isStatusFailed, isStatusReady } from "../lib/types";
import AudioPlayer from "./AudioPlayer";

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

      {tab === "sources" && <Sources sources={sources} />}
      {tab === "cards" && <Cards cards={cards} />}
    </div>
  );
}

function Sources({ sources }: { sources: Source[] | null }) {
  if (!sources) return <div className="card center faint">Loading sources…</div>;
  if (sources.length === 0) {
    return (
      <div className="card center stack">
        <p className="muted">No sources yet.</p>
        <a className="btn btn-primary" href="/ingest">Ingest your first video</a>
      </div>
    );
  }
  return (
    <>
      {sources.map((s) => (
        <div className="card stack" key={s.id}>
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
        </div>
      ))}
    </>
  );
}

function Cards({ cards }: { cards: Card[] | null }) {
  if (!cards) return <div className="card center faint">Loading cards…</div>;
  if (cards.length === 0) {
    return (
      <div className="card center stack">
        <p className="muted">No cards yet.</p>
        <a className="btn btn-primary" href="/ingest">Ingest a video</a>
      </div>
    );
  }
  return (
    <>
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
        </div>
      ))}
    </>
  );
}
