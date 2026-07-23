import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SentencePack, type SentencePackJob } from "../../lib/api";
import AudioPlayer from "../AudioPlayer";

type Props = {
  sourceType: "lesson" | "verb";
  sourceId: string;
  complete: boolean;
  context: Record<string, unknown>;
};

export default function LessonSentencePacks({ sourceType, sourceId, complete, context }: Props) {
  const [packs, setPacks] = useState<SentencePack[]>([]);
  const [job, setJob] = useState<SentencePackJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [promoting, setPromoting] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const requestVersionRef = useRef(0);
  const jobStorageKey = `sentence-pack-job:${sourceType}:${sourceId}`;

  const loadPacks = useCallback(async () => {
    if (!sourceId || !complete) {
      setPacks([]);
      return;
    }
    setPacks(await api.listSentencePacks(sourceType, sourceId));
  }, [sourceType, sourceId, complete]);

  useEffect(() => {
    const requestVersion = ++requestVersionRef.current;
    setBusy(false);
    setPromoting(null);
    setJob(null);
    setMessage(null);
    setError(null);
    loadPacks().catch((err) => {
      if (requestVersionRef.current === requestVersion) setError(err instanceof Error ? err.message : String(err));
    });
    const savedJobId = Number(window.sessionStorage.getItem(jobStorageKey));
    if (complete && Number.isInteger(savedJobId) && savedJobId > 0) {
      setBusy(true);
      void poll(savedJobId, requestVersion);
    }
    return () => {
      requestVersionRef.current += 1;
      if (pollRef.current != null) window.clearTimeout(pollRef.current);
    };
  }, [loadPacks, jobStorageKey, complete]);

  async function poll(jobId: number, requestVersion: number) {
    try {
      const next = await api.getSentencePackJob(jobId);
      if (requestVersionRef.current !== requestVersion) return;
      setJob(next);
      if (next.status === "completed") {
        window.sessionStorage.removeItem(jobStorageKey);
        setBusy(false);
        setMessage(next.progress_message || "Hermes sentence pack ready.");
        await loadPacks();
        if (requestVersionRef.current !== requestVersion) return;
        return;
      }
      if (next.status === "failed") {
        window.sessionStorage.removeItem(jobStorageKey);
        setBusy(false);
        setError(next.error || "Hermes generation failed.");
        return;
      }
      pollRef.current = window.setTimeout(() => poll(jobId, requestVersion), 1800);
    } catch (err) {
      if (requestVersionRef.current !== requestVersion) return;
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function generate() {
    const requestVersion = ++requestVersionRef.current;
    if (pollRef.current != null) window.clearTimeout(pollRef.current);
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await api.generateSentencePack({ source_type: sourceType, source_id: sourceId, context, count: 10 });
      if (requestVersionRef.current !== requestVersion) return;
      setJob(next);
      window.sessionStorage.setItem(jobStorageKey, String(next.id));
      await poll(next.id, requestVersion);
    } catch (err) {
      if (requestVersionRef.current !== requestVersion) return;
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function promote(packId: number) {
    setPromoting(packId);
    setError(null);
    try {
      const result = await api.promoteSentencePack(packId);
      setMessage(`${result.promoted} sentences added to Active Timed Recall.`);
      await loadPacks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPromoting(null);
    }
  }

  if (!complete) {
    return (
      <div className="card stack">
        <div className="spanish-kicker">Hermes sentence lab</div>
        <h3 style={{ margin: 0 }}>Complete this {sourceType} to unlock sentence generation</h3>
        <p className="muted" style={{ margin: 0 }}>The generated sentences will match what you just learned.</p>
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="row between wrap">
        <div>
          <div className="spanish-kicker">Hermes sentence lab</div>
          <h3 style={{ margin: 0 }}>Turn this {sourceType} into speaking reps</h3>
          <p className="muted" style={{ margin: 0 }}>Hermes creates 10 fresh lesson-specific sentences. Early packs build a simple foundation; each later pack becomes progressively harder.</p>
        </div>
        <button className="btn btn-primary" type="button" disabled={busy} onClick={generate}>
          {busy ? "Hermes is working…" : "Generate 10 sentences with Hermes"}
        </button>
      </div>

      {job && busy ? (
        <div className="stack" aria-live="polite">
          <div className="row between small"><span>{job.progress_message || job.status}</span><span>{job.progress_current}/{job.progress_total}</span></div>
          <progress value={job.progress_current} max={Math.max(job.progress_total, 1)} style={{ width: "100%" }} />
        </div>
      ) : null}
      {message ? <div className="alert alert-ok" role="status">{message}</div> : null}
      {error ? <div className="alert alert-error" role="alert">{error}</div> : null}

      {packs.map((pack) => {
        const promoted = pack.items.filter((item) => item.promoted_phrase_id).length;
        return (
          <div className="card stack" key={pack.id}>
            <div className="row between wrap">
              <div>
                <strong>{pack.source_title || `${sourceType} sentence pack`} · {pack.actual_count} sentences</strong>
                <div className="small muted">
                  Pack #{pack.source_context?.generation_sequence ?? pack.id} · {pack.source_context?.difficulty_label ?? pack.source_context?.difficulty_stage ?? "Foundation"}{pack.source_context?.difficulty_cefr ? ` (${pack.source_context.difficulty_cefr})` : ""}
                </div>
              </div>
              <button className="btn btn-small btn-primary" type="button" disabled={promoting === pack.id || promoted === pack.items.length} onClick={() => promote(pack.id)}>
                {promoted === pack.items.length ? "Added to Active Recall" : promoting === pack.id ? "Adding…" : "Add pack to Active Timed Recall"}
              </button>
            </div>
            {pack.items.map((item) => (
              <div className="stack" key={item.id} style={{ borderTop: "1px solid var(--border)", paddingTop: ".75rem" }}>
                <strong>{item.prompt_en}</strong>
                <span lang="es">{item.expected_es}</span>
                {item.coaching_note ? <span className="small muted">{item.coaching_note}</span> : null}
                {item.audio_url ? <AudioPlayer src={item.audio_url} label={`Spanish audio for ${item.prompt_en}`} /> : <span className="small muted">Audio: {item.audio_status}</span>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
