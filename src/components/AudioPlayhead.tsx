import { useEffect, useRef, useState } from "react";
import { mediaSeekPositionFromSourceTime, sourceTimeFromClipPosition } from "../lib/clipEditing";

const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const BOUNDARY_EPSILON_SECONDS = 0.004;

export interface AudioSeekCommand {
  sequence: number;
  absoluteSourceSeconds: number;
}

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
  /** A parent-issued seek caused by an explicit user command, never by media clock updates. */
  seekCommand?: AudioSeekCommand | null;
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
  seekCommand = null,
  onSetStart,
  onSetEnd,
  onUsePlayhead,
  audition,
  disabled = false,
  onError,
}: AudioPlayheadProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);
  const deadlineTimer = useRef<number | null>(null);
  const boundaryFrame = useRef<number | null>(null);
  const commandedSeek = useRef<number | null>(null);
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

  function playerDuration(player: HTMLAudioElement) {
    return Number.isFinite(player.duration) ? player.duration : Math.max(0, availableEnd - audioSourceOffset);
  }

  function absolutePlayerTime(player: HTMLAudioElement) {
    return sourceTimeFromClipPosition(audioSourceOffset, player.currentTime, playerDuration(player));
  }

  function seekTo(absoluteSourceSeconds: number) {
    const player = audio.current;
    if (!player) return;
    const clipPosition = mediaSeekPositionFromSourceTime(audioSourceOffset, absoluteSourceSeconds, playerDuration(player));
    commandedSeek.current = clipPosition;
    player.currentTime = clipPosition;
  }

  function clearBoundaryTimers() {
    if (deadlineTimer.current !== null) window.clearTimeout(deadlineTimer.current);
    if (boundaryFrame.current !== null) window.cancelAnimationFrame(boundaryFrame.current);
    deadlineTimer.current = null;
    boundaryFrame.current = null;
  }

  function clearBoundary() {
    clearBoundaryTimers();
    stopAt.current = null;
  }

  function finishAtBoundary(player: HTMLAudioElement, target: number) {
    if (stopAt.current !== target) return;
    clearBoundaryTimers();
    stopAt.current = null;
    player.pause();
    // Clamp overshoot to the selected end; decoder EOF seeks stay <=1ms inside
    // the encoded interval so WebKit does not request an invalid EOF byte range.
    seekTo(target);
    onPlayheadChange(target);
  }

  function monitorBoundary(target: number) {
    const player = audio.current;
    if (!player || disabled) return;
    clearBoundaryTimers();
    stopAt.current = target;

    const sample = () => {
      if (stopAt.current !== target || player.paused || player.ended || disabled) {
        clearBoundaryTimers();
        return;
      }
      if (absolutePlayerTime(player) >= target - BOUNDARY_EPSILON_SECONDS) {
        finishAtBoundary(player, target);
        return;
      }
      boundaryFrame.current = window.requestAnimationFrame(sample);
    };

    const armDeadline = () => {
      if (stopAt.current !== target || player.paused || player.ended || disabled) return;
      const remaining = target - absolutePlayerTime(player);
      if (remaining <= BOUNDARY_EPSILON_SECONDS) {
        finishAtBoundary(player, target);
        return;
      }
      const rate = Number.isFinite(player.playbackRate) && player.playbackRate > 0 ? player.playbackRate : 1;
      const delay = Math.max(4, (remaining / rate) * 1000 - 2);
      deadlineTimer.current = window.setTimeout(armDeadline, delay);
    };

    boundaryFrame.current = window.requestAnimationFrame(sample);
    armDeadline();
  }

  useEffect(() => {
    clearBoundary();
    const player = audio.current;
    player?.pause();
    setDuration(null);
    return () => {
      clearBoundary();
      player?.pause();
    };
  }, [identity]);

  useEffect(() => {
    if (!disabled) return;
    clearBoundary();
    audio.current?.pause();
  }, [disabled]);

  useEffect(() => {
    const player = audio.current;
    if (!player || player.paused) return;
    clearBoundary();
    player.pause();
  }, [sliderMin, sliderMax]);

  useEffect(() => {
    if (!seekCommand) return;
    clearBoundary();
    audio.current?.pause();
    seekTo(clamp(seekCommand.absoluteSourceSeconds, sliderMin, sliderMax));
  }, [seekCommand?.sequence]);

  async function auditionCandidate() {
    if (!audition || !canAudition || !audio.current || disabled) return;
    clearBoundary();
    stopAt.current = audition.end;
    onPlayheadChange(audition.start);
    seekTo(audition.start);
    try {
      await audio.current.play();
    } catch (error) {
      clearBoundary();
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function playSelectedRange() {
    if (!audio.current || disabled) return;
    clearBoundary();
    if (!audio.current.paused) {
      monitorBoundary(sliderMax);
      return;
    }
    try {
      await audio.current.play();
    } catch (error) {
      clearBoundary();
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  return <div className="clip-playhead stack" aria-label={label}>
    <audio
      key={identity}
      ref={audio}
      aria-label={`${label} audio`}
      aria-disabled={disabled}
      controls={!disabled}
      tabIndex={disabled ? -1 : undefined}
      preload="metadata"
      src={audioUrl}
      onLoadedMetadata={(event) => {
        const nextDuration = event.currentTarget.duration;
        if (Number.isFinite(nextDuration) && nextDuration > 0) setDuration(nextDuration);
        seekTo(playhead);
      }}
      onPlay={(event) => {
        const player = event.currentTarget;
        if (disabled) {
          clearBoundary();
          player.pause();
          return;
        }
        let target = stopAt.current ?? sliderMax;
        const absolute = absolutePlayerTime(player);
        if (absolute < sliderMin - BOUNDARY_EPSILON_SECONDS || absolute >= target - BOUNDARY_EPSILON_SECONDS) {
          if (stopAt.current !== null) target = stopAt.current;
          else target = sliderMax;
          seekTo(sliderMin);
          onPlayheadChange(sliderMin);
        }
        monitorBoundary(target);
      }}
      onPause={() => clearBoundary()}
      onSeeking={(event) => {
        clearBoundaryTimers();
        if (commandedSeek.current === null
          || Math.abs(event.currentTarget.currentTime - commandedSeek.current) > .03) stopAt.current = null;
      }}
      onSeeked={(event) => {
        const player = event.currentTarget;
        const wasCommanded = commandedSeek.current !== null
          && Math.abs(player.currentTime - commandedSeek.current) <= .03;
        commandedSeek.current = null;
        const absolute = absolutePlayerTime(player);
        const bounded = clamp(absolute, sliderMin, sliderMax);
        if (!wasCommanded && bounded !== absolute) seekTo(bounded);
        onPlayheadChange(bounded);
        if (!player.paused && !disabled) monitorBoundary(stopAt.current ?? sliderMax);
      }}
      onRateChange={(event) => {
        if (!event.currentTarget.paused && stopAt.current !== null) monitorBoundary(stopAt.current);
      }}
      onTimeUpdate={(event) => {
        const absolute = absolutePlayerTime(event.currentTarget);
        const target = stopAt.current;
        if (target !== null && absolute >= target - BOUNDARY_EPSILON_SECONDS) {
          finishAtBoundary(event.currentTarget, target);
          return;
        }
        // Decoder clock updates only update state. They never command another seek.
        onPlayheadChange(clamp(absolute, sliderMin, sliderMax));
      }}
      onEnded={(event) => {
        const target = stopAt.current;
        if (target !== null) finishAtBoundary(event.currentTarget, target);
        else clearBoundary();
      }}
    />
    {disabled && <p className="muted small">Playback is paused while another editor for this draft is active.</p>}
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
          clearBoundary();
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
      <button className="btn" type="button" disabled={disabled} onClick={() => void playSelectedRange()}>Play selected range</button>
      {onSetStart && <button className="btn" type="button" disabled={disabled} onClick={() => onSetStart(sliderValue)}>Set start here</button>}
      {onSetEnd && <button className="btn" type="button" disabled={disabled} onClick={() => onSetEnd(sliderValue)}>Set end here</button>}
      {onUsePlayhead && <button className="btn btn-primary" type="button" disabled={disabled} onClick={() => onUsePlayhead(sliderValue)}>Use playhead as split point</button>}
      {audition && <button className="btn" type="button" disabled={disabled || !canAudition} onClick={() => void auditionCandidate()}>Audition candidate trim</button>}
    </div>
    {audition && !canAudition && <p className="muted small">This audio preview does not cover the candidate trim. Save the numeric timing and reprepare to hear extended source audio.</p>}
  </div>;
}
