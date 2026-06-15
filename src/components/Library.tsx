import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { Card, Video } from "../lib/types";
import AudioPlayer from "./AudioPlayer";

export default function Library() {
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cards, setCards] = useState<Record<string, Card[]>>({});
  const [loadingCards, setLoadingCards] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      setVideos(await api.listVideos());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setVideos([]);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function toggle(videoId: string) {
    if (expanded === videoId) {
      setExpanded(null);
      return;
    }
    setExpanded(videoId);
    if (!cards[videoId]) {
      setLoadingCards(videoId);
      try {
        const c = await api.listCards(videoId);
        setCards((prev) => ({ ...prev, [videoId]: c }));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setLoadingCards(null);
      }
    }
  }

  async function remove(video: Video) {
    if (!confirm(`Delete "${video.title}" and its ${video.cardCount} cards?`)) {
      return;
    }
    setDeleting(video.id);
    try {
      await api.deleteVideo(video.id);
      setVideos((prev) => (prev ? prev.filter((v) => v.id !== video.id) : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  }

  if (error && !videos) {
    return <div className="alert alert-error">{error}</div>;
  }
  if (!videos) {
    return <div className="card center faint">Loading library…</div>;
  }
  if (videos.length === 0) {
    return (
      <div className="card center stack">
        <p className="muted">No videos yet.</p>
        <a className="btn btn-primary" href="/ingest">
          Ingest your first video
        </a>
      </div>
    );
  }

  return (
    <div className="stack">
      {error && <div className="alert alert-error">{error}</div>}
      {videos.map((v) => (
        <div className="card" key={v.id}>
          <div className="row between">
            <button
              className="btn btn-ghost"
              style={{ flex: 1, justifyContent: "flex-start", padding: 0, border: 0, minHeight: 0 }}
              onClick={() => toggle(v.id)}
              aria-expanded={expanded === v.id}
            >
              <div style={{ textAlign: "left" }}>
                <div style={{ fontWeight: 600 }} className="truncate">
                  {v.title}
                </div>
                <div className="small faint">
                  {v.cardCount} cards · {v.sentenceCount} sentences
                </div>
              </div>
            </button>
            <button
              className="btn btn-danger"
              style={{ minHeight: 40, padding: "8px 12px" }}
              onClick={() => remove(v)}
              disabled={deleting === v.id}
            >
              {deleting === v.id ? "…" : "Delete"}
            </button>
          </div>

          {expanded === v.id && (
            <div className="stack" style={{ marginTop: 14 }}>
              {loadingCards === v.id && (
                <div className="small faint">Loading cards…</div>
              )}
              {(cards[v.id] ?? []).map((c) => (
                <div className="card card-tight" key={c.id}>
                  <div style={{ fontWeight: 600 }}>{c.targetText}</div>
                  {c.promptText && (
                    <div className="small faint">{c.promptText}</div>
                  )}
                  <AudioPlayer src={c.nativeAudioUrl} />
                </div>
              ))}
              {cards[v.id]?.length === 0 && (
                <div className="small faint">No cards for this video.</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
