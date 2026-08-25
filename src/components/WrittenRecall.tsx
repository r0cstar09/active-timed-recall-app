import { useEffect, useMemo, useRef, useState } from "react";
import { api, type WrittenAttempt } from "../lib/api";
import type { Session, SessionItem } from "../lib/types";

type WrittenMode = "learn" | "review" | "practice";
type Phase = "setup" | "learn" | "answer" | "grading" | "results";
type SavedAnswer = { answer: string; response_seconds: number };

const MODE_COPY: Record<WrittenMode, { title: string; description: string; schedule: string }> = {
  learn: {
    title: "Learn queue",
    description: "Study new cards, then type the exact batch from English.",
    schedule: "Introduces each card; the immediate written test is schedule-neutral.",
  },
  review: {
    title: "Due review",
    description: "Clear due Active Recall cards with typed Spanish.",
    schedule: "Counts as an authoritative rep and advances shared FSRS scheduling.",
  },
  practice: {
    title: "Free practice",
    description: "Write introduced cards without consuming the due queue.",
    schedule: "Counts toward daily reps but leaves FSRS dates unchanged.",
  },
};

function resultLabel(result?: string) {
  if (result === "pass") return "Pass";
  if (result === "partial") return "Needs polish";
  if (result === "fail") return "Retry later";
  return "Pending";
}

function targetAnswer(item: SessionItem) {
  return item.target_spanish || item.spanish || "";
}

export default function WrittenRecall() {
  const [mode, setMode] = useState<WrittenMode>("review");
  const [targetVerb, setTargetVerb] = useState("");
  const [verbs, setVerbs] = useState<Array<{ verb: string; englishBase: string }>>([]);
  const [phase, setPhase] = useState<Phase>("setup");
  const [session, setSession] = useState<Session | null>(null);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [savedAnswers, setSavedAnswers] = useState<Record<number, SavedAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const promptStartedAt = useRef(Date.now());
  const answerInput = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listVerbCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setVerbs(
            catalog.verbs
              .map(({ verb, englishBase }) => ({ verb, englishBase }))
              .sort((a, b) => a.verb.localeCompare(b.verb)),
          );
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (phase !== "answer" || !session) return;
    const item = session.items[index];
    setDraft(item ? savedAnswers[item.sprint_item_id]?.answer || "" : "");
    promptStartedAt.current = Date.now();
    window.setTimeout(() => answerInput.current?.focus(), 30);
  }, [index, phase, session?.session_id]);

  const current = session?.items[index];
  const selectedVerb = targetVerb.trim().toLocaleLowerCase();
  const completedAnswers = useMemo(
    () => Object.values(savedAnswers).filter((item) => item.answer.trim()).length,
    [savedAnswers],
  );

  function activateSession(next: Session) {
    setSession(next);
    setSavedAnswers({});
    setIndex(0);
    setDraft("");
    setEmptyMessage(null);
    if (next.status === "complete" || next.status === "complete_overtime") {
      setPhase("results");
      return;
    }
    if (next.mode === "learn") {
      const pendingIndex = next.items.findIndex((item) => (item.result || "pending") === "pending");
      setIndex(Math.max(0, pendingIndex));
      setPhase("learn");
      return;
    }
    setPhase("answer");
  }

  async function startPack(nextMode: WrittenMode = mode) {
    setBusy(true);
    setError(null);
    setEmptyMessage(null);
    try {
      let next = await api.createWrittenSession(nextMode, 10, selectedVerb || undefined);
      if (!next.session_id && next.resumable_session?.session_id) {
        next = await api.getSession(next.resumable_session.session_id);
      }
      if (!next.session_id || !next.items.length) {
        const subject = selectedVerb ? ` for ${selectedVerb}` : "";
        const copy = nextMode === "learn"
          ? `No new Learn cards${subject}. Generate and promote another sentence pack from Verbs, or choose another mode.`
          : nextMode === "review"
            ? `No due review cards${subject} right now.`
            : `No introduced practice cards${subject}. Learn or promote cards first.`;
        setEmptyMessage(copy);
        setPhase("setup");
        return;
      }
      activateSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function learnCurrent() {
    if (!session || !current) return;
    setBusy(true);
    setError(null);
    try {
      await api.introducePhrase(current.phrase_id);
      const nextIndex = session.items.findIndex(
        (item, itemIndex) => itemIndex > index && (item.result || "pending") === "pending",
      );
      if (nextIndex >= 0) {
        setIndex(nextIndex);
        return;
      }
      const phraseIds = session.items.map((item) => item.phrase_id);
      const test = await api.createWrittenSession(
        "practice",
        phraseIds.length,
        session.target_verb || selectedVerb || undefined,
        phraseIds,
      );
      if (!test.session_id || test.items.length !== phraseIds.length) {
        throw new Error("The Learn batch was introduced, but its written test could not reserve every card.");
      }
      activateSession(test);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function saveCurrentAnswer(): Record<number, SavedAnswer> | null {
    if (!current) return null;
    const answer = draft.trim();
    if (!answer) {
      setError("Type a Spanish answer before continuing.");
      answerInput.current?.focus();
      return null;
    }
    const elapsed = Math.max(0.1, (Date.now() - promptStartedAt.current) / 1000);
    const next = {
      ...savedAnswers,
      [current.sprint_item_id]: { answer, response_seconds: elapsed },
    };
    setSavedAnswers(next);
    setError(null);
    return next;
  }

  async function submitAnswers(answerMap: Record<number, SavedAnswer>) {
    if (!session) return;
    const attempts: WrittenAttempt[] = session.items.map((item) => {
      const answer = answerMap[item.sprint_item_id];
      if (!answer) throw new Error("Every card in the pack needs a written answer.");
      return { sprint_item_id: item.sprint_item_id, ...answer };
    });
    setPhase("grading");
    setBusy(true);
    try {
      const graded = await api.gradeWrittenSession(session.session_id, attempts);
      setSession(graded);
      setPhase("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("answer");
    } finally {
      setBusy(false);
    }
  }

  async function nextAnswer() {
    const next = saveCurrentAnswer();
    if (!next || !session) return;
    if (index < session.items.length - 1) {
      setIndex(index + 1);
      return;
    }
    await submitAnswers(next);
  }

  function previousAnswer() {
    if (!current || index <= 0) return;
    const answer = draft.trim();
    if (answer) {
      setSavedAnswers((previous) => ({
        ...previous,
        [current.sprint_item_id]: {
          answer,
          response_seconds: Math.max(0.1, (Date.now() - promptStartedAt.current) / 1000),
        },
      }));
    }
    setIndex(index - 1);
    setError(null);
  }

  function returnToSetup() {
    setPhase("setup");
    setSession(null);
    setSavedAnswers({});
    setDraft("");
    setError(null);
    setEmptyMessage(null);
  }

  if (phase === "grading") {
    return (
      <section className="written-shell" aria-live="polite">
        <div className="card written-wait stack">
          <div className="writing-mark" aria-hidden="true">✎</div>
          <h1>Hermes is grading</h1>
          <p className="muted">Checking meaning, the requested verb, conjugation, grammar, and natural Spanish—not exact string matching.</p>
          <div className="written-loader" aria-hidden="true"><span /><span /><span /></div>
        </div>
      </section>
    );
  }

  if (phase === "learn" && session && current) {
    return (
      <section className="written-shell">
        <div className="written-topline">
          <button className="btn btn-ghost btn-small" type="button" onClick={returnToSetup}>Exit</button>
          <span className="pill">Learn {index + 1}/{session.items.length}</span>
          {session.target_verb && <span className="pill pill-warn">{session.target_verb}</span>}
        </div>
        <div className="written-progress" aria-label={`${index + 1} of ${session.items.length}`}>
          <span style={{ width: `${((index + 1) / session.items.length) * 100}%` }} />
        </div>
        <article className="card written-card stack">
          <p className="written-kicker">English meaning</p>
          <h1 className="written-prompt">{current.english}</h1>
          <div className="written-answer-reveal" lang="es">{targetAnswer(current)}</div>
          {current.learning_card?.spanish_logic && (
            <div className="written-note"><strong>Spanish logic</strong><span>{current.learning_card.spanish_logic}</span></div>
          )}
          {current.learning_card?.english_trap && (
            <div className="written-note trap"><strong>English trap</strong><span>{current.learning_card.english_trap}</span></div>
          )}
          <button className="btn btn-primary btn-lg btn-block" type="button" disabled={busy} onClick={learnCurrent}>
            {busy ? "Saving…" : index === session.items.length - 1 ? "Learned — start writing" : "I understand this card"}
          </button>
        </article>
        {error && <p className="alert alert-error" role="alert">{error}</p>}
      </section>
    );
  }

  if (phase === "answer" && session && current) {
    return (
      <section className="written-shell">
        <div className="written-topline">
          <button className="btn btn-ghost btn-small" type="button" onClick={returnToSetup}>Exit</button>
          <span className="pill">Write {index + 1}/{session.items.length}</span>
          {session.target_verb && <span className="pill pill-warn">{session.target_verb}</span>}
        </div>
        <div className="written-progress" aria-label={`${index + 1} of ${session.items.length}`}>
          <span style={{ width: `${((index + 1) / session.items.length) * 100}%` }} />
        </div>
        <article className="card written-card stack">
          <p className="written-kicker">Write the equivalent Spanish</p>
          <h1 className="written-prompt">{current.english || current.prompt}</h1>
          {session.target_verb && <p className="written-target">Use <strong>{session.target_verb}</strong> naturally.</p>}
          <label className="written-label" htmlFor="written-answer">Your Spanish</label>
          <textarea
            id="written-answer"
            ref={answerInput}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") nextAnswer();
            }}
            rows={4}
            lang="es"
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            placeholder="Escribe tu respuesta…"
            maxLength={2000}
          />
          <div className="written-help">
            <span>{completedAnswers}/{session.items.length} saved</span>
            <span>⌘/Ctrl + Enter</span>
          </div>
          <div className="btn-row">
            <button className="btn" type="button" disabled={index === 0 || busy} onClick={previousAnswer}>Back</button>
            <button className="btn btn-primary" type="button" disabled={busy || !draft.trim()} onClick={nextAnswer}>
              {index === session.items.length - 1 ? "Grade all answers" : "Save & next"}
            </button>
          </div>
        </article>
        {error && <p className="alert alert-error" role="alert">{error}</p>}
      </section>
    );
  }

  if (phase === "results" && session) {
    const summary = session.summary;
    return (
      <section className="written-shell">
        <div className="card written-results-head stack">
          <p className="written-kicker">Written pack complete</p>
          <h1>{summary?.passed ?? 0}/{summary?.total ?? session.items.length} passed</h1>
          <div className="written-result-stats">
            <span><strong>{summary?.passed ?? 0}</strong> pass</span>
            <span><strong>{summary?.partial ?? 0}</strong> polish</span>
            <span><strong>{summary?.failed ?? 0}</strong> retry</span>
          </div>
          <p className="muted">
            All {session.items.length} submitted cards count toward today&apos;s reps.
            {session.affects_fsrs ? " This due-review pack also advanced shared scheduling." : " This practice pack left FSRS dates unchanged."}
          </p>
        </div>
        <div className="written-result-list">
          {session.items.map((item, itemIndex) => (
            <article className={`card written-result result-${item.result || "pending"}`} key={item.sprint_item_id}>
              <div className="written-result-title">
                <span>{itemIndex + 1}. {item.english}</span>
                <span className={`pill ${item.result === "pass" ? "pill-good" : item.result === "partial" ? "pill-warn" : "pill-bad"}`}>
                  {resultLabel(item.result)}
                </span>
              </div>
              <dl>
                <div><dt>You wrote</dt><dd lang="es">{item.user_transcript_segment || "—"}</dd></div>
                <div><dt>Reference</dt><dd lang="es">{targetAnswer(item) || "—"}</dd></div>
              </dl>
              {item.feedback && <p className="written-feedback">{item.feedback}</p>}
            </article>
          ))}
        </div>
        <div className="card stack">
          <button className="btn btn-primary btn-lg btn-block" type="button" disabled={busy} onClick={() => startPack(mode)}>
            Another {mode === "review" ? "due" : mode} pack
          </button>
          <button className="btn btn-block" type="button" onClick={returnToSetup}>Change mode or verb</button>
        </div>
      </section>
    );
  }

  return (
    <section className="written-shell">
      <div className="written-hero">
        <span className="writing-mark" aria-hidden="true">✎</span>
        <p className="written-kicker">Silent production · real reps</p>
        <h1>Written Recall</h1>
        <p>Use the same Learn and Active Recall queues when speaking is not practical. Hermes accepts natural equivalent Spanish, not just one exact sentence.</p>
      </div>

      <div className="card stack">
        <fieldset className="written-modes">
          <legend>Choose a queue</legend>
          {(Object.keys(MODE_COPY) as WrittenMode[]).map((itemMode) => (
            <label className={mode === itemMode ? "selected" : ""} key={itemMode}>
              <input type="radio" name="written-mode" value={itemMode} checked={mode === itemMode} onChange={() => setMode(itemMode)} />
              <span><strong>{MODE_COPY[itemMode].title}</strong><small>{MODE_COPY[itemMode].description}</small></span>
            </label>
          ))}
        </fieldset>

        <label className="written-label" htmlFor="target-verb">Verb focus <span className="muted">(optional)</span></label>
        <input
          id="target-verb"
          type="text"
          list="written-verbs"
          value={targetVerb}
          onChange={(event) => setTargetVerb(event.target.value)}
          placeholder="All queued cards, or type ser…"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <datalist id="written-verbs">
          {verbs.map((verb) => <option key={verb.verb} value={verb.verb}>{verb.englishBase}</option>)}
        </datalist>

        <div className="written-contract">
          <strong>{MODE_COPY[mode].schedule}</strong>
          <span>Typed success never claims pronunciation or spoken-speed mastery.</span>
        </div>

        <button className="btn btn-primary btn-lg btn-block" type="button" disabled={busy} onClick={() => startPack()}>
          {busy ? "Loading queue…" : `Start 10-card ${MODE_COPY[mode].title.toLowerCase()}`}
        </button>
      </div>

      {emptyMessage && (
        <div className="alert" role="status">
          <strong>Queue is clear</strong>
          <p>{emptyMessage}</p>
          {mode === "learn" && <a href="/verbs">Open Verbs →</a>}
        </div>
      )}
      {error && <p className="alert alert-error" role="alert">{error}</p>}

      <div className="card written-how stack">
        <h2>Verb-by-verb repertoire</h2>
        <p>Select a verb after promoting its generated sentence packs. Each harder ten-card pack stays in the same shared queue, so hundreds of reps build one durable repertoire instead of duplicate writing and speaking banks.</p>
      </div>
    </section>
  );
}
