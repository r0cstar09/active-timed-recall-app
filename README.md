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
npm run dev -- --host 0.0.0.0 --port 4321   # reachable at https://<tailscale-host>.ts.net
npm run build
```

### Backend URL

By default the app calls the **same origin** it's served from — the recommended
setup is to serve both this frontend and FastAPI behind the same Tailscale host.

To target a different origin, set `PUBLIC_API_BASE_URL` (see `.env.example`) or
override it at runtime in the in-app **Settings** screen (stored in
`localStorage`, handy for testing without a rebuild).

## Backend API contract (assumed)

All backend calls live in [`src/lib/api.ts`](src/lib/api.ts). If the real
FastAPI routes differ, remap them **there** — nothing else in the UI references
raw response shapes.

| Method   | Path                          | Purpose                          |
| -------- | ----------------------------- | -------------------------------- |
| `POST`   | `/api/ingest`                 | start ingestion `{ youtubeUrl }` |
| `GET`    | `/api/ingest/:jobId`          | ingestion job status             |
| `GET`    | `/api/videos`                 | list videos                      |
| `DELETE` | `/api/videos/:videoId`        | delete a video + its cards       |
| `GET`    | `/api/videos/:videoId/cards`  | cards for a video                |
| `GET`    | `/api/stats`                  | due/new/learning counts          |
| `POST`   | `/api/session/start`          | next batch of due cards          |
| `POST`   | `/api/cards/:cardId/attempt`  | upload recall audio (multipart)  |
| `GET`    | `/api/attempts/:attemptId`    | grading status / result          |
| `POST`   | `/api/cards/:cardId/review`   | FSRS self-rating `{ rating }`    |
| `GET`    | `/api/corrections`            | failed cards for review          |

See `src/lib/types.ts` for the exact request/response field shapes.

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
