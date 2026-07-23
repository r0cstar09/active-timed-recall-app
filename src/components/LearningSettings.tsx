import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import { api } from "../lib/api";

export default function LearningSettings() {
  const [dailyTarget, setDailyTarget] = useState(100);
  const [state, setState] = useState<"loading" | "idle" | "saving" | "saved" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    api.getSettings()
      .then((settings) => {
        if (!active) return;
        setDailyTarget(settings.daily_practice_target);
        setState("idle");
      })
      .catch((error) => {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setState("error");
      });
    return () => { active = false; };
  }, []);

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Math.max(1, Math.min(500, Math.round(dailyTarget)));
    setDailyTarget(value);
    setState("saving");
    setMessage("");
    try {
      const saved = await api.updateSettings({ daily_practice_target: value });
      setDailyTarget(saved.daily_practice_target);
      setState("saved");
      setTimeout(() => setState((current) => current === "saved" ? "idle" : current), 1800);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <div>
        <h2 style={{ marginBottom: 4 }}>Learning goal</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Your daily practice target counts every completed recall attempt. The dashboard and streak use this value.
        </p>
      </div>
      <label className="field" style={{ margin: 0, maxWidth: 280 }}>
        <span>Practice reps per day</span>
        <input
          className="input"
          type="number"
          inputMode="numeric"
          min={1}
          max={500}
          step={5}
          value={dailyTarget}
          disabled={state === "loading" || state === "saving"}
          onChange={(event) => setDailyTarget(Number(event.target.value))}
        />
      </label>
      <div className="btn-row">
        <button className="btn btn-primary" type="submit" disabled={state === "loading" || state === "saving"}>
          {state === "saving" ? "Saving…" : "Save daily goal"}
        </button>
        <span className="small muted">Recommended starting point: 100</span>
      </div>
      {state === "saved" && <div className="alert alert-ok" style={{ margin: 0 }}>Daily goal saved.</div>}
      {state === "error" && <div className="alert alert-bad" style={{ margin: 0 }}>{message || "Could not save the daily goal."}</div>}
    </form>
  );
}
