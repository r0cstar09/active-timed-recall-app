import { useEffect, useRef, useState } from "react";
import { curationApi } from "../lib/curationApi";
import { createActionGate, newerDraft, importNeedsPolling } from "../lib/curationState";
import type { CurationDraft, CurationImport, DraftPatch, TranscriptSegment } from "../lib/curationTypes";

const LAST_IMPORT = "spanish.curation.lastImport";
const isDraftWorking = (draft: CurationDraft) => draft.status === "queued" || draft.status === "preparing";
function mergeDrafts(current: CurationDraft[], incoming: CurationDraft[]) {
  const map = new Map(current.map((draft) => [draft.id, draft]));
  incoming.forEach((draft) => map.set(draft.id, newerDraft(map.get(draft.id), draft)));
  return [...map.values()].sort((a, b) => a.id - b.id);
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

export default function ManualCuration() {
  const [url, setUrl] = useState("");
  const [imports, setImports] = useState<CurationImport[]>([]);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState<CurationImport | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [spanish, setSpanish] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const activeId = useRef<number | null>(null);
  const epoch = useRef(0);
  const gate = useRef(createActionGate());
  const [, setDirtyVersion] = useState(0);
  const sourceAudio = useRef<HTMLAudioElement>(null);
  const sourceEnd = useRef<number | null>(null);
  const errorAlert = useRef<HTMLDivElement>(null);
  const dirtyEditors = useRef(new Set<number>());
  const needsPolling = importNeedsPolling(current);

  function remember(value: CurationImport) {
    activeId.current = value.id;
    setCurrent(value);
    try { localStorage.setItem(LAST_IMPORT, String(value.id)); } catch { /* private browser */ }
    const params = new URLSearchParams(window.location.search);
    params.set("import", String(value.id));
    window.history.replaceState(null, "", `?${params}`);
  }

  async function history(offset = 0) {
    const version = epoch.current;
    const page = await curationApi.listImports(50, offset);
    if (version !== epoch.current) return;
    setImports((old) => offset === 0 ? page.imports : [...old, ...page.imports.filter((x) => !old.some((y) => x.id === y.id))]);
    setTotal(page.total);
  }

  async function refresh(id = activeId.current) {
    if (!id) return;
    const version = epoch.current;
    const value = await curationApi.getImport(id);
    if (activeId.current === id && version === epoch.current) {
      setCurrent(value);
      setImports((old) => old.map((item) => item.id === id ? value : item));
      setPollError(null);
    }
  }

  async function action(key: string, work: () => Promise<void>) {
    if (!gate.current.tryAcquire("mutation")) return;
    epoch.current++;
    setBusy(key); setError(null); setNotice(null);
    try { await work(); }
    catch (err) { setError(`${key}: ${message(err)}`); }
    finally { epoch.current++; gate.current.release("mutation"); setBusy(null); }
  }

  useEffect(() => {
    let cancelled = false;
    const version = epoch.current;
    history().catch((err) => { if (!cancelled && version === epoch.current) setError(message(err)); });
    let saved: string | null = null;
    try { saved = localStorage.getItem(LAST_IMPORT); } catch { /* optional */ }
    const raw = new URLSearchParams(location.search).get("import") ?? saved;
    const id = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    if (id) {
      activeId.current = id;
      curationApi.getImport(id).then((value) => { if (!cancelled && version === epoch.current && activeId.current === id) remember(value); })
        .catch((err) => { if (!cancelled && version === epoch.current) setError(message(err)); });
    }
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!current || !needsPolling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (cancelled) return;
      try { if (!gate.current.isLocked("mutation")) await refresh(); }
      catch (err) { if (!cancelled) setPollError(message(err)); }
      if (!cancelled) timer = setTimeout(tick, 2000);
    }
    timer = setTimeout(tick, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [current?.id, needsPolling]);

  useEffect(() => {
    if (error) {
      errorAlert.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      errorAlert.current?.focus({ preventScroll: true });
    }
  }, [error]);

  useEffect(() => {
    function leaving(event: BeforeUnloadEvent) {
      if (dirtyEditors.current.size || selected.length) { event.preventDefault(); event.returnValue = ""; }
    }
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [selected.length]);

  function chooseSource(value: CurationImport) {
    if ((dirtyEditors.current.size || selected.length) && !window.confirm("Discard unsaved edits and selection? Saved drafts remain available.")) return;
    action("open", async () => {
      const detailed = await curationApi.getImport(value.id);
      dirtyEditors.current.clear(); setSelected([]); setSpanish(""); remember(detailed);
    });
  }

  function selectLine(index: number, checked: boolean) {
    if (!current) return;
    const next = checked ? [...new Set([...selected, index])].sort((a, b) => a - b) : selected.filter((i) => i !== index);
    setSelected(next);
    setSpanish(current.transcript.filter((line) => next.includes(line.index)).map((line) => line.text).join(" "));
  }

  function useHighlightedText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-transcript-text]"));
    const hit = nodes.filter((node) => range.intersectsNode(node));
    if (!hit.length) return;
    setSelected(hit.map((node) => Number(node.dataset.transcriptText)));
    setSpanish(selection.toString().trim());
  }

  function updateDraft(draft: CurationDraft) {
    setCurrent((old) => old ? { ...old, drafts: mergeDrafts(old.drafts, [draft]) } : old);
  }

  const contiguous = selected.length > 0 && selected.every((n, i) => i === 0 || n === selected[i - 1] + 1);
  const selectedLines = current?.transcript.filter((line) => selected.includes(line.index)) ?? [];
  const approved = current?.drafts.filter((d) => d.approved && d.status !== "added" && !dirtyEditors.current.has(d.id)) ?? [];

  return <section className="stack" aria-label="Manual phrase curation">
    <div className="card stack">
      <div><div className="spanish-kicker">you choose what enters your deck</div><h2>Choose → preview → approve</h2>
        <p className="muted">Import the full transcript, select the phrases you want, and listen before adding. Importing and preparing clips never add learning cards.</p></div>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); action("import", async () => {
        if (dirtyEditors.current.size || selected.length) {
          if (!window.confirm("Switch source and discard unsaved edits? Saved drafts are retained.")) return;
        }
        const value = await curationApi.createImport(url.trim());
        dirtyEditors.current.clear(); setSelected([]); setSpanish(""); remember(value); await history();
      }); }}>
        <label className="field"><span>YouTube URL</span><input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtube.com/watch?v=…" required disabled={!!busy} /></label>
        <button className="btn btn-primary" disabled={!!busy || !url.trim()}>{busy === "import" ? "Importing…" : "Import transcript"}</button>
      </form>
      {error && <div className="alert alert-error" role="alert" tabIndex={-1} ref={errorAlert}>{error}{current && <button className="btn" disabled={!!busy} onClick={() => action("refresh", refresh)}>Refresh saved data</button>}</div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      {pollError && <div className="alert alert-error">Connection interrupted: {pollError}. Your saved work remains on the server.<button className="btn" onClick={() => action("refresh", refresh)} disabled={!!busy}>Retry refresh</button></div>}
    </div>

    <details className="card" open={!current}>
      <summary>Saved imports ({total})</summary>
      <div className="stack" style={{ marginTop: 12 }}>
        {!imports.length && <p className="muted">No saved imports yet.</p>}
        {imports.map((value) => <button className="btn" disabled={!!busy} key={value.id} onClick={() => chooseSource(value)} aria-current={value.id === current?.id ? "true" : undefined}>
          {value.title || value.video_id} · {value.status}
        </button>)}
        {imports.length < total && <button className="btn" disabled={!!busy} onClick={() => action("history", () => history(imports.length))}>Load more imports</button>}
      </div>
    </details>

    {current && <>
      <div className="card stack">
        <h2>{current.title || current.video_id}</h2>
        <a href={current.source_url} target="_blank" rel="noreferrer">Watch original source ↗</a>
        {current.status !== "ready" && <p role="status">{current.status === "failed" ? current.error_message || "Transcript import failed." : "Loading the complete transcript… You can leave and reopen this import."}</p>}
        {current.status === "failed" && <button className="btn" disabled={!!busy} onClick={() => action("retry", async () => remember(await curationApi.createImport(current.source_url)))}>Retry import</button>}
        {current.status === "ready" && <>
          <h3>Full transcript · {current.transcript.length} lines</h3>
          <p className="muted small">Tick adjacent lines, or highlight words with your mouse. You can edit the selected phrase before saving it.</p>
          <div className="curation-transcript" onMouseUp={useHighlightedText}>
            {current.transcript.map((line: TranscriptSegment) => <label key={line.index} className={`curation-line ${selected.includes(line.index) ? "selected" : ""}`}>
              <input type="checkbox" aria-label={`Select transcript line ${line.index + 1}`} checked={selected.includes(line.index)} disabled={!!busy} onChange={(e) => selectLine(line.index, e.target.checked)} />
              <time>{stamp(line.start)}</time><span data-transcript-text={line.index}>{line.text}</span>
            </label>)}
          </div>
          <label className="field"><span>Selected phrase</span><textarea aria-label="Selected phrase" className="input" rows={3} value={spanish} disabled={!!busy} onChange={(e) => setSpanish(e.target.value)} /></label>
          {selected.length > 0 && !contiguous && <div className="alert alert-error">Select adjacent lines for one continuous audio clip.</div>}
          {selectedLines.length > 0 && <p className="muted small">Source range: {stamp(selectedLines[0].start)} – {stamp(selectedLines[selectedLines.length - 1].end)}. Automatic alignment runs only for this saved selection.</p>}
          <div className="curation-actions">
            <button className="btn btn-primary" disabled={!!busy || !contiguous || !spanish.trim()} onClick={() => action("selection", async () => {
              const drafts = await curationApi.createDrafts(current.id, [{ segment_indices: selected, spanish: spanish.trim() }]);
              setCurrent((old) => old ? { ...old, drafts: mergeDrafts(old.drafts, drafts) } : old);
              setSelected([]); setSpanish(""); setNotice("Selection saved as a draft. Prepare its clip below; nothing has been added to your deck.");
            })}>Save selection as draft</button>
            <button className="btn" disabled={!!busy || !selected.length} onClick={() => { setSelected([]); setSpanish(""); }}>Clear selection</button>
            {current.source_audio_url && selectedLines.length > 0 && <button className="btn" onClick={() => {
              const player = sourceAudio.current;
              if (!player) return;
              player.currentTime = Math.max(0, selectedLines[0].start - .5);
              sourceEnd.current = selectedLines[selectedLines.length - 1].end + .5;
              player.play().catch((err) => setError(message(err)));
            }}>Play source context</button>}
          </div>
        </>}
        {current.source_audio_url && <div><p className="muted small">Original audio — use it to check context or adjust a cut.</p><audio ref={sourceAudio} controls preload="metadata" src={current.source_audio_url} style={{ width: "100%" }} onTimeUpdate={(e) => { if (sourceEnd.current !== null && e.currentTarget.currentTime >= sourceEnd.current) { e.currentTarget.pause(); sourceEnd.current = null; } }} /></div>}
      </div>
      <div className="card stack">
        <div className="curation-actions"><h2 style={{ marginRight: "auto" }}>Draft clips ({current.drafts.length})</h2>
          <button className="btn btn-primary" disabled={!!busy || !approved.length} onClick={() => action("promote", async () => {
            const result = await curationApi.promoteDrafts(approved.map((d) => ({ id: d.id, revision: d.revision })));
            setCurrent((old) => old ? { ...old, drafts: mergeDrafts(old.drafts, result.drafts) } : old);
            setNotice(result.results.map((r) => r.action === "repaired" ? `Card #${r.phrase_id}: audio repaired; learning history unchanged.` : r.action === "added" ? `Card #${r.phrase_id} added.` : `Card #${r.phrase_id} already exists; no duplicate added.`).join(" "));
          })}>Add approved ({approved.length})</button>
        </div>
        {!current.drafts.length && <p className="muted">Select a phrase above and save it as a draft.</p>}
        {current.drafts.map((draft) => <DraftEditor key={draft.id} draft={draft} busy={!!busy} action={action} update={updateDraft} refresh={refresh}
          dirty={(value) => { if (value) dirtyEditors.current.add(draft.id); else dirtyEditors.current.delete(draft.id); setDirtyVersion((n) => n + 1); }}
          remove={() => setCurrent((old) => old ? { ...old, drafts: old.drafts.filter((d) => d.id !== draft.id) } : old)} />)}
      </div>
    </>}
    <style>{`
      .curation-transcript {max-height:24rem;overflow:auto;border:1px solid var(--border, #d8d8d8);border-radius:12px;padding:6px;}
      .curation-line {display:grid;grid-template-columns:24px 54px minmax(0,1fr);gap:8px;align-items:start;padding:10px 6px;border-radius:8px;cursor:pointer;overflow-wrap:anywhere;}
      .curation-line.selected {background:color-mix(in srgb,var(--accent,#c69025) 18%,transparent);}
      .curation-line input {width:20px;height:20px;}
      .curation-line time {font-size:12px;opacity:.7;padding-top:3px;}
      .curation-actions {display:flex;flex-wrap:wrap;gap:10px;align-items:center;}
      .curation-actions .btn {min-height:44px;white-space:normal;}
      .curation-draft {border:1px solid var(--border,#d8d8d8);border-radius:12px;padding:16px;scroll-margin-top:80px;}
      .curation-times {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;}
      .curation-times input {width:100%;min-width:0;}
      .curation-draft textarea {width:100%;box-sizing:border-box;}
    `}</style>
  </section>;
}

type Editor = { spanish: string; english: string; start: string; end: string };
const editValues = (d: CurationDraft): Editor => ({ spanish: d.spanish, english: d.english, start: String(d.start_time), end: String(d.end_time) });
function DraftEditor({ draft, busy, action, update, remove, refresh, dirty }: {
  draft: CurationDraft; busy: boolean; action: (key: string, work: () => Promise<void>) => Promise<void>;
  update: (draft: CurationDraft) => void; remove: () => void; refresh: () => Promise<void>; dirty: (value: boolean) => void;
}) {
  const [values, setValues] = useState<Editor>(() => editValues(draft));
  const [baseRevision, setBaseRevision] = useState(draft.revision);
  const [changed, setChanged] = useState(false);
  const dirtyRef = useRef(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!dirtyRef.current) { setValues(editValues(draft)); setBaseRevision(draft.revision); }
  }, [draft.revision]);
  useEffect(() => {
    if (new URLSearchParams(location.search).get("draft") === String(draft.id)) root.current?.scrollIntoView({ block: "center" });
    return () => dirty(false);
  }, []);
  function change(key: keyof Editor, value: string) {
    setValues((old) => ({ ...old, [key]: value })); setChanged(true); dirtyRef.current = true; dirty(true);
  }
  function sync(value: CurationDraft) {
    dirtyRef.current = false; dirty(false); setChanged(false); setValues(editValues(value)); setBaseRevision(value.revision); update(value);
  }
  const locked = busy || isDraftWorking(draft) || draft.status === "added";
  const stale = changed && baseRevision !== draft.revision;
  const previewReady = ["ready", "needs_review"].includes(draft.status) && !!draft.audio_url && !!draft.english.trim();
  return <article ref={root} id={`draft-${draft.id}`} className="curation-draft stack" aria-label={`Draft ${draft.id}`}>
    <div className="curation-actions"><h3 style={{ margin: 0 }}>Draft #{draft.id}{draft.repair_phrase_id ? ` · repair card #${draft.repair_phrase_id}` : ""}</h3><span className="pill">{draft.status.replaceAll("_", " ")}</span></div>
    {draft.repair_phrase_id && <p className="muted small">Repair changes only audio and timing. Spanish, English, review history and FSRS stay unchanged. Archived cards require a separate Restore.</p>}
    {draft.warning && <div className="alert" role="note">{draft.warning} Your phrase is retained for manual review.</div>}
    {draft.error_message && <div className="alert alert-error" role="alert">{draft.error_message}</div>}
    {draft.existing_phrase_id && !draft.repair_phrase_id && <div className="alert">Already in your {draft.existing_active ? "active" : "archived"} library: <a href={`/library/?phrase=${draft.existing_phrase_id}`}>Open card #{draft.existing_phrase_id}</a>.
      {!draft.existing_active && <button className="btn" disabled={busy} onClick={() => action("restore", async () => { await curationApi.reactivateCard(draft.existing_phrase_id!); await refresh(); })}>Restore existing card</button>}
      {!draft.repair_phrase_id && <button className="btn" disabled={busy} onClick={() => action("repair", async () => { const value = await curationApi.createRepairDraft(draft.existing_phrase_id!); location.href = `/ingest/?import=${value.import_id}&draft=${value.id}`; })}>Repair existing clip</button>}
    </div>}
    <label className="field"><span>Spanish</span><textarea aria-label="Spanish" className="input" rows={2} value={values.spanish} readOnly={!!draft.repair_phrase_id} disabled={locked} onChange={(e) => change("spanish", e.target.value)} /></label>
    <label className="field"><span>English meaning</span><textarea aria-label="English meaning" className="input" rows={2} value={values.english} readOnly={!!draft.repair_phrase_id} disabled={locked} onChange={(e) => change("english", e.target.value)} placeholder="Generated when you prepare, or enter your own meaning" /></label>
    <div className="curation-times">{(["start", "end"] as const).map((key) => <div key={key}>
      <label className="field"><span>{key === "start" ? "Start" : "End"} time (seconds)</span><input className="input" type="number" min="0" step="0.01" value={values[key]} disabled={locked} onChange={(e) => change(key, e.target.value)} /></label>
      <div className="curation-actions">{[-.1, .1].map((delta) => <button key={delta} className="btn" aria-label={`${key} ${delta > 0 ? "plus" : "minus"} 0.1 seconds`} disabled={locked} onClick={() => change(key, String(Math.max(0, Number(values[key]) + delta).toFixed(2)))}>{delta > 0 ? "+" : "−"}0.1s</button>)}</div>
    </div>)}</div>
    {stale && <div className="alert alert-error">This draft changed on the server. Your unsaved edits are still here; reload the saved version before continuing.</div>}
    {changed && <div className="curation-actions"><button className="btn btn-primary" disabled={locked || stale || !values.spanish.trim() || !values.start.trim() || !values.end.trim() || !Number.isFinite(Number(values.start)) || Number(values.end) <= Number(values.start)} onClick={() => action(`save-${draft.id}`, async () => {
      const patch: DraftPatch = { revision: baseRevision };
      if (values.spanish !== draft.spanish) patch.spanish = values.spanish;
      if (values.english !== draft.english) patch.english = values.english;
      if (Number(values.start) !== draft.start_time) patch.start_time = Number(values.start);
      if (Number(values.end) !== draft.end_time) patch.end_time = Number(values.end);
      sync(await curationApi.patchDraft(draft.id, patch));
    })}>Save edits</button><button className="btn" disabled={busy} onClick={() => sync(draft)}>Discard edits / reload saved</button><span className="muted small">Text or timing changes require a new preview and approval.</span></div>}
    {draft.audio_url && <audio aria-label={`Draft ${draft.id} audio preview`} controls preload="metadata" src={draft.audio_url} style={{ width: "100%" }} />}
    {isDraftWorking(draft) && <p role="status">Preparing only your selected phrase… It will remain saved if you leave this page.</p>}
    {draft.status !== "added" && <>
      <div className="curation-actions"><button className="btn" disabled={locked || changed} onClick={() => action(`prepare-${draft.id}`, async () => { const values = await curationApi.prepareDrafts([{ id: draft.id, revision: draft.revision }]); values.forEach(update); })}>{draft.audio_url ? "Reprepare clip" : draft.status === "failed" ? "Retry prepare" : "Prepare clip"}</button>
        <button className="btn" disabled={locked} onClick={() => { if (window.confirm("Delete this draft only? Existing cards and review history are not deleted.")) action(`delete-${draft.id}`, async () => { await curationApi.deleteDraft(draft.id, draft.revision); dirty(false); remove(); }); }}>Delete draft</button></div>
      <label className="curation-actions"><input type="checkbox" checked={draft.approved && !changed} disabled={locked || changed || !previewReady} onChange={(e) => { const approved = e.target.checked; action(`approve-${draft.id}`, async () => sync(await curationApi.patchDraft(draft.id, { revision: draft.revision, approved }))); }} />I listened and approve this clip and meaning</label>
    </>}
    {draft.status === "added" && <p role="status">{draft.repair_phrase_id ? "Repair saved" : "In library"}. <a href={`/library/?phrase=${draft.phrase_id}`}>Open card #{draft.phrase_id}</a></p>}
  </article>;
}
