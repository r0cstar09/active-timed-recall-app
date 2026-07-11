import type { PipelineProgressData } from "../lib/types";

const STAGES: Record<string, Array<[string, string]>> = {
  ingestion: [
    ["fetching_transcript", "Fetch transcript"],
    ["selecting_phrases", "Select useful phrases"],
    ["fetching_metadata", "Fetch video details"],
    ["downloading_audio", "Download audio"],
    ["slicing_clips", "Create phrase clips"],
    ["saving_cards", "Save cards"],
    ["complete", "Complete"],
  ],
  grading: [
    ["preparing_recordings", "Prepare recordings"],
    ["waiting_for_item_jobs", "Wait for background grading"],
    ["grading_items", "Transcribe and grade answers"],
    ["updating_schedule", "Update review schedule"],
    ["complete", "Complete"],
  ],
};

function duration(seconds?: number): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export default function PipelineProgress({ progress, fallbackStatus = "queued" }: { progress?: PipelineProgressData | null; fallbackStatus?: string }) {
  const pipeline = progress?.pipeline || "ingestion";
  const percent = Math.max(0, Math.min(100, progress?.percent ?? (fallbackStatus === "complete" ? 100 : 2)));
  const stages = STAGES[pipeline] || [];
  const activeIndex = progress ? Math.max(0, progress.stage_index) : 0;
  const eta = duration(progress?.eta_seconds);
  return (
    <div className="stack" aria-live="polite">
      <div className="row between small">
        <strong>{progress?.message || "Waiting for a worker…"}</strong>
        <span>{Math.round(percent)}%</span>
      </div>
      <div role="progressbar" aria-label={`${pipeline} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} style={{ height: 12, borderRadius: 999, overflow: "hidden", background: "var(--border, #d6d6d6)" }}>
        <div style={{ width: `${percent}%`, height: "100%", transition: "width .35s ease", background: "var(--accent, #4f46e5)" }} />
      </div>
      <div className="row wrap small faint" style={{ gap: 12 }}>
        {progress?.current != null && progress?.total != null && <span>{progress.current}/{progress.total} {progress.unit || "items"}</span>}
        {progress?.rate != null && <span>{progress.rate} {progress.rate_unit || "items/s"}</span>}
        {eta && <span>ETA {eta}</span>}
      </div>
      {stages.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          {stages.map(([key, label], i) => {
            const isFailed = progress?.stage === "failed" && i === Math.min(activeIndex, stages.length - 1);
            const done = percent >= 100 || i < activeIndex;
            const current = i === activeIndex && percent < 100;
            return <div key={key} className="row small" style={{ gap: 8, opacity: done || current || isFailed ? 1 : .5 }}>
              <span aria-hidden="true">{isFailed ? "✕" : done ? "✓" : current ? "●" : "○"}</span>
              <span><strong>{current || isFailed ? label : ""}</strong>{!current && !isFailed ? label : ""}</span>
            </div>;
          })}
        </div>
      )}
      <div className="small faint">You can leave this page. The server job keeps running and reconnects when you return.</div>
    </div>
  );
}
