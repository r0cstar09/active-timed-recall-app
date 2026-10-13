import { useEffect, useRef, useState } from "react";
import { clipPositionFromSourceTime, sourceTimeFromClipPosition } from "../lib/clipEditing";

const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

interface AudioPlayheadProps {
  identity: string;
  label: string;
  audioUrl: string;
  /** Absolute source second represented by audio.currentTime === 0. */
  audioSourceOffset: number;
  savedClipStart: number;
  rangeStart: number;
  rangeEnd: number;
  playhead: number;
  onPlayheadChange: (absoluteSourceSeconds: number) => void;
  onSetStart?: (absoluteSourceSeconds: number) => void;
  onSetEnd?: (absoluteSourceSeconds: number) => void;
  onUsePlayhead?: (absoluteSourceSeconds: number) => void;
  audition?: { start: number; end: number };
  disabled?: boolean;
  onError: (message: string) => void;
}

export default function AudioPlayhead({
  identity,
  label,
  audioUrl,
  audioSourceOffset,
  savedClipStart,
  rangeStart,
  rangeEnd,
  playhead,
  onPlayheadChange,
  onSetStart,
  onSetEnd,
  onUsePlayhead,
  audition,
  disabled = false,
  onError,
}: AudioPlayheadProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const fallbackDuration = Math.max(0.01, rangeEnd - audioSourceOffset);
  const availableStart = audioSourceOffset;
  const availableEnd = audioSourceOffset + (duration && Number.isFinite(duration) ? duration : fallbackDuration);
  const sliderMin = clamp(Math.min(rangeStart, rangeEnd), availableStart, availableEnd);
  const sliderMax = Math.max(sliderMin + 0.01, clamp(Math.max(rangeStart, rangeEnd), availableStart, availableEnd));
  const sliderValue = clamp(playhead, sliderMin, sliderMax);
  const canAudition = Boolean(audition
    && Number.isFinite(audition.start)
    && Number.isFinite(audition.end)
    && audition.end > audition.start
    && audition.start >= availableStart
    && audition.end <= availableEnd);

  function seekTo(absoluteSourceSeconds: number) {
    const player = audio.current;
    if (!player) return;
    const mediaDuration = Number.isFinite(player.duration) ? player.duration : Math.max(0, availableEnd - audioSourceOffset);
    player.currentTime = clipPositionFromSourceTime(audioSourceOffset, absoluteSourceSeconds, mediaDuration);
  }

  useEffect(() => {
    stopAt.current = null;
    setDuration(null);
    onPlayheadChange(clamp(playhead, sliderMin, sliderMax));
  }, [identity]);

  useEffect(() => {
    seekTo(sliderValue);
  }, [sliderValue, duration]);

  async function auditionCandidate() {
    if (!audition || !canAudition || !audio.current) return;
    stopAt.current = audition.end;
    onPlayheadChange(audition.start);
    seekTo(audition.start);
    try {
      await audio.current.play();
    } catch (error) {
      stopAt.current = null;
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  return <div className="clip-playhead stack" aria-label={label}>
    <audio
      key={identity}
      ref={audio}
      aria-label={`${label} audio`}
      controls
      preload="metadata"
      src={audioUrl}
      onLoadedMetadata={(event) => {
        const nextDuration = event.currentTarget.duration;
        if (Number.isFinite(nextDuration) && nextDuration > 0) setDuration(nextDuration);
        seekTo(playhead);
      }}
      onTimeUpdate={(event) => {
        const mediaDuration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : fallbackDuration;
        const absolute = sourceTimeFromClipPosition(audioSourceOffset, event.currentTarget.currentTime, mediaDuration);
        onPlayheadChange(absolute);
        if (stopAt.current !== null && absolute >= stopAt.current - 0.015) {
          event.currentTarget.pause();
          stopAt.current = null;
        }
      }}
      onEnded={() => { stopAt.current = null; }}
    />
    <label className="field clip-seek-field">
      <span>{label}</span>
      <input
        aria-label={`${label} seek`}
        type="range"
        min={sliderMin}
        max={sliderMax}
        step="0.01"
        value={sliderValue}
        disabled={disabled || sliderMax <= sliderMin}
        onChange={(event) => {
          stopAt.current = null;
          const absolute = Number(event.target.value);
          onPlayheadChange(absolute);
          seekTo(absolute);
        }}
      />
    </label>
    <p className="clip-time-readout" aria-live="polite">
      <strong>{stamp(sliderValue)}</strong> absolute source
      <span> · {stamp(Math.max(0, sliderValue - savedClipStart))} from the saved clip start</span>
    </p>
    <div className="curation-actions">
      {onSetStart && <button className="btn" type="button" disabled={disabled} onClick={() => onSetStart(sliderValue)}>Set start here</button>}
      {onSetEnd && <button className="btn" type="button" disabled={disabled} onClick={() => onSetEnd(sliderValue)}>Set end here</button>}
      {onUsePlayhead && <button className="btn btn-primary" type="button" disabled={disabled} onClick={() => onUsePlayhead(sliderValue)}>Use playhead as split point</button>}
      {audition && <button className="btn" type="button" disabled={disabled || !canAudition} onClick={() => void auditionCandidate()}>Audition candidate trim</button>}
    </div>
    {audition && !canAudition && <p className="muted small">This audio preview does not cover the candidate trim. Save the numeric timing and reprepare to hear extended source audio.</p>}
  </div>;
}
