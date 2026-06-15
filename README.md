# Active Timed Recall

Mobile-first PWA for **Spanish acoustic-first active timed recall**, built with
**Astro** (app shell + routing) and **React** (interactive islands only — no
SPA). Optimized for **iPhone Safari** and served behind **Tailscale HTTPS**
(no public auth).

It drives an existing Python/FastAPI learning engine: YouTube ingestion →
Spanish sentence extraction → native audio slicing → FSRS-like scheduling →
spoken recall capture → transcription/grading → correction feedback.

## Features

- **Ingest** YouTube videos with live job-status polling.
- **Timed recall sessions** — per-card countdown, spoken recall, native + your
  audio playback.
- **Per-card audio recording** via `MediaRecorder` (Safari-friendly `audio/mp4`).
- **Grading status polling** and **correction review** (expected vs. your
  transcript + audio).
- **Library management** — list/expand/delete videos and inspect cards.

## Architecture & constraints

- **Astro app shell** with file-based routing (`src/pages/*.astro`). Each page is
  static HTML that mounts only the React island it needs via `client:load`.
- **React only for islands** (`src/components/*.tsx`). There is no global React
  root and no client-side router — navigation is plain links between Astro pages.
- **Service worker (`public/sw.js`) registers NO `fetch` handler**, so it never
  caches or intercepts requests. Native source audio, recorded audio, and all
  `/api/*` calls hit the network untouched (keeps audio playback working in
  Safari). It exists only to make the app installable.
- **Timer is timestamp-based** (`src/lib/timer.ts`). The absolute `deadline` is
  persisted to `localStorage`, so the countdown auto-resyncs after the phone
  locks / the tab is backgrounded, and survives a full refresh without
  corruption.
- **No public auth** — access is gated by Tailscale at the network layer.

```
src/
  layouts/Base.astro        # HTML shell, PWA meta, SW registration
  components/Nav.astro       # bottom tab bar (static)
  components/*.tsx           # React islands (the only JS shipped)
  lib/config.ts              # backend base-URL resolution (env / localStorage / same-origin)
  lib/api.ts                 # SINGLE source of truth for the backend contract
  lib/types.ts               # domain types
  lib/timer.ts               # crash/refresh-safe recall timer
  lib/recorder.ts            # Safari-friendly MediaRecorder wrapper
  pages/*.astro              # routes: / /ingest /session /library /review /settings
public/
  sw.js                      # non-intercepting service worker
  manifest.webmanifest       # PWA manifest
  icons/*.svg
```

## Setup

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 4321   # https://tonys-alienware-1.tail85fe36.ts.net

# production preview
npm run build
npm run preview -- --host 0.0.0.0 --port 4321
```

### Backend URL

By default the app calls the **same origin** it's served from — the recommended
setup is to serve both this frontend and FastAPI behind the same Tailscale host.

To target a different origin, set `PUBLIC_API_BASE_URL` (see `.env.example`) or
override it at runtime in the in-app **Settings** screen (stored in
`localStorage`, handy for testing without a rebuild).

## Backend API

All backend calls live in [`src/lib/api.ts`](src/lib/api.ts) — the single source
of truth. No public auth (gated by Tailscale); no auth headers are sent.

### Session / grading flow (real contract)

Grading is **async on the backend** — the client never self-grades.

| Step | Method | Path                                          | Purpose                       |
| ---- | ------ | --------------------------------------------- | ----------------------------- |
| 1    | `POST` | `/api/sessions`                               | create session → `Session`    |
| 2–4  | `POST` | `/api/sessions/:sid/items/:itemId/recording`  | upload recall audio (per item)|
| 5    | `POST` | `/api/sessions/:sid/grade`                     | start grading → `{ job_id }`  |
| 6    | `GET`  | `/api/jobs/:jobId`                            | poll job until `complete`     |
| 7    | `GET`  | `/api/sessions/:sid`                           | graded items + summary        |

**Recording upload** is `multipart/form-data` with fields: `audio` (file),
`mime_type`, `prompt_shown_at`, `answered_at`, `response_seconds`, `timed_out`.

**Audio URLs**: items return `source_audio_url` like
`/api/audio/source/VdzhL4xsrhA/39320.mp3`, used directly as `apiBase + url`. In
production `apiBase` is the empty string (same origin), so the URL is used as-is.

### Library / stats / health (real contract)

| Method | Path           | Purpose                                 |
| ------ | -------------- | --------------------------------------- |
| `GET`  | `/health`      | liveness (used by Settings → Test)      |
| `GET`  | `/api/stats`   | stats (connectivity check)              |
| `GET`  | `/api/sources` | ingested sources (`Source[]`)           |
| `GET`  | `/api/cards`   | scheduled cards (`Card[]`)              |

The home dashboard derives Due/New/Learning counts **client-side** from
`/api/cards` (+ `/api/sources` count), since the `/api/stats` body shape isn't
pinned down.

### Ingestion (assumed)

No confirmed contract; isolated in `api.ts` and easy to remap:
`POST /api/sources { source_url }` then poll `GET /api/sources/:id` for
`transcript_status` / `audio_status`.

See `src/lib/types.ts` for exact field shapes (`Source`, `SourceRaw`, `Phrase`,
`Card`, `SessionItem`, `SessionSummary`, `Session`, `Job`).

### Configuration

- `PUBLIC_API_BASE_URL` — leave **empty in production** (same origin). For local
  dev against a separate backend, set `http://127.0.0.1:8788`. Also overridable
  at runtime in the Settings screen.
- `PUBLIC_RECALL_SECONDS` — per-item recall countdown (default `8`).

## iPhone Safari acceptance tests

1. App loads over `https://<tailscale-host>.ts.net`.
2. iPhone allows microphone permission.
3. Start session.
4. Timer counts down accurately.
5. Lock/switch app briefly; returning auto-resyncs the timer.
6. Record one answer.
7. Upload succeeds.
8. Native source audio plays in Safari.
9. Recorded audio plays in Safari.
10. Failed correction card shows expected/user transcript/audio.
11. Service worker does not break audio playback.
12. Refresh during session does not corrupt current timer state.
