import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { curationApi } from "../lib/curationApi";
import type { CurationLibraryCard } from "../lib/curationTypes";
import { activeClips, DEFAULT_PREFERENCES, pickClip, provenance, readShadow, saveShadow, type ShadowPreferences, type ShadowSaved } from "../lib/shadowing";
import { ShadowPlayer, type ShadowSnapshot } from "../lib/shadowPlayer";
import "../styles/shadowing.css";

type Collection = "all" | "imported" | "generated" | "unknown";
const labels = { imported: "Imported YouTube audio", generated: "Generated audio", unknown: "Unverified audio provenance" };
const initial: ShadowSnapshot = { phase: "idle", position: 0, duration: 0, error: null };
const emptySaved = (): ShadowSaved => ({ version: 1, clipId: null, preferences: { ...DEFAULT_PREFERENCES } });
const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
const sourceKey = (c: CurationLibraryCard) => c.source_id == null ? "unknown" : String(c.source_id);
function sourceLabel(c: CurationLibraryCard) {
  if (c.source_type === "youtube") {
    try { const u = new URL(c.source_url || ""); return `YouTube · ${u.searchParams.get("v") || u.pathname.split("/").pop()} · source ${sourceKey(c)}`; } catch { /* Unknown source remains selectable. */ }
  }
  return `${c.source_type?.replaceAll("_", " ") || "Unknown source"} · ${sourceKey(c)}`;
}

export default function Shadowing() {
  const [cards, setCards] = useState<CurationLibraryCard[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [collection, setCollection] = useState<Collection>("all");
  const [source, setSource] = useState("all");
  const [preferences, setPreferences] = useState<ShadowPreferences>({ ...DEFAULT_PREFERENCES });
  const [snapshot, setSnapshot] = useState<ShadowSnapshot>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [completed, setCompleted] = useState(0);
  const [resume, setResume] = useState(false);
  const saved = useRef<ShadowSaved>(emptySaved());
  const player = useRef<ShadowPlayer | null>(null);
  const generation = useRef(0);
  const alive = useRef(false);
  const primary = useRef<HTMLButtonElement>(null);
  const errorBox = useRef<HTMLDivElement>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreFocus = useRef(false);

  const persist = useCallback(() => {
    try { setStorageAvailable(saveShadow(window.localStorage, saved.current)); }
    catch { setStorageAvailable(false); }
  }, []);
  const load = useCallback(async () => {
    const request = ++generation.current;
    player.current?.stop();
    setLoading(true); setError(null); setNotice("");
    if (loadTimer.current) clearTimeout(loadTimer.current);
    loadTimer.current = setTimeout(() => {
      if (request !== generation.current || !alive.current) return;
      ++generation.current;
      setError("Your clips took too long to load. Check your connection and retry.");
      setLoading(false);
    }, 20000);
    try {
      const library = activeClips(await curationApi.listCards(true));
      if (request !== generation.current || !alive.current) return;
      const chosen = pickClip(library, saved.current.clipId);
      setCards(library); setSelectedId(chosen?.phrase_id ?? null);
      setCollection(chosen ? provenance(chosen) === "imported" ? "imported" : "all" : "all");
      setSource("all");
      setResume(saved.current.clipId !== null && chosen?.phrase_id === saved.current.clipId);
      if (saved.current.clipId !== null && chosen?.phrase_id !== saved.current.clipId) {
        setNotice("Your previous clip is no longer active. Choose another clip to continue.");
      }
      saved.current = { ...saved.current, clipId: chosen?.phrase_id ?? null };
      persist();
      // Always use the newly fetched URL, never media/text from storage.
      if (chosen) player.current?.select(chosen.audio_url);
      setLoading(false);
    } catch {
      if (request !== generation.current || !alive.current) return;
      setError("We couldn't load your active clips. Check your connection and try again.");
      setLoading(false);
    } finally {
      if (request === generation.current && loadTimer.current) clearTimeout(loadTimer.current);
    }
  }, [persist]);

  useEffect(() => {
    alive.current = true;
    try { saved.current = readShadow(window.localStorage); } catch { setStorageAvailable(false); }
    setPreferences(saved.current.preferences);
    const owner = new ShadowPlayer({
      createAudio: () => new Audio(),
      onChange: value => { if (alive.current) setSnapshot(value); },
      onComplete: () => { if (alive.current) setCompleted(n => n + 1); },
    });
    player.current = owner;
    owner.configure(saved.current.preferences);
    const stop = () => { owner.stop(); setResume(true); };
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("astro:before-preparation", stop);
    document.addEventListener("astro:before-swap", stop);
    void load();
    return () => {
      alive.current = false; ++generation.current;
      if (loadTimer.current) clearTimeout(loadTimer.current);
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("astro:before-preparation", stop);
      document.removeEventListener("astro:before-swap", stop);
      owner.dispose(); player.current = null;
    };
  }, [load]);
  useEffect(() => {
    if (!loading && restoreFocus.current) {
      (error ? errorBox.current : primary.current)?.focus();
      restoreFocus.current = false;
    }
  }, [loading, error]);

  const collectionCards = useMemo(() => cards.filter(c => collection === "all" || provenance(c) === collection), [cards, collection]);
  const sources = useMemo(() => [...new Map(collectionCards.map(c => [sourceKey(c), sourceLabel(c)])).entries()], [collectionCards]);
  const visible = useMemo(() => collectionCards.filter(c => source === "all" || sourceKey(c) === source), [collectionCards, source]);
  const card = visible.find(c => c.phrase_id === selectedId) ?? null;
  const index = visible.findIndex(c => c.phrase_id === selectedId);
  const running = ["playing", "loading", "gap"].includes(snapshot.phase);
  const choose = (next: CurationLibraryCard | null) => {
    player.current?.stop();
    setSelectedId(next?.phrase_id ?? null); setResume(false); setNotice("");
    saved.current = { ...saved.current, clipId: next?.phrase_id ?? null }; persist();
    if (next) player.current?.select(next.audio_url);
  };
  const configure = (change: Partial<ShadowPreferences>) => {
    const next = { ...saved.current.preferences, ...change };
    saved.current = { ...saved.current, preferences: next };
    player.current?.configure(next); setPreferences(next); persist();
  };
  const start = () => { setResume(true); player.current?.start(); };
  const changeCollection = (value: Collection) => {
    const matches = cards.filter(c => value === "all" || provenance(c) === value);
    choose(pickClip(matches, null)); setCollection(value); setSource("all");
  };
  const changeSource = (value: string) => {
    choose(pickClip(collectionCards.filter(c => value === "all" || sourceKey(c) === value), null)); setSource(value);
  };
  const status = snapshot.phase === "gap" ? `Your turn · repeat aloud. The clip repeats after a ${preferences.gapSeconds}-second pause.`
    : snapshot.phase === "gap-paused" ? "Repeat pause is paused. Resume when you're ready."
    : snapshot.phase === "playing" ? preferences.mode === "along" ? "Shadow along · speak with the audio." : "Listen · then repeat aloud in the pause."
    : snapshot.phase === "loading" ? "Starting audio… You can pause or choose another clip."
    : "Ready when you are. Press play; the same clip will repeat until you pause.";

  return <div className="shadow-page">
    <header className="shadow-heading">
      <div><p className="shadow-eyebrow">SPEAKING, AT YOUR PACE</p><h1>Find your rhythm.</h1><p>Slow it down. Say it aloud. Stay with one clip as long as you like.</p></div>
      <a className="btn" href="/" onClick={() => player.current?.stop()}>Exit shadowing</a>
    </header>
    <section className="shadow-workspace" aria-label="Shadowing player" data-phase={snapshot.phase}>
      {loading ? <div className="shadow-empty" role="status"><h2>Gathering your clips…</h2><p>Loading your complete active library.</p></div>
      : error ? <div className="shadow-empty" role="alert" tabIndex={-1} ref={errorBox}><h2>Let's try that again.</h2><p>{error}</p><button className="btn btn-primary" onClick={() => { restoreFocus.current = true; void load(); }}>Retry loading clips</button></div>
      : cards.length === 0 ? <div className="shadow-empty"><h2>Your voice, your clips.</h2><p>No active clips with Spanish and English are available yet. Choose a source and save a clip to start.</p><a className="btn btn-primary" href="/ingest/">Add a source</a><a className="btn" href="/library/">Open Library</a><button className="btn" onClick={() => void load()}>Refresh clips</button></div>
      : <>
        <div className="shadow-pickers">
          <label>Audio collection<select aria-label="Audio collection" value={collection} onChange={e => changeCollection(e.target.value as Collection)}><option value="imported">Imported clips</option><option value="all">All active clips</option><option value="generated">Generated clips</option><option value="unknown">Other / unknown</option></select></label>
          <label>Source<select aria-label="Source" value={source} onChange={e => changeSource(e.target.value)}><option value="all">All sources</option>{sources.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
          <label className="shadow-clip-picker">Choose clip<select aria-label="Choose clip" value={card?.phrase_id ?? ""} onChange={e => choose(visible.find(c => c.phrase_id === Number(e.target.value)) ?? null)}>{!card && <option value="">No clips in this collection</option>}{visible.map(c => <option key={c.phrase_id} value={c.phrase_id}>{c.spanish}{!c.audio_url ? " — audio unavailable" : ""}</option>)}</select></label>
        </div>
        {notice && <p className="shadow-notice" role="status">{notice}</p>}
        {card ? <>
          <div className="shadow-clip-meta"><span>{labels[provenance(card)]}</span><span>Clip {index + 1} of {visible.length}</span></div>
          <div className="shadow-transcript">
            <p className="shadow-eyebrow">{preferences.showSpanish ? "SPANISH" : "SPANISH HIDDEN"}</p>
            {preferences.showSpanish && <p className="shadow-spanish" lang="es">{card.spanish}</p>}
            <p className="shadow-eyebrow">ENGLISH MEANING</p><p className="shadow-english">{card.english}</p>
            <label className="shadow-text-toggle"><input type="checkbox" checked={preferences.showSpanish} onChange={e => configure({ showSpanish: e.target.checked })} />Show Spanish</label>
          </div>
          {!card.audio_url ? <div className="shadow-error" role="alert"><strong>This clip has no playable audio.</strong><p>Choose Next clip, or open Library to inspect or repair it.</p><a className="btn" href={`/library/?phrase_id=${card.phrase_id}`}>Open Library</a></div>
          : snapshot.error && <div className="shadow-error" role="alert"><p>{snapshot.error}</p><button className="btn" onClick={start}>Retry audio</button><a className="btn" href={`/library/?phrase_id=${card.phrase_id}`}>Open Library</a></div>}
          <div className="shadow-status-row"><p data-testid="shadow-status" role="status">{card.audio_url && !snapshot.error ? status : "You can skip this clip and keep practising."}</p><output data-testid="shadow-position" aria-label="Playback position">{clock(snapshot.position)} / {snapshot.duration ? clock(snapshot.duration) : "–:––"}</output></div>
          <progress className="shadow-progress" aria-label="Clip progress" max={snapshot.duration || 1} value={snapshot.position} />
          <div className="shadow-transport">
            <button className="btn" aria-label="Previous clip" disabled={index <= 0} onClick={() => choose(visible[index - 1])}>← Previous</button>
            <button ref={primary} className="btn btn-primary shadow-play" disabled={!card.audio_url} onClick={() => { if (running) player.current?.pause(); else start(); }}>{running ? "Pause" : resume ? "Resume shadowing" : "Start shadowing"}</button>
            <button className="btn" aria-label="Next clip" disabled={index >= visible.length - 1} onClick={() => choose(visible[index + 1])}>Next →</button>
            <button className="btn shadow-replay" disabled={!card.audio_url} onClick={() => { setResume(true); player.current?.replay(); }}>Replay</button>
          </div>
        </> : <div className="shadow-empty"><h2>No clips in this collection.</h2><p>Try All active clips, or choose another source.</p><button className="btn" onClick={() => changeCollection("all")}>Show all active clips</button></div>}
        <div className="shadow-settings">
          <fieldset><legend>Make room for your voice</legend><div className="shadow-modes"><button className="btn" aria-pressed={preferences.mode === "repeat"} onClick={() => configure({ mode: "repeat" })}>Listen and repeat</button><button className="btn" aria-pressed={preferences.mode === "along"} onClick={() => configure({ mode: "along" })}>Shadow along</button></div><p>{preferences.mode === "repeat" ? "Listen once, speak in the gap, then hear it again." : "Speak with the speaker. The clip loops without a gap."}</p><label>Repeat pause<select aria-label="Repeat pause" disabled={preferences.mode === "along"} value={preferences.gapSeconds} onChange={e => configure({ gapSeconds: Number(e.target.value) })}>{[0, 1, 2, 3, 5, 8].map(n => <option value={n} key={n}>{n} seconds</option>)}</select></label><small>Changing the pause restarts the gap. Pausing freezes it.</small></fieldset>
          <fieldset><legend>Choose your pace</legend><div className="shadow-speeds">{[0.5, 0.75, 1].map(rate => <button className="btn" key={rate} aria-pressed={preferences.rate === rate} onClick={() => configure({ rate })}>{rate}×</button>)}</div><p>1× is the original speed. Pitch is preserved where your browser supports it.</p><div className="shadow-tip"><strong>Start small.</strong><span>Try one familiar clip for a couple of minutes. No target to hit; move on when you want.</span></div></fieldset>
        </div>
        <footer className="shadow-footer"><span data-testid="shadow-count">{completed} completed playbacks this visit</span><button className="btn" onClick={() => { restoreFocus.current = true; void load(); }}>Refresh clips</button></footer>
      </>}
    </section>
    <div className="shadow-footnotes"><p><strong>A place to practise, not a test.</strong> Build comfort with the rhythm and sounds. No microphone, recording or grading. Shadowing doesn't change your recall schedule, daily reps or study streak.</p><p>{storageAvailable ? "Your clip and settings are remembered on this device only. Resume starts the clip from the beginning after a reload; playback always waits for your tap." : "Device storage is unavailable. You can still practise; your clip and settings won't be remembered after leaving."} Leaving the page or hiding it stops audio.</p></div>
  </div>;
}
