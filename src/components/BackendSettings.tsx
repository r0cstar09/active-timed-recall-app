import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  getApiBaseOverride,
  getApiBaseUrl,
  getEnvApiBaseUrl,
  setApiBaseOverride,
} from "../lib/config";

type Probe = { state: "idle" | "checking" | "ok" | "fail"; message?: string };

export default function BackendSettings() {
  const [override, setOverride] = useState("");
  const [effective, setEffective] = useState("");
  const [envDefault, setEnvDefault] = useState("");
  const [saved, setSaved] = useState(false);
  const [probe, setProbe] = useState<Probe>({ state: "idle" });

  useEffect(() => {
    setOverride(getApiBaseOverride() ?? "");
    setEffective(getApiBaseUrl() || `${location.origin} (same origin)`);
    setEnvDefault(getEnvApiBaseUrl());
  }, []);

  function save() {
    setApiBaseOverride(override.trim() || null);
    setEffective(getApiBaseUrl() || `${location.origin} (same origin)`);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  function useSameOrigin() {
    setOverride("");
    setApiBaseOverride(null);
    setEffective(`${location.origin} (same origin)`);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  async function testConnection() {
    setProbe({ state: "checking" });
    try {
      const stats = await api.getStats();
      setProbe({
        state: "ok",
        message: `Connected — ${stats.totalCards} cards, ${stats.dueCount} due.`,
      });
    } catch (err) {
      setProbe({
        state: "fail",
        message: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <label className="field" style={{ margin: 0 }}>
          <span>Backend base URL (override)</span>
          <input
            className="input"
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://<tailscale-host>.ts.net"
            value={override}
            onChange={(e) => setOverride(e.target.value)}
          />
        </label>
        <p className="small faint" style={{ margin: 0 }}>
          Leave blank to use the same origin the app is served from
          (recommended when frontend + FastAPI share one Tailscale host). No
          public auth — access is gated by Tailscale.
        </p>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
          <button className="btn" onClick={useSameOrigin}>
            Use same origin
          </button>
        </div>
        {saved && <div className="alert alert-ok" style={{ margin: 0 }}>Saved.</div>}
      </div>

      <div className="card stack">
        <div className="row between">
          <span className="muted">Effective base URL</span>
          <span className="small truncate" style={{ maxWidth: "60%" }}>
            {effective}
          </span>
        </div>
        {envDefault && (
          <div className="row between">
            <span className="muted">Env default</span>
            <span className="small faint truncate" style={{ maxWidth: "60%" }}>
              {envDefault}
            </span>
          </div>
        )}
        <button
          className="btn btn-block"
          onClick={testConnection}
          disabled={probe.state === "checking"}
        >
          {probe.state === "checking" ? "Testing…" : "Test connection"}
        </button>
        {probe.state === "ok" && (
          <div className="alert alert-ok" style={{ margin: 0 }}>{probe.message}</div>
        )}
        {probe.state === "fail" && (
          <div className="alert alert-error" style={{ margin: 0 }}>{probe.message}</div>
        )}
      </div>
    </div>
  );
}
