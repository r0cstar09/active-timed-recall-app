import { useMemo, useRef, useState } from "react";
import { curationApi } from "../lib/curationApi";
import {
  createLineSplitSuggestions,
  normalizeClipText,
  partitionSpanishAtCursor,
  splitDraftEligibility,
} from "../lib/clipEditing";
import type { CurationDraft, TranscriptSegment } from "../lib/curationTypes";
import AudioPlayhead from "./AudioPlayhead";

const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;

type PartValues = { spanish: string; english: string };

interface SplitClipEditorProps {
  draft: CurationDraft;
  transcript: TranscriptSegment[];
  busy: boolean;
  action: (key: string, work: () => Promise<void>) => Promise<void>;
  onSplit: (importId: number, originalDraftId: number, drafts: CurationDraft[]) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

export default function SplitClipEditor({
  draft,
  transcript,
  busy,
  action,
  onSplit,
  onClose,
  onError,
}: SplitClipEditorProps) {
  const [baseRevision] = useState(draft.revision);
  const [left, setLeft] = useState<PartValues>({ spanish: "", english: "" });
  const [right, setRight] = useState<PartValues>({ spanish: "", english: "" });
  const [splitTime, setSplitTime] = useState("");
  const [playhead, setPlayhead] = useState((draft.start_time + draft.end_time) / 2);
  const [seekCommand, setSeekCommand] = useState<{ sequence: number; absoluteSourceSeconds: number } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [boundaryError, setBoundaryError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [timingSource, setTimingSource] = useState<"caption" | "playhead" | "typed" | null>(null);
  const combinedText = useRef<HTMLTextAreaElement>(null);
  const suggestions = useMemo(
    () => createLineSplitSuggestions(draft, transcript),
    [draft.id, draft.revision, draft.spanish, draft.start_time, draft.end_time, draft.segment_indices.join(","), transcript],
  );
  const panelStale = draft.revision !== baseRevision;
  const eligibility = splitDraftEligibility(draft, { busy, changed: false, stale: panelStale });
  const parsedTime = Number(splitTime);
  const textPartitionValid = Boolean(left.spanish && right.spanish
    && normalizeClipText(`${left.spanish} ${right.spanish}`) === normalizeClipText(draft.spanish));
  const timeValid = splitTime.trim() !== "" && Number.isFinite(parsedTime)
    && parsedTime > draft.start_time && parsedTime < draft.end_time;
  const canSubmit = eligibility.allowed && textPartitionValid && timeValid && confirmed;

  function setTextPartition(leftSpanish: string, rightSpanish: string) {
    setLeft((value) => ({ ...value, spanish: leftSpanish }));
    setRight((value) => ({ ...value, spanish: rightSpanish }));
    setBoundaryError(null);
    setConfirmed(false);
    // Deliberately preserve splitTime: changing a text cursor must never replace
    // a cut the learner already chose by listening.
  }

  function commandPlayhead(absoluteSourceSeconds: number) {
    setPlayhead(absoluteSourceSeconds);
    setSeekCommand((current) => ({
      sequence: (current?.sequence ?? 0) + 1,
      absoluteSourceSeconds,
    }));
  }

  function useCaptionSuggestion(suggestion: ReturnType<typeof createLineSplitSuggestions>[number]) {
    setTextPartition(suggestion.leftSpanish, suggestion.rightSpanish);
    setSplitTime(String(suggestion.suggestedSourceTime));
    commandPlayhead(suggestion.suggestedSourceTime);
    setTimingSource("caption");
  }

  function useCursorBoundary() {
    const position = combinedText.current?.selectionStart ?? cursor;
    setCursor(position);
    const result = partitionSpanishAtCursor(draft.spanish, position);
    if (!result.ok) {
      setBoundaryError(result.error);
      return;
    }
    setTextPartition(result.leftSpanish, result.rightSpanish);
  }

  return <section className="clip-split-panel stack" aria-label={`Split draft ${draft.id}`}>
    <div>
      <div className="spanish-kicker">question + answer</div>
      <h4>Choose the handoff between two clips</h4>
      <p className="muted">Put the journalist’s question in Part 1 and the coach’s answer in Part 2. Caption times are suggestions only—the app does not detect speakers. Listen and choose the cut yourself.</p>
    </div>

    {suggestions.length > 0 ? <div className="stack">
      <strong>Exact transcript-line boundaries</strong>
      <p className="muted small">Each suggested cut uses the next part’s caption start. Overlapping captions may not match the exact speaker handoff.</p>
      <div className="curation-actions">
        {suggestions.map((suggestion) => <button
          className="btn"
          type="button"
          key={suggestion.afterSegmentIndex}
          disabled={busy || panelStale}
          onClick={() => useCaptionSuggestion(suggestion)}
        >After line {suggestion.afterSegmentIndex + 1} · suggested {stamp(suggestion.suggestedSourceTime)}</button>)}
      </div>
    </div> : <p className="muted small">This saved wording no longer maps exactly to whole transcript lines. Use the text cursor below; no caption time will be guessed.</p>}

    <label className="field">
      <span>Spanish boundary fallback</span>
      <textarea
        ref={combinedText}
        aria-label={`Draft ${draft.id} combined Spanish split boundary`}
        className="input split-boundary-text"
        rows={3}
        value={draft.spanish}
        readOnly
        disabled={busy || panelStale}
        onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
      />
    </label>
    <div className="curation-actions">
      <button className="btn" type="button" disabled={busy || panelStale || cursor <= 0 || cursor >= draft.spanish.length} onClick={useCursorBoundary}>Split Spanish at text cursor</button>
      <span className="muted small">Place the cursor between words. This changes only the text partition and keeps any playhead cut you chose.</span>
    </div>
    {boundaryError && <div className="alert alert-error" role="alert">{boundaryError}</div>}

    <AudioPlayhead
      identity={`split:${draft.id}:${baseRevision}:${draft.audio_url}`}
      label={`Draft ${draft.id} split playhead`}
      audioUrl={draft.audio_url!}
      audioSourceOffset={draft.start_time}
      savedClipStart={draft.start_time}
      rangeStart={draft.start_time}
      rangeEnd={draft.end_time}
      playhead={playhead}
      onPlayheadChange={setPlayhead}
      seekCommand={seekCommand}
      onUsePlayhead={(absolute) => {
        setSplitTime(absolute.toFixed(2));
        setTimingSource("playhead");
        setConfirmed(false);
      }}
      disabled={busy || panelStale}
      onError={onError}
    />

    <label className="field split-time-field">
      <span>Cut time · absolute source seconds</span>
      <input
        className="input"
        aria-label={`Draft ${draft.id} split time in absolute source seconds`}
        type="number"
        min={draft.start_time + 0.01}
        max={draft.end_time - 0.01}
        step="0.01"
        value={splitTime}
        disabled={busy || panelStale}
        onChange={(event) => {
          setSplitTime(event.target.value);
          const value = Number(event.target.value);
          if (Number.isFinite(value)) commandPlayhead(value);
          setTimingSource("typed");
          setConfirmed(false);
        }}
      />
      <span className="muted small">Saved clip bounds: {stamp(draft.start_time)}–{stamp(draft.end_time)} absolute. {timingSource === "caption" ? "Caption suggestion selected; listen before confirming." : timingSource === "playhead" ? "Playhead cut selected." : timingSource === "typed" ? "Typed cut selected; listen before confirming." : "Choose a caption suggestion or use the playhead."}</span>
    </label>

    <div className="clip-split-parts">
      <div className="clip-split-part stack">
        <div><span className="pill">Part 1</span><h4>Journalist question</h4></div>
        <label className="field"><span>Spanish · exact partition</span><textarea aria-label={`Draft ${draft.id} Part 1 Spanish`} className="input" rows={4} value={left.spanish} readOnly placeholder="Choose a line or cursor boundary" /></label>
        <label className="field"><span>English for Part 1</span><textarea aria-label={`Draft ${draft.id} Part 1 English`} className="input" rows={3} value={left.english} disabled={busy || panelStale} placeholder="Leave blank to generate this part independently" onChange={(event) => setLeft((value) => ({ ...value, english: event.target.value }))} /></label>
      </div>
      <div className="clip-split-part stack">
        <div><span className="pill">Part 2</span><h4>Coach answer</h4></div>
        <label className="field"><span>Spanish · exact partition</span><textarea aria-label={`Draft ${draft.id} Part 2 Spanish`} className="input" rows={4} value={right.spanish} readOnly placeholder="Choose a line or cursor boundary" /></label>
        <label className="field"><span>English for Part 2</span><textarea aria-label={`Draft ${draft.id} Part 2 English`} className="input" rows={3} value={right.english} disabled={busy || panelStale} placeholder="Leave blank to generate this part independently" onChange={(event) => setRight((value) => ({ ...value, english: event.target.value }))} /></label>
      </div>
    </div>

    <div className="combined-english-reference" role="note">
      <strong>Combined English reference only</strong>
      <p>{draft.english || "No combined English meaning was saved."}</p>
      <p className="muted small">This full meaning is not copied to either shorter clip. Blank fields are regenerated separately while each part prepares.</p>
    </div>

    {panelStale && <div className="alert alert-error" role="alert">This draft changed on the server. Your split choices are still visible; cancel and reopen the saved revision before submitting.</div>}
    {!textPartitionValid && (left.spanish || right.spanish) && <div className="alert alert-error" role="alert">The two Spanish parts must preserve every saved word in order.</div>}
    {splitTime.trim() !== "" && !timeValid && <div className="alert alert-error" role="alert">Choose a finite cut strictly inside the saved clip.</div>}
    <label className="split-confirm">
      <input type="checkbox" checked={confirmed} disabled={busy || panelStale || !textPartitionValid || !timeValid} onChange={(event) => setConfirmed(event.target.checked)} />
      <span>I listened around this cut and chose where Part 1 ends and Part 2 begins.</span>
    </label>
    <div className="curation-actions">
      <button className="btn btn-primary" type="button" disabled={!canSubmit} onClick={() => void action(`split-${draft.id}`, async () => {
        const results = await curationApi.splitDraft(draft.id, {
          revision: baseRevision,
          split_time: parsedTime,
          left: { spanish: left.spanish, english: left.english.trim() },
          right: { spanish: right.spanish, english: right.english.trim() },
        });
        if (results.length !== 2 || results[0].id !== draft.id) {
          throw new Error("The backend did not return the original left draft and one new right draft. Refresh saved data before retrying.");
        }
        onSplit(draft.import_id, draft.id, results);
        onClose();
      })}>{busy ? "Splitting…" : "Split into 2 saved clips"}</button>
      <button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel split</button>
    </div>
  </section>;
}
