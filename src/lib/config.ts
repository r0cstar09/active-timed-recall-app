/**
 * Backend base-URL resolution.
 *
 * Priority order:
 *   1. Runtime override saved in localStorage (Settings screen) — useful for
 *      testing against a different host without a rebuild.
 *   2. Build-time env var `PUBLIC_API_BASE_URL`.
 *   3. Built-in default: the Cloudflare Load Balancer in front of the VPS
 *      (GCP standby). Failover is handled SERVER-SIDE by the LB's health
 *      monitors — the client always talks to one URL.
 *
 * Single-source-of-truth doctrine (2026-07-08): the VPS Postgres is the only
 * write target. The old client-side base chain (Alienware tailnet → Alienware
 * tunnel → LB) is retired because it split writes across two databases.
 */

const STORAGE_KEY = "atr.apiBaseUrl";

/** Cloudflare LB: VPS primary → GCP fallback, health-routed server-side. */
const API_LB_BASE_URL = "https://api-spanish.tonymuzo.dev";

/** Retired write targets: silently dropped if found in a saved override. */
const RETIRED_BASES = new Set([
  "https://tonys-alienware-1.tail85fe36.ts.net",
  "https://alienware-spanish.tonymuzo.dev",
]);

const BASE_CACHE_KEY = "atr.activeApiBase";

/** Single candidate: the LB does failover, the client never probes. */
export function getBaseCandidates(): string[] {
  return [getPreferredApiBaseUrl()];
}

/** Legacy chain API kept for callers; always false now (no client failover). */
export function isUsingFallbackBase(): boolean {
  return false;
}

/** Legacy chain API kept for callers; clears any stale cached base. */
export function setActiveBase(_base: string | null): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(BASE_CACHE_KEY);
}

/** Legacy chain API kept for callers; the cache is retired. */
export function getCachedActiveBase(): string | null {
  if (typeof localStorage !== "undefined") localStorage.removeItem(BASE_CACHE_KEY);
  return null;
}

const ENV_BASE_URL = (import.meta.env.PUBLIC_API_BASE_URL ?? "").trim();

/**
 * Recall countdown length (seconds) per item. Every timed recall session runs
 * exactly 15s; do not make this adaptive or environment-dependent.
 */
export const RECALL_SECONDS = 15;

/**
 * Hard ceiling for any per-item recall window (seconds). The backend clamps
 * server-side too; this client clamp guarantees the countdown can never show a
 * 30s+ window even against a stale backend.
 */
export const MAX_RECALL_SECONDS = 15;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Read the runtime override (browser only). */
export function getApiBaseOverride(): string | null {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(STORAGE_KEY);
  const clean = v && v.trim() ? stripTrailingSlash(v.trim()) : null;
  if (clean && RETIRED_BASES.has(clean)) {
    // Old Alienware targets are retired write paths; never resurrect them.
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return clean;
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

/** The preferred (and only) base URL. */
function getPreferredApiBaseUrl(): string {
  const override = getApiBaseOverride();
  if (override) return override;
  if (ENV_BASE_URL) return stripTrailingSlash(ENV_BASE_URL);
  if (typeof window !== "undefined" && window.location.hostname === "spanish-app.tonymuzo.dev") {
    return API_LB_BASE_URL;
  }
  return ""; // same-origin for local preview or a future co-hosted deployment
}

/**
 * The effective base URL used for all API + media requests.
 * Returns "" (empty string) when same-origin should be used, in which case
 * callers build same-origin-relative URLs like `/api/...`.
 */
export function getApiBaseUrl(): string {
  return getPreferredApiBaseUrl();
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
