/**
 * Backend base-URL resolution.
 *
 * Priority order:
 *   1. Runtime override saved in localStorage (Settings screen) — useful for
 *      testing against a different Tailscale host without a rebuild.
 *   2. Build-time env var `PUBLIC_API_BASE_URL`.
 *   3. Same origin the app is served from (recommended: frontend + FastAPI
 *      behind the same Tailscale HTTPS host).
 *
 * All of these intentionally avoid any public auth — access control is handled
 * by Tailscale at the network layer.
 */

const STORAGE_KEY = "atr.apiBaseUrl";
const TAILNET_API_BASE_URL = "https://tonys-alienware-1.tail85fe36.ts.net";

/**
 * HA base chain, probed in order when the built-in tailnet default applies:
 *   1. Tailnet primary — direct to the Alienware, fastest at home.
 *   2. Cloudflare Tunnel to the SAME Alienware backend — reachable from
 *      anywhere, still the write-primary / source of truth.
 *   3. Cloudflare LB (VPS primary -> GCP fallback) — only when the Alienware
 *      itself is down. Data lags by the sync interval, and progress written
 *      here is reconciled when the Alienware returns.
 * Explicit overrides and same-origin setups are never failed over.
 */
const PUBLIC_ALIENWARE_BASE_URL = "https://alienware-spanish.tonymuzo.dev";
const HA_FALLBACK_BASE_URL = "https://api-spanish.tonymuzo.dev";

const BASE_CACHE_KEY = "atr.activeApiBase";
const BASE_CACHE_TTL_MS = 3 * 60 * 1000;

let activeBase: string | null = null;

/** Candidate bases in probe order; single-element when failover is disabled. */
export function getBaseCandidates(): string[] {
  const preferred = getPreferredApiBaseUrl();
  if (preferred !== TAILNET_API_BASE_URL) return [preferred];
  return [TAILNET_API_BASE_URL, PUBLIC_ALIENWARE_BASE_URL, HA_FALLBACK_BASE_URL];
}

/** True while requests are routed somewhere other than the preferred base. */
export function isUsingFallbackBase(): boolean {
  return activeBase !== null && activeBase !== getPreferredApiBaseUrl();
}

/** Route requests to the given base (null = preferred) and remember it briefly. */
export function setActiveBase(base: string | null): void {
  activeBase = base;
  if (typeof localStorage === "undefined") return;
  if (base) {
    localStorage.setItem(BASE_CACHE_KEY, JSON.stringify({ base, ts: Date.now() }));
  } else {
    localStorage.removeItem(BASE_CACHE_KEY);
  }
}

/** Recently confirmed base from a prior page load, if still fresh and valid. */
export function getCachedActiveBase(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(BASE_CACHE_KEY);
    if (!raw) return null;
    const { base, ts } = JSON.parse(raw) as { base?: unknown; ts?: unknown };
    if (
      typeof base === "string" &&
      typeof ts === "number" &&
      getBaseCandidates().includes(base) &&
      Date.now() - ts < BASE_CACHE_TTL_MS
    ) {
      return base;
    }
  } catch {
    /* ignore corrupt cache */
  }
  return null;
}

const ENV_BASE_URL = (import.meta.env.PUBLIC_API_BASE_URL ?? "").trim();

/**
 * Recall countdown length (seconds) per item. SessionItems don't carry a
 * per-item limit, so this is the global timed-recall window. Override with
 * PUBLIC_RECALL_SECONDS at build time if needed.
 */
const ENV_RECALL_SECONDS = Number(import.meta.env.PUBLIC_RECALL_SECONDS ?? "");
export const RECALL_SECONDS =
  Number.isFinite(ENV_RECALL_SECONDS) && ENV_RECALL_SECONDS > 0
    ? ENV_RECALL_SECONDS
    : 8;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Read the runtime override (browser only). */
export function getApiBaseOverride(): string | null {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(STORAGE_KEY);
  return v && v.trim() ? stripTrailingSlash(v.trim()) : null;
}

/** Persist (or clear) the runtime override. */
export function setApiBaseOverride(url: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (url && url.trim()) {
    localStorage.setItem(STORAGE_KEY, stripTrailingSlash(url.trim()));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** The preferred base URL before any automatic failover is applied. */
function getPreferredApiBaseUrl(): string {
  const override = getApiBaseOverride();
  if (override) return override;
  if (ENV_BASE_URL) return stripTrailingSlash(ENV_BASE_URL);
  if (typeof window !== "undefined" && window.location.hostname === "spanish-app.tonymuzo.dev") {
    return TAILNET_API_BASE_URL;
  }
  return ""; // same-origin for local preview or a future co-hosted deployment
}

/**
 * The effective base URL used for all API + media requests.
 * Returns "" (empty string) when same-origin should be used, in which case
 * callers build same-origin-relative URLs like `/api/...`.
 */
export function getApiBaseUrl(): string {
  const preferred = getPreferredApiBaseUrl();
  if (activeBase && preferred === TAILNET_API_BASE_URL) {
    return activeBase;
  }
  return preferred;
}

/** The configured env default, exposed for display in Settings. */
export function getEnvApiBaseUrl(): string {
  return ENV_BASE_URL ? stripTrailingSlash(ENV_BASE_URL) : "";
}

/**
 * Resolve a possibly-relative URL (e.g. an audio path returned by the backend)
 * into an absolute URL against the configured base. Absolute URLs pass through.
 */
export function resolveUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return pathOrUrl;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = getApiBaseUrl();
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${path}`;
}
