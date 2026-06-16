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

/**
 * The effective base URL used for all API + media requests.
 * Returns "" (empty string) when same-origin should be used, in which case
 * callers build same-origin-relative URLs like `/api/...`.
 */
export function getApiBaseUrl(): string {
  const override = getApiBaseOverride();
  if (override) return override;
  if (ENV_BASE_URL) return stripTrailingSlash(ENV_BASE_URL);
  if (typeof window !== "undefined" && window.location.hostname === "spanish-app.tonymuzo.dev") {
    return TAILNET_API_BASE_URL;
  }
  return ""; // same-origin for local preview or a future co-hosted deployment
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
