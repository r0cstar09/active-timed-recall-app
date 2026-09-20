import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { filterPracticeTopics } from "../lib/practiceTopics";
import type { PracticeTopic, PracticeTopicKind, PracticeTopicsResponse } from "../lib/types";
import "../styles/practice-topic-picker.css";

const GROUPS: Array<{ kind: PracticeTopicKind; label: string }> = [
  { kind: "grammar", label: "Grammar patterns" },
  { kind: "verb", label: "Verbs" },
  { kind: "lesson", label: "Prior lessons" },
  { kind: "source", label: "Sources" },
];

export type PracticeTopicPickerStatus = {
  loading: boolean;
  loadError: boolean;
  selectionValid: boolean;
  selectedTopic: PracticeTopic | null;
};

type Props = {
  selectedTopicId: string | null;
  onChange: (topicId: string | null) => void;
  onStatusChange?: (status: PracticeTopicPickerStatus) => void;
  disabled?: boolean;
  idPrefix?: string;
};

export default function PracticeTopicPicker({
  selectedTopicId,
  onChange,
  onStatusChange,
  disabled = false,
  idPrefix,
}: Props) {
  const generatedId = useId().replaceAll(":", "");
  const prefix = idPrefix || `practice-topic-${generatedId}`;
  const [catalog, setCatalog] = useState<PracticeTopicsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    void api.getPracticeTopics()
      .then((next) => {
        if (requestVersion.current !== version) return;
        setCatalog(next);
        setLoading(false);
      })
      .catch((err) => {
        if (requestVersion.current !== version) return;
        setCatalog(null);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { requestVersion.current += 1; };
  }, [loadAttempt]);

  const selectedTopic = useMemo(
    () => selectedTopicId && catalog ? catalog.topics.find((topic) => topic.id === selectedTopicId) ?? null : null,
    [catalog, selectedTopicId],
  );
  const selectionValid = Boolean(catalog) && (selectedTopicId === null
    ? (catalog?.available_count ?? 0) > 0 : (selectedTopic?.available_count ?? 0) > 0);
  const matches = useMemo(() => filterPracticeTopics(catalog?.topics ?? [], query), [catalog, query]);
  const options = useMemo(() => {
    if (!selectedTopic || matches.some((topic) => topic.id === selectedTopic.id)) return matches;
    return [...matches, selectedTopic];
  }, [matches, selectedTopic]);

  useEffect(() => {
    onStatusChange?.({
      loading,
      loadError: Boolean(error),
      selectionValid,
      selectedTopic,
    });
  }, [error, loading, onStatusChange, selectedTopic, selectionValid]);

  const detail = selectedTopic ?? (selectedTopicId === null ? {
    label: "Mix all learned cards",
    description: "Rotate across your full learned deck. This is the explicit default and keeps FSRS scheduling off.",
    learned_count: catalog?.learned_count ?? 0,
    available_count: catalog?.available_count ?? 0,
    examples: [],
  } : null);

  return (
    <section className="practice-topic-picker" aria-labelledby={`${prefix}-title`}>
      <div className="practice-topic-heading">
        <div>
          <p className="practice-topic-kicker">Choose before you start</p>
          <h2 id={`${prefix}-title`}>Practice focus</h2>
        </div>
        <span className="pill">FSRS OFF</span>
      </div>

      {loading ? (
        <div className="practice-topic-state" role="status" aria-live="polite">
          <span className="practice-topic-spinner" aria-hidden="true" />
          Loading practice topics…
        </div>
      ) : error ? (
        <div className="alert alert-error practice-topic-error" role="alert">
          <strong>Practice topics could not load</strong>
          <span>{error}</span>
          <button className="btn btn-small" type="button" disabled={disabled} onClick={() => setLoadAttempt((value) => value + 1)}>
            Retry topics
          </button>
        </div>
      ) : (
        <>
          <label className="practice-topic-label" htmlFor={`${prefix}-search`}>Search topics and examples</label>
          <input
            className="input"
            id={`${prefix}-search`}
            type="search"
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Try “gave it to you” or a lesson name"
            autoComplete="off"
          />
          <p className="practice-topic-search-status small faint" role="status">
            {query.trim() ? `${matches.length} matching topic${matches.length === 1 ? "" : "s"}` : `${catalog?.topics.length ?? 0} focused topics`}
          </p>

          <label className="practice-topic-label" htmlFor={`${prefix}-select`}>Topic</label>
          <select
            className="input practice-topic-select"
            id={`${prefix}-select`}
            value={selectedTopicId ?? ""}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value || null)}
            aria-describedby={`${prefix}-detail`}
          >
            <option value="">Mix all learned cards</option>
            {GROUPS.map((group) => {
              const grouped = options.filter((topic) => topic.kind === group.kind);
              return grouped.length ? (
                <optgroup label={group.label} key={group.kind}>
                  {grouped.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.label} · {topic.available_count} available
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>

          {selectedTopicId !== null && !selectedTopic ? (
            <div className="alert alert-error practice-topic-error" role="alert">
              <strong>That practice topic is no longer available.</strong>
              <span>Choose another topic or explicitly switch to Mix all. Nothing will start automatically.</span>
              <button className="btn btn-small" type="button" disabled={disabled} onClick={() => onChange(null)}>
                Choose Mix all
              </button>
            </div>
          ) : detail ? (
            <div className="practice-topic-detail" id={`${prefix}-detail`}>
              <div className="practice-topic-detail-top">
                <strong>{detail.label}</strong>
                <span>{detail.available_count} available · {detail.learned_count} learned</span>
              </div>
              <p>{detail.description}</p>
              {detail.examples.length > 0 && (
                <div className="practice-topic-examples">
                  <span>English cue examples</span>
                  <ul>
                    {detail.examples.slice(0, 3).map((example) => <li key={example}>{example}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
