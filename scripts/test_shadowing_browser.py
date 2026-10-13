#!/usr/bin/env python3
"""Read-only Chromium/WebKit browser harness for the dedicated shadowing player.

Fixture mode is deterministic and is restricted to a loopback preview. It
fulfills every API/media read in-process, serves a real PCM WAV test tone, and
fails on attempted writes or unexpected network dependencies. ``--live`` is a
separate read-only smoke test: it uses the site's actual GET API/media reads,
never grades or starts an FSRS session, and keeps learner text out of JSON.

Run this on the Alienware browser worker or CI, never on the Hermes VPS::

    python3 scripts/test_shadowing_browser.py \
      --base http://127.0.0.1:4321 \
      --browser chromium --browser webkit \
      --output artifacts/shadowing-browser

Omitting ``--browser`` runs both engines. Playwright 1.63 browser binaries are
expected to be installed by CI/the browser worker. The preview server must
already be running; this script does not start it.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import socket
import struct
import sys
import time
import wave
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlparse

if TYPE_CHECKING:
    from playwright.sync_api import Browser, Page

try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright
    PLAYWRIGHT_IMPORT_ERROR: ImportError | None = None
except ImportError as exc:  # pragma: no cover - depends on runner provisioning
    # Keep --help, argument validation, and the explicit VPS launch refusal
    # usable on control-plane hosts that intentionally have no browser stack.
    PlaywrightTimeoutError = TimeoutError
    sync_playwright = None
    PLAYWRIGHT_IMPORT_ERROR = exc


SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
LIVE_PAGE_LIFETIMES = frozenset({"today-entry", "shadow-playback-exit"})
GUARD_BLOCK_FAILURES = frozenset({"net::ERR_BLOCKED_BY_CLIENT", "Load request cancelled"})
THEMES = {"light": "paper", "dark": "dark"}
DEVICES: dict[str, dict[str, Any]] = {
    "desktop": {
        "viewport": {"width": 1440, "height": 1000},
        "screen": {"width": 1440, "height": 1000},
        "device_scale_factor": 1,
        "has_touch": False,
        "is_mobile": False,
    },
    "mobile-390": {
        "viewport": {"width": 390, "height": 844},
        "screen": {"width": 390, "height": 844},
        "device_scale_factor": 1,
        "has_touch": True,
        "is_mobile": True,
        "user_agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
            "Mobile/15E148 Safari/604.1"
        ),
    },
    "mobile-320": {
        "viewport": {"width": 320, "height": 700},
        "screen": {"width": 320, "height": 700},
        "device_scale_factor": 1,
        "has_touch": True,
        "is_mobile": True,
        "user_agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 "
            "Mobile/15E148 Safari/604.1"
        ),
    },
}
FIXTURE_TOTAL = 108
WAV_LABEL = "Synthetic browser QA test tone"
MAIN_MEDIA = "/api/media/phrases/1.wav"
ALT_MEDIA = "/api/media/phrases/2.wav"
PENDING_MEDIA = "/api/media/phrases/3.wav"
ERROR_MEDIA = "/api/media/phrases/4.wav"
REJECT_MEDIA = "/api/media/phrases/5.wav"
UNKNOWN_MEDIA = "/api/media/phrases/107.wav"
UNKNOWN_MEDIA_2 = "/api/media/phrases/108.wav"
GENERATED_MEDIA_PREFIX = "/api/study/sentence-packs/42/audio/"
MAIN_SPANISH = "Ritmo sintético principal para la prueba."
MAIN_ENGLISH = "Primary synthetic rhythm for the test."
ALT_SPANISH = "Bucle sintético breve para la prueba."
ALT_ENGLISH = "Short synthetic loop for the test."
MISSING_SPANISH = "Frase sintética sin audio."


MEDIA_TRACKER_JS = r"""
(() => {
  if (window.__shadowQaInstalled) return;
  window.__shadowQaInstalled = true;
  const NativeAudio = window.Audio;
  const nativeCreateElement = Document.prototype.createElement;
  const nativePlay = HTMLMediaElement.prototype.play;
  const nativePause = HTMLMediaElement.prototype.pause;
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const tracked = new WeakSet();
  const media = [];
  const events = [];
  let timerRecords = [];
  const timerByHandle = new Map();
  let rejectedFixturePlay = false;

  const now = () => Math.round(performance.now() * 10) / 10;
  const bumpSession = (key) => {
    try {
      const value = Number(sessionStorage.getItem(key) || '0') + 1;
      sessionStorage.setItem(key, String(value));
    } catch (_) {}
  };
  const pathOf = (element) => {
    try { return new URL(element.currentSrc || element.src || '', location.href).pathname; }
    catch (_) { return ''; }
  };
  const record = (type, element, extra = {}) => {
    const index = media.indexOf(element);
    events.push({type, media: index, at: now(), ...extra});
  };
  const track = (element) => {
    if (!(element instanceof HTMLMediaElement) || tracked.has(element)) return element;
    tracked.add(element);
    media.push(element);
    const detachedAtCreate = !element.isConnected;
    element.__shadowQaDetachedAtCreate = detachedAtCreate;
    record('created', element, {detachedAtCreate});
    for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'ended', 'error', 'emptied']) {
      element.addEventListener(type, () => record(type, element));
    }
    return element;
  };

  function HarnessAudio(...args) {
    return track(new NativeAudio(...args));
  }
  HarnessAudio.prototype = NativeAudio.prototype;
  Object.setPrototypeOf(HarnessAudio, NativeAudio);
  Object.defineProperty(window, 'Audio', {value: HarnessAudio, configurable: true, writable: true});
  Document.prototype.createElement = function(tagName, ...args) {
    return track(nativeCreateElement.call(this, tagName, ...args));
  };

  HTMLMediaElement.prototype.play = function(...args) {
    track(this);
    record('play-call', this, {connected: this.isConnected, rate: this.playbackRate});
    bumpSession('__shadowQaPlayCalls');
    if (pathOf(this) === '/api/media/phrases/5.wav' && !rejectedFixturePlay) {
      rejectedFixturePlay = true;
      record('play-rejected', this, {name: 'NotAllowedError'});
      return Promise.reject(new DOMException('Synthetic browser QA play rejection', 'NotAllowedError'));
    }
    return nativePlay.apply(this, args);
  };
  HTMLMediaElement.prototype.pause = function(...args) {
    track(this);
    record('pause-call', this);
    bumpSession('__shadowQaPauseCalls');
    return nativePause.apply(this, args);
  };

  window.setTimeout = function(callback, delay = 0, ...args) {
    const recordValue = {delay: Number(delay) || 0, scheduledAt: now(), cleared: false, fired: false};
    const handle = nativeSetTimeout(() => {
      recordValue.fired = true;
      timerByHandle.delete(handle);
      callback(...args);
    }, delay);
    timerRecords.push(recordValue);
    timerByHandle.set(handle, recordValue);
    return handle;
  };
  window.clearTimeout = function(handle) {
    const timer = timerByHandle.get(handle);
    if (timer) {
      timer.cleared = true;
      timer.clearedAt = now();
      timerByHandle.delete(handle);
    }
    return nativeClearTimeout(handle);
  };

  window.__shadowQa = {
    summary() {
      return {
        media: media.map((element, index) => ({
          index,
          currentTime: Number.isFinite(element.currentTime) ? Math.round(element.currentTime * 1000) / 1000 : null,
          duration: Number.isFinite(element.duration) ? Math.round(element.duration * 1000) / 1000 : null,
          playbackRate: element.playbackRate,
          paused: element.paused,
          ended: element.ended,
          connected: element.isConnected,
          detachedAtCreate: Boolean(element.__shadowQaDetachedAtCreate),
          path: pathOf(element),
        })),
        events: events.slice(),
        timers: timerRecords.map((timer) => ({...timer})),
        sessionPlayCalls: Number(sessionStorage.getItem('__shadowQaPlayCalls') || '0'),
        sessionPauseCalls: Number(sessionStorage.getItem('__shadowQaPauseCalls') || '0'),
      };
    },
    resetTimers() {
      timerRecords = [];
    },
    selectedUrl() {
      const element = media[media.length - 1];
      return element ? (element.currentSrc || element.src || '') : '';
    },
    dispatch(index, type) {
      const element = media[index];
      if (!element) return false;
      element.dispatchEvent(new Event(type));
      return true;
    },
  };
})();
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read-only Chromium/WebKit browser regression harness for /shadow/"
    )
    parser.add_argument("--base", required=True, help="Bare preview/live HTTP(S) origin")
    parser.add_argument(
        "--browser",
        dest="browsers",
        choices=("chromium", "webkit"),
        action="append",
        help="Browser engine; repeat to run both (default: chromium and webkit)",
    )
    parser.add_argument("--output", required=True, type=Path, help="Evidence directory")
    parser.add_argument(
        "--live",
        action="store_true",
        help="Read-only live smoke test using actual GET API/media; writes remain blocked",
    )
    parser.add_argument("--timeout", type=int, default=15_000, help="Per-operation timeout in milliseconds")
    parser.add_argument(
        "--max-seconds",
        type=int,
        default=290,
        help="Bounded suite deadline (default 290; maximum 295)",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> tuple[str, list[str]]:
    parsed = urlparse(args.base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit("--base must be an absolute HTTP(S) origin")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise SystemExit("--base must be a bare origin with no credentials, path, query, or fragment")
    if not args.live and parsed.hostname not in LOOPBACK_HOSTS:
        raise SystemExit(
            "Fixture mode is restricted to localhost, 127.0.0.1, or ::1. Use --live explicitly "
            "for a read-only deployed-origin smoke test."
        )
    if args.timeout < 3_000 or args.timeout > 30_000:
        raise SystemExit("--timeout must be between 3000 and 30000 milliseconds")
    if args.max_seconds < 30 or args.max_seconds > 295:
        raise SystemExit("--max-seconds must be between 30 and 295")
    browsers = list(dict.fromkeys(args.browsers or ["chromium", "webkit"]))
    return args.base.rstrip("/"), browsers


def refuse_vps_browser_launch() -> str:
    host = socket.gethostname()
    normalized = host.casefold()
    if "vps" in normalized or normalized == "hermes-vps":
        raise SystemExit(
            f"Refusing to launch Playwright on VPS host {host!r}. Run this harness on "
            "the Alienware browser worker or CI."
        )
    return host


def synthetic_wav(duration: float, frequency: float) -> bytes:
    """Generate labelled, decodable 16-bit mono PCM entirely in memory."""
    sample_rate = 16_000
    frame_count = int(duration * sample_rate)
    pcm = bytearray()
    fade_frames = max(1, int(sample_rate * 0.02))
    for index in range(frame_count):
        envelope = min(1.0, index / fade_frames, (frame_count - index - 1) / fade_frames)
        sample = int(0.18 * 32767 * max(0.0, envelope) * math.sin(2 * math.pi * frequency * index / sample_rate))
        pcm.extend(struct.pack("<h", sample))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(bytes(pcm))
    wav = bytearray(buffer.getvalue())
    label = WAV_LABEL.encode("ascii") + b"\x00"
    inam = b"INAM" + struct.pack("<I", len(label)) + label + (b"\x00" if len(label) % 2 else b"")
    payload = b"INFO" + inam
    info_chunk = b"LIST" + struct.pack("<I", len(payload)) + payload + (b"\x00" if len(payload) % 2 else b"")
    wav.extend(info_chunk)
    wav[4:8] = struct.pack("<I", len(wav) - 8)
    return bytes(wav)


MAIN_WAV = synthetic_wav(2.4, 440.0)
SHORT_WAV = synthetic_wav(0.62, 554.37)


def fixture_cards(base: str) -> list[dict[str, Any]]:
    def imported(
        phrase_id: int,
        spanish: str,
        english: str,
        media_path: str,
        video_id: str,
        source_id: int,
    ) -> dict[str, Any]:
        return {
            "phrase_id": phrase_id,
            "spanish": spanish,
            "english": english,
            "context_clue": None,
            "cloze_prompt": None,
            "audio_url": f"{base}{media_path}" if media_path else "",
            "active": True,
            "source_id": source_id,
            "source_type": "youtube",
            "source_url": f"https://www.youtube.com/watch?v={video_id}",
        }

    imported_cards = [
        imported(1, MAIN_SPANISH, MAIN_ENGLISH, MAIN_MEDIA, "abcdefghijk", 101),
        imported(2, ALT_SPANISH, ALT_ENGLISH, ALT_MEDIA, "abcdefghijk", 101),
        imported(3, "Audio sintético pendiente para cambiar de fuente.", "Pending synthetic audio for a source switch.", PENDING_MEDIA, "abcdefghijk", 101),
        imported(4, "Audio sintético con un error recuperable.", "Synthetic audio with a recoverable error.", ERROR_MEDIA, "lmnopqrstuv", 102),
        imported(5, "Audio sintético con reproducción rechazada.", "Synthetic audio with rejected playback.", REJECT_MEDIA, "lmnopqrstuv", 102),
        imported(6, MISSING_SPANISH, "Synthetic phrase without audio.", "", "lmnopqrstuv", 102),
    ]
    generated_cards = [
        {
            "phrase_id": phrase_id,
            "spanish": f"Frase sintética generada {phrase_id:03d}.",
            "english": f"Generated synthetic sentence {phrase_id:03d}.",
            "context_clue": None,
            "cloze_prompt": None,
            "audio_url": f"{base}{GENERATED_MEDIA_PREFIX}{phrase_id}.wav",
            "active": True,
            "source_id": 4200,
            "source_type": "sentence_pack",
            "source_url": "/api/study/sentence-packs/42",
        }
        for phrase_id in range(7, 107)
    ]
    unknown_cards = [
        {
            "phrase_id": 107,
            "spanish": "Frase sintética de procedencia desconocida.",
            "english": "Synthetic phrase of unknown provenance.",
            "context_clue": None,
            "cloze_prompt": None,
            "audio_url": f"{base}{UNKNOWN_MEDIA}",
            "active": True,
            "source_id": 9001,
            "source_type": "field_recording",
            "source_url": "https://fixture.invalid/field-recording",
        },
        {
            "phrase_id": 108,
            "spanish": "Otra frase sintética sin procedencia.",
            "english": "Another synthetic phrase without provenance.",
            "context_clue": None,
            "cloze_prompt": None,
            "audio_url": f"{base}{UNKNOWN_MEDIA_2}",
            "active": True,
            "source_id": None,
            "source_type": None,
            "source_url": None,
        },
    ]
    # Deliberately start with non-imported cards. The UI/core must put valid
    # imported YouTube audio first rather than inheriting backend order.
    cards = [generated_cards[0], unknown_cards[0], *imported_cards, *generated_cards[1:], unknown_cards[1]]
    assert len(cards) == FIXTURE_TOTAL
    return cards


def json_response(route: Any, status: int, payload: Any) -> None:
    route.fulfill(
        status=status,
        content_type="application/json",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Cache-Control": "no-store",
        },
        body=json.dumps(payload, ensure_ascii=False),
    )


def request_record(request: Any) -> dict[str, Any]:
    parsed = urlparse(request.url)
    return {"method": request.method.upper(), "path": parsed.path, "host": parsed.hostname or ""}


def private_request_record(request: Any) -> dict[str, Any]:
    """Retain exact request identity only in memory for relational checks.

    ``_url`` must never be copied to a report. Live media URLs can identify
    learner-selected material, so public evidence uses fixed relation labels.
    """
    return {
        **request_record(request),
        "_url": request.url,
        "resource_type": request.resource_type,
        "is_navigation_request": bool(request.is_navigation_request()),
        "observed_at": time.monotonic(),
    }


def is_cloudflare_beacon(parsed: Any) -> bool:
    return parsed.hostname == "static.cloudflareinsights.com" and bool(
        re.fullmatch(r"/beacon\.min\.js(?:/.*)?", parsed.path)
    )


def http_origin(url: str) -> tuple[str, str, int] | None:
    """Return a normalized HTTP origin tuple, including the effective port."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    return (
        parsed.scheme.casefold(),
        parsed.hostname.casefold(),
        port if port is not None else (443 if parsed.scheme == "https" else 80),
    )


def is_exact_same_origin_rum(url: str, base_origin: str) -> bool:
    parsed = urlparse(url)
    return bool(
        http_origin(url) == http_origin(base_origin)
        and parsed.path == "/cdn-cgi/rum"
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
        and "?" not in url
        and "#" not in url
    )


class FixtureRouter:
    """Fail-closed, page-local fixture router for API and media reads."""

    def __init__(self, base: str, scenario: str) -> None:
        parsed = urlparse(base)
        self.base_netloc = parsed.netloc
        self.cards = fixture_cards(base)
        self.scenario = scenario
        self.api_requests: list[dict[str, Any]] = []
        self.media_requests: list[dict[str, Any]] = []
        self.unexpected_api_gets: list[dict[str, Any]] = []
        self.mutation_attempts: list[dict[str, Any]] = []
        self.blocked_external: list[dict[str, Any]] = []
        self.telemetry: list[dict[str, Any]] = []
        self.held_media: list[Any] = []
        self.error_media_attempts = 0

    def install(self, page: Page) -> None:
        page.route("**/*", self.handle)

    def handle(self, route: Any) -> None:
        request = route.request
        method = request.method.upper()
        parsed = urlparse(request.url)
        record = request_record(request)

        if is_cloudflare_beacon(parsed):
            self.telemetry.append({**record, "kind": "cloudflare-beacon", "action": "fulfilled-locally"})
            if method not in SAFE_METHODS:
                self.mutation_attempts.append(record)
                route.abort("blockedbyclient")
            else:
                route.fulfill(
                    status=200,
                    content_type="application/javascript",
                    headers={"Cache-Control": "no-store"},
                    body="/* exact Cloudflare beacon disabled by shadowing fixture QA */",
                )
            return

        if parsed.netloc == self.base_netloc and parsed.path == "/cdn-cgi/rum":
            self.telemetry.append({**record, "kind": "cloudflare-rum", "action": "blocked"})
            route.abort("blockedbyclient")
            return

        if method not in SAFE_METHODS:
            self.mutation_attempts.append(record)
            route.abort("blockedbyclient")
            return

        if parsed.scheme in {"blob", "data"}:
            route.continue_()
            return

        path = parsed.path
        is_generated_media = path.startswith(GENERATED_MEDIA_PREFIX) and path.endswith(".wav")
        known_media = {
            MAIN_MEDIA,
            ALT_MEDIA,
            PENDING_MEDIA,
            ERROR_MEDIA,
            REJECT_MEDIA,
            UNKNOWN_MEDIA,
            UNKNOWN_MEDIA_2,
        }
        if parsed.netloc == self.base_netloc and (path in known_media or is_generated_media):
            self.media_requests.append(record)
            if path == PENDING_MEDIA and self.scenario == "pending_source_switch":
                self.held_media.append(route)
                return
            if path == ERROR_MEDIA:
                self.error_media_attempts += 1
                if self.scenario == "error_retry" and self.error_media_attempts == 1:
                    route.fulfill(
                        status=404,
                        content_type="text/plain",
                        headers={"Cache-Control": "no-store"},
                        body="Synthetic browser QA media failure",
                    )
                    return
            body = MAIN_WAV if path == MAIN_MEDIA else SHORT_WAV
            route.fulfill(
                status=200,
                content_type="audio/wav",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "no-store",
                    "X-QA-Media-Label": WAV_LABEL,
                },
                body=body,
            )
            return

        if parsed.netloc == self.base_netloc and (path == "/api" or path.startswith("/api/")):
            self.api_requests.append(record)
            if method == "OPTIONS":
                route.fulfill(
                    status=204,
                    headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Headers": "*",
                        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                        "Cache-Control": "no-store",
                    },
                    body="",
                )
                return
            if path.rstrip("/") == "/api/cards":
                query = parse_qs(parsed.query)
                try:
                    limit = int((query.get("limit") or ["100"])[0])
                    offset = int((query.get("offset") or ["0"])[0])
                except ValueError:
                    limit, offset = 100, 0
                active = (query.get("active") or [""])[0]
                record["query"] = {"active": active, "limit": limit, "offset": offset}
                if active != "1" or limit != 100 or offset not in {0, 100}:
                    self.unexpected_api_gets.append(dict(record))
                payload = {
                    "cards": deepcopy(self.cards[offset : offset + limit]),
                    "total": len(self.cards),
                    "limit": limit,
                    "offset": offset,
                }
                json_response(route, 200, payload)
                return
            if path.rstrip("/") == "/api/stats":
                json_response(
                    route,
                    200,
                    {
                        "due_count": 0,
                        "new_count": 0,
                        "review_count": 0,
                        "learning_count": 0,
                        "suspended_count": 0,
                        "habit": {
                            "available": True,
                            "timezone": "UTC",
                            "local_date": "2026-10-13",
                            "daily_target": 10,
                            "today_reps": 0,
                            "remaining_reps": 10,
                            "target_met": False,
                            "current_streak": 0,
                            "practiced_today": False,
                            "recent_days": [],
                        },
                    },
                )
                return
            if path.rstrip("/") == "/api/sources":
                json_response(route, 200, {"sources": [], "total": 0})
                return
            self.unexpected_api_gets.append(record)
            json_response(route, 418, {"detail": "Unexpected API read blocked by shadowing fixture QA"})
            return

        if parsed.netloc != self.base_netloc:
            self.blocked_external.append(record)
            route.abort("blockedbyclient")
            return

        # Same-origin document, JS, CSS, fonts, icons, and manifest reads are
        # preview assets. API and media reads have already been handled above.
        route.continue_()

    def wait_for_held_media(self, page: Page, timeout_ms: int) -> Any:
        deadline = time.monotonic() + timeout_ms / 1000
        while time.monotonic() < deadline:
            if self.held_media:
                return self.held_media.pop(0)
            page.wait_for_timeout(25)
        raise PlaywrightTimeoutError("Pending synthetic media request was not observed")

    def release_held(self, route: Any, *, fulfill: bool) -> str:
        try:
            if fulfill:
                route.fulfill(
                    status=200,
                    content_type="audio/wav",
                    headers={"Cache-Control": "no-store", "X-QA-Media-Label": WAV_LABEL},
                    body=SHORT_WAV,
                )
                return "fulfilled"
            route.abort("blockedbyclient")
            return "aborted"
        except Exception as exc:  # request may already be cancelled by src detachment
            return f"already-cancelled:{type(exc).__name__}"

    def evidence(self) -> dict[str, Any]:
        pagination = []
        for item in self.api_requests:
            if item["path"].rstrip("/") != "/api/cards":
                continue
            # The handler records normalized values from the actual intercepted
            # URL, so evidence preserves both exact page queries without bodies.
            pagination.append(item)
        return {
            "api_requests": self.api_requests,
            "pagination_request_count": len(pagination),
            "media_requests": self.media_requests,
            "unexpected_api_gets": self.unexpected_api_gets,
            "mutation_attempts": self.mutation_attempts,
            "blocked_external": self.blocked_external,
            "telemetry": self.telemetry,
            "error_media_attempts": self.error_media_attempts,
        }


class LiveRouter:
    """Read-only live guard. It changes no GET response and stores no query/text."""

    def __init__(self, base: str) -> None:
        self.base_origin = base.rstrip("/")
        self.base_netloc = urlparse(base).netloc
        self.reads: list[dict[str, Any]] = []
        self.api_get_count = 0
        self.media_get_count = 0
        self.mutation_attempts: list[dict[str, Any]] = []
        self.expected_telemetry_attempts: list[dict[str, Any]] = []
        self.telemetry: list[dict[str, Any]] = []

    def install(self, page: Page, *, page_lifetime: str) -> None:
        page.route(
            "**/*",
            lambda route: self.handle(route, page_lifetime=page_lifetime),
        )

    def handle(self, route: Any, *, page_lifetime: str = "unknown") -> None:
        request = route.request
        method = request.method.upper()
        parsed = urlparse(request.url)
        record = {**private_request_record(request), "page_lifetime": page_lifetime}
        public_record = {**request_record(request), "page_lifetime": page_lifetime}

        # Account for every unsafe method before any broad telemetry handling.
        # Cloudflare's exact same-origin RUM POST is the sole expected exception:
        # it is separately counted, blocked by this guard, and never dispatched.
        if method not in SAFE_METHODS:
            if method == "POST" and is_exact_same_origin_rum(
                request.url, self.base_origin
            ):
                guard_record = {
                    **record,
                    "kind": "cloudflare-rum",
                    "guard_action": "blockedbyclient",
                }
                self.expected_telemetry_attempts.append(guard_record)
                self.telemetry.append(
                    {
                        **public_record,
                        "kind": "cloudflare-rum",
                        "action": "expected-POST-blocked",
                    }
                )
            else:
                self.mutation_attempts.append(record)
            route.abort("blockedbyclient")
            return

        if is_cloudflare_beacon(parsed):
            self.telemetry.append(
                {
                    **public_record,
                    "kind": "cloudflare-beacon",
                    "action": "safe-method-allowed",
                }
            )
        if method == "GET" and parsed.netloc in {self.base_netloc, "api-spanish.tonymuzo.dev"} and parsed.path.startswith("/api/"):
            self.api_get_count += 1
        if method == "GET" and request.resource_type == "media":
            self.media_get_count += 1
        self.reads.append(record)
        route.continue_()

    def evidence(self) -> dict[str, Any]:
        method_counts = {
            method: sum(item["method"] == method for item in self.reads)
            for method in sorted(SAFE_METHODS)
        }
        return {
            "read_count": len(self.reads),
            "read_method_counts": method_counts,
            "same_origin_read_count": sum(item["host"] == urlparse(f"https://{self.base_netloc}").hostname for item in self.reads),
            "api_get_count": self.api_get_count,
            "media_get_count": self.media_get_count,
            "mutation_attempt_count": len(self.mutation_attempts),
            "mutation_methods": sorted({item["method"] for item in self.mutation_attempts}),
            "expected_telemetry_attempt_count": len(self.expected_telemetry_attempts),
            "expected_telemetry_methods": sorted(
                {item["method"] for item in self.expected_telemetry_attempts}
            ),
            "expected_telemetry_page_lifetimes": sorted(
                {item["page_lifetime"] for item in self.expected_telemetry_attempts}
            ),
            "telemetry": self.telemetry,
            "paths_queries_bodies_and_text_logged": False,
        }

    def selected_media_evidence(
        self,
        selected_url: str,
        responses: list[dict[str, Any]],
        performance_entries: list[dict[str, Any]],
    ) -> dict[str, Any]:
        reads = [
            item
            for item in self.reads
            if item.get("method") == "GET" and item.get("_url") == selected_url
        ]
        selected_responses = [
            item
            for item in responses
            if item.get("method") == "GET" and item.get("_url") == selected_url
        ]
        successful = [item for item in selected_responses if 200 <= item.get("status", 0) < 300]
        media_typed = [
            item
            for item in successful
            if item.get("content_type", "").startswith(("audio/", "video/"))
        ]
        return {
            "exact_selected_get_count": len(reads),
            "route_resource_types": sorted({item["resource_type"] for item in reads}),
            "successful_response_count": len(successful),
            "response_statuses": sorted({item["status"] for item in selected_responses}),
            "media_content_type_count": len(media_typed),
            "content_type_families": sorted(
                {
                    item.get("content_type", "").split("/", 1)[0]
                    for item in selected_responses
                    if "/" in item.get("content_type", "")
                }
            ),
            "performance_entry_count": len(performance_entries),
            "performance_initiator_types": sorted(
                {str(item.get("initiator_type") or "unknown") for item in performance_entries}
            ),
            "performance_completed_count": sum(
                bool(item.get("duration_positive")) for item in performance_entries
            ),
            "url_or_path_logged": False,
        }


def add_check(
    run: dict[str, Any],
    check_id: str,
    passed: bool,
    *,
    expected: Any,
    actual: Any,
    detail: str = "",
) -> None:
    run["checks"].append(
        {
            "id": check_id,
            "passed": bool(passed),
            "expected": expected,
            "actual": actual,
            "detail": detail,
        }
    )


def new_run(browser: str, scenario: str, device: str, theme: str) -> dict[str, Any]:
    return {"browser": browser, "scenario": scenario, "device": device, "theme": theme, "checks": []}


def safe_error(exc: Exception, live: bool) -> str:
    if live:
        return f"{type(exc).__name__}: live failure detail withheld from JSON"
    return f"{type(exc).__name__}: {exc}"


def attach_observers(
    page: Page,
    raw: dict[str, list[Any]],
    *,
    page_lifetime: str | None = None,
) -> None:
    lifetime = {"page_lifetime": page_lifetime} if page_lifetime else {}
    page.on(
        "console",
        lambda message: raw["console"].append(
            {
                **lifetime,
                "type": message.type,
                "text": message.text,
                "location": message.location,
            }
        )
        if message.type in {"warning", "error"}
        else None,
    )
    page.on(
        "pageerror",
        lambda error: raw["page_errors"].append(
            {**lifetime, "error": str(error)} if page_lifetime else str(error)
        ),
    )
    page.on(
        "requestfailed",
        lambda request: raw["request_failures"].append(
            {
                **lifetime,
                **private_request_record(request),
                "failure": request.failure or "",
            }
        ),
    )

    def observe_response(response: Any) -> None:
        try:
            content_type = (response.header_value("content-type") or "").split(";", 1)[0].strip().casefold()
        except Exception:
            content_type = ""
        private = {
            **lifetime,
            **private_request_record(response.request),
            "status": response.status,
            "content_type": content_type,
        }
        raw["responses"].append(private)
        if response.status >= 400:
            raw["http_errors"].append(private)

    page.on("response", observe_response)


def live_url_relation(url: str, live_context: dict[str, Any]) -> str:
    if not url:
        return "none"
    if live_context.get("selected_media_url") and url == live_context["selected_media_url"]:
        return "exact-selected-media"
    parsed = urlparse(url)
    base_host = urlparse(f"https://{live_context.get('base_netloc', '')}").hostname
    base_origin = live_context.get("base_origin") or (
        f"https://{live_context.get('base_netloc', '')}"
    )
    if is_exact_same_origin_rum(url, base_origin):
        return "exact-cloudflare-rum"
    if is_cloudflare_beacon(parsed):
        return "exact-cloudflare-beacon"
    if parsed.hostname == base_host and parsed.path.rstrip("/") == "":
        return "today-document"
    if parsed.hostname == base_host and parsed.path.rstrip("/") == "/shadow":
        return "shadow-document"
    if parsed.hostname == base_host:
        return "same-origin-asset"
    if parsed.hostname == "api-spanish.tonymuzo.dev" and parsed.path == "/api/stats":
        return "today-dashboard-stats-api"
    if parsed.hostname == "api-spanish.tonymuzo.dev" and parsed.path == "/api/sources":
        return "today-source-count-api"
    if parsed.hostname == "api-spanish.tonymuzo.dev" and parsed.path.startswith("/api/"):
        return "production-api"
    return "external-or-unknown"


def console_message_features(text: str) -> list[str]:
    lowered = text.casefold()
    features = []
    for feature, phrase in (
        ("failed-to-load-resource", "failed to load resource"),
        ("load-failed", "load failed"),
        ("fetch-api-cannot-load", "fetch api cannot load"),
        ("blocked-by-client", "blocked_by_client"),
        ("access-control", "access control"),
        ("cancelled", "cancel"),
        ("service-worker-block", "service worker registration blocked by playwright"),
    ):
        if phrase in lowered:
            features.append(feature)
    return features or ["unrecognized"]


def safe_live_console_diagnostic(item: dict[str, Any], live_context: dict[str, Any]) -> dict[str, Any]:
    text = item.get("text", "")
    referenced_urls = [
        match.rstrip(".,);]}>")
        for match in re.findall(r"https?://[^\s\"'<>]+", text)
    ]
    relations = [live_url_relation(url, live_context) for url in referenced_urls]
    if "/cdn-cgi/rum" in text and "exact-cloudflare-rum" not in relations:
        relations.append("exact-cloudflare-rum-relative-reference")
    return {
        "location_relation": live_url_relation(
            item.get("location", {}).get("url", ""), live_context
        ),
        "referenced_url_relations": sorted(relations),
        "referenced_url_count": len(referenced_urls),
        "message_features": console_message_features(text),
        "raw_text_or_url_logged": False,
    }


def safe_live_request_diagnostic(item: dict[str, Any], live_context: dict[str, Any]) -> dict[str, Any]:
    failure = item.get("failure", "")
    if failure in {"net::ERR_ABORTED", "Load request cancelled"}:
        failure_kind = "exact-cancellation"
    elif "cancel" in failure.casefold() or "abort" in failure.casefold():
        failure_kind = "other-cancellation"
    else:
        failure_kind = "other-failure"
    observed_at = float(item.get("observed_at", 0))
    today_entry_started = float(live_context.get("today_entry_started_at", 0))
    today_entry_completed = float(live_context.get("today_entry_completed_at", 0))
    during_today_entry = bool(
        today_entry_started
        and today_entry_started
        <= observed_at
        <= max(today_entry_completed, today_entry_started) + 0.5
    )
    shadow_started = float(live_context.get("shadow_navigation_started_at", 0))
    shadow_completed = float(live_context.get("shadow_navigation_completed_at", 0))
    during_shadow_navigation = bool(
        shadow_started
        and shadow_started <= observed_at <= max(shadow_completed, shadow_started) + 0.5
    )
    exit_started = float(live_context.get("exit_started_at", 0))
    exit_completed = float(live_context.get("exit_completed_at", 0))
    during_exit = bool(exit_started and exit_started <= observed_at <= max(exit_completed, exit_started) + 0.5)
    return {
        "page_lifetime": item.get("page_lifetime", "unknown"),
        "url_relation": live_url_relation(item.get("_url", ""), live_context),
        "resource_type": item.get("resource_type", "unknown"),
        "is_navigation_request": bool(item.get("is_navigation_request")),
        "failure_kind": failure_kind,
        "during_today_entry": during_today_entry,
        "during_shadow_navigation": during_shadow_navigation,
        "during_exit_navigation": during_exit,
        "raw_url_or_failure_logged": False,
    }


def expected_rum_guard_block(
    url: str,
    method: str,
    page_lifetime: str,
    live_context: dict[str, Any],
) -> dict[str, Any] | None:
    base_origin = live_context.get("base_origin") or (
        f"https://{live_context.get('base_netloc', '')}"
    )
    if (
        method != "POST"
        or page_lifetime not in LIVE_PAGE_LIFETIMES
        or not is_exact_same_origin_rum(url, base_origin)
    ):
        return None
    return next(
        (
            block
            for block in live_context.get("expected_telemetry_guard_blocks", [])
            if block.get("_url") == url
            and block.get("method") == method
            and block.get("page_lifetime") == page_lifetime
            and block.get("kind") == "cloudflare-rum"
            and block.get("guard_action") == "blockedbyclient"
        ),
        None,
    )


def exact_rum_console_guard_url(
    item: dict[str, Any], live_context: dict[str, Any]
) -> str | None:
    """Return the guarded RUM URL only for exact browser block diagnostics."""
    text = item.get("text", "")
    location_url = item.get("location", {}).get("url", "")
    page_lifetime = item.get("page_lifetime", "unknown")
    referenced_urls = [
        match.rstrip(".,);]}>")
        for match in re.findall(r"https?://[^\s\"'<>]+", text)
    ]

    if text in {
        "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT",
        "Load failed",
    } and expected_rum_guard_block(
        location_url, "POST", page_lifetime, live_context
    ):
        return location_url

    if len(referenced_urls) != 1:
        return None
    rum_url = referenced_urls[0]
    exact_fetch_messages = {
        f"Fetch API cannot load {rum_url} due to access control checks.",
        f"Fetch API cannot load {rum_url} due to access control checks",
        f"Fetch API cannot load {rum_url}. Load failed",
        f"Fetch API cannot load {rum_url}. Load failed.",
    }
    location_is_expected = bool(
        not location_url
        or location_url == rum_url
        or is_cloudflare_beacon(urlparse(location_url))
    )
    if (
        text in exact_fetch_messages
        and location_is_expected
        and expected_rum_guard_block(
            rum_url, "POST", page_lifetime, live_context
        )
    ):
        return rum_url
    return None


def console_expected_reason(
    item: dict[str, Any],
    scenario: str,
    live_context: dict[str, Any] | None = None,
) -> str | None:
    live_context = live_context or {}
    text = item["text"]
    location_url = item.get("location", {}).get("url", "")
    location_path = urlparse(location_url).path
    if text == "Service Worker registration blocked by Playwright":
        return "exact Playwright service-worker block"
    if scenario == "error_retry" and location_path == ERROR_MEDIA:
        if text.startswith("Failed to load resource:") and "404" in text:
            return "exact synthetic media 404"
    if scenario != "live_read_only" and location_path == "/cdn-cgi/rum" and text in {
        "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT",
        "Load failed",
    }:
        return "exact blocked Cloudflare RUM"
    if scenario == "live_read_only" and item.get("type") == "error":
        if exact_rum_console_guard_url(item, live_context):
            return "exact blocked Cloudflare RUM URL reported by browser console"
    return None


def request_failure_expected_reason(
    item: dict[str, Any],
    scenario: str,
    live_context: dict[str, Any] | None = None,
) -> str | None:
    live_context = live_context or {}
    if (
        scenario == "live_read_only"
        and item.get("failure") in GUARD_BLOCK_FAILURES
        and expected_rum_guard_block(
            item.get("_url", ""),
            item.get("method", ""),
            item.get("page_lifetime", "unknown"),
            live_context,
        )
    ):
        return "exact same-origin Cloudflare RUM POST blocked by live guard"
    if scenario == "pending_source_switch" and item["path"] == PENDING_MEDIA:
        return "source switch cancelled exact pending media request"
    if item.get("method") == "GET" and item.get("failure") in {"net::ERR_ABORTED", "Load request cancelled"}:
        if scenario == "ready" and item["path"] == MAIN_MEDIA:
            return "filter/source switching cancels exact selected synthetic main clip"
        if scenario == "error_retry" and item["path"] == ERROR_MEDIA:
            return "discarding exact failed synthetic media after intercepted 404"
        if scenario == "live_read_only":
            diagnostic = safe_live_request_diagnostic(item, live_context)
            if (
                diagnostic["url_relation"] == "shadow-document"
                and diagnostic["resource_type"] == "other"
                and diagnostic["failure_kind"] == "exact-cancellation"
                and diagnostic["during_today_entry"]
                and not diagnostic["is_navigation_request"]
                and diagnostic["page_lifetime"]
                == live_context.get("today_entry_page_lifetime")
                and bool(live_context.get("today_document_proven_success"))
                and bool(live_context.get("today_entry_click_proven_success"))
            ):
                return "exact Shadow document GET cancelled during proven Today entry click"
            if (
                diagnostic["url_relation"]
                in {"today-dashboard-stats-api", "today-source-count-api"}
                and diagnostic["resource_type"] == "fetch"
                and diagnostic["failure_kind"] == "exact-cancellation"
                and diagnostic["during_shadow_navigation"]
                and not diagnostic["is_navigation_request"]
                and diagnostic["page_lifetime"]
                == live_context.get("shadow_navigation_page_lifetime")
                and bool(live_context.get("today_document_proven_success"))
                and bool(live_context.get("shadow_document_proven_success"))
            ):
                return "exact Today dashboard GET cancelled by proven fresh shadow navigation"
            if (
                diagnostic["url_relation"] == "today-document"
                and diagnostic["resource_type"] == "other"
                and diagnostic["failure_kind"] == "exact-cancellation"
                and diagnostic["during_exit_navigation"]
                and not diagnostic["is_navigation_request"]
                and diagnostic["page_lifetime"]
                == live_context.get("exit_page_lifetime")
                and bool(live_context.get("exit_target_proven_success"))
            ):
                return "exact Today document GET cancelled after proven exit target restoration"
            if (
                diagnostic["url_relation"] == "exact-selected-media"
                and diagnostic["failure_kind"] == "exact-cancellation"
                and diagnostic["during_exit_navigation"]
                and not diagnostic["is_navigation_request"]
                and diagnostic["page_lifetime"]
                == live_context.get("exit_page_lifetime")
                and bool(live_context.get("selected_media_proven_success"))
            ):
                return "exact proven selected-media GET cancelled by explicit exit navigation"
    return None


def http_error_expected_reason(item: dict[str, Any], scenario: str) -> str | None:
    if scenario == "error_retry" and item["path"] == ERROR_MEDIA and item["status"] == 404:
        return "exact synthetic media 404"
    return None


def public_runtime(
    raw: dict[str, list[Any]],
    scenario: str,
    live: bool,
    live_context: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, int]]:
    live_context = live_context or {}
    console = []
    unexpected_console = 0
    for item in raw["console"]:
        reason = console_expected_reason(item, scenario, live_context)
        location_path = urlparse(item.get("location", {}).get("url", "")).path
        public = {
            "page_lifetime": item.get("page_lifetime", "unknown"),
            "type": item["type"],
            "location_path": location_path if not live or location_path == "/cdn-cgi/rum" else "[redacted]",
            "expected": reason is not None,
            "classification": reason,
        }
        if not live:
            public["text"] = item["text"]
        else:
            public["diagnostic"] = safe_live_console_diagnostic(item, live_context)
        console.append(public)
        unexpected_console += reason is None

    failures = []
    unexpected_failures = 0
    for item in raw["request_failures"]:
        reason = request_failure_expected_reason(item, scenario, live_context)
        if live:
            public = {
                "page_lifetime": item.get("page_lifetime", "unknown"),
                "method": item["method"],
                "path": item["path"] if item["path"] == "/cdn-cgi/rum" else "[redacted]",
                "host_relation": live_url_relation(item.get("_url", ""), live_context),
                "failure": "[redacted]",
                "expected": reason is not None,
                "classification": reason,
                "diagnostic": safe_live_request_diagnostic(item, live_context),
            }
        else:
            public = {
                key: value
                for key, value in item.items()
                if key not in {"_url", "observed_at"}
            }
            public.update(
                {
                    "expected": reason is not None,
                    "classification": reason,
                }
            )
        failures.append(public)
        unexpected_failures += reason is None

    http_errors = []
    unexpected_http = 0
    for item in raw["http_errors"]:
        reason = http_error_expected_reason(item, scenario)
        if live:
            public = {
                "page_lifetime": item.get("page_lifetime", "unknown"),
                "method": item["method"],
                "path": item["path"] if item["path"] == "/cdn-cgi/rum" else "[redacted]",
                "host_relation": live_url_relation(item.get("_url", ""), live_context),
                "status": item["status"],
                "expected": reason is not None,
                "classification": reason,
                "raw_url_or_content_type_logged": False,
            }
        else:
            public = {
                key: value
                for key, value in item.items()
                if key not in {"_url", "observed_at"}
            }
            public.update({"expected": reason is not None, "classification": reason})
        http_errors.append(public)
        unexpected_http += reason is None

    runtime = {
        "console": console,
        "page_errors": (
            [
                {
                    "redacted": True,
                    "page_lifetime": (
                        item.get("page_lifetime", "unknown")
                        if isinstance(item, dict)
                        else "unknown"
                    ),
                }
                for item in raw["page_errors"]
            ]
            if live
            else raw["page_errors"]
        ),
        "request_failures": failures,
        "http_errors": http_errors,
    }
    counts = {
        "unexpected_console": unexpected_console,
        "page_errors": len(raw["page_errors"]),
        "unexpected_request_failures": unexpected_failures,
        "unexpected_http_errors": unexpected_http,
    }
    return runtime, counts


def context_init_script(theme: str, clear_shadow_once: bool = True) -> str:
    clear = "localStorage.removeItem('atr.shadow.v1');" if clear_shadow_once else ""
    return f"""
(() => {{
  if (!['http:', 'https:'].includes(location.protocol)) return;
  if (!sessionStorage.getItem('__shadowQaStoragePrepared')) {{
    {clear}
    sessionStorage.setItem('__shadowQaStoragePrepared', '1');
  }}
  localStorage.setItem('atr-theme', {json.dumps(THEMES[theme])});
  localStorage.setItem('atr.apiBaseUrl', location.origin);
  localStorage.removeItem('atr.activeApiBase');
}})();
"""


def create_fixture_page(
    browser: Browser,
    base: str,
    scenario: str,
    device: str,
    theme: str,
    timeout: int,
) -> tuple[Any, Page, FixtureRouter, dict[str, list[Any]]]:
    context = browser.new_context(
        **DEVICES[device],
        service_workers="block",
        color_scheme=theme,
    )
    context.add_init_script(script=context_init_script(theme))
    context.add_init_script(script=MEDIA_TRACKER_JS)
    page = context.new_page()
    page.set_default_timeout(timeout)
    raw = {
        "console": [],
        "page_errors": [],
        "request_failures": [],
        "http_errors": [],
        "responses": [],
    }
    attach_observers(page, raw)
    router = FixtureRouter(base, scenario)
    router.install(page)
    return context, page, router, raw


def create_live_page(
    browser: Browser,
    base: str,
    timeout: int,
    device: str,
) -> tuple[Any, Page, LiveRouter, dict[str, list[Any]]]:
    context = browser.new_context(
        **DEVICES[device],
        service_workers="block",
        color_scheme="light",
    )
    # Fresh disposable context: verify the actual production build API origin,
    # never override it with the frontend origin or use the learner's storage.
    context.add_init_script(
        script="""
(() => {
  if (!['http:', 'https:'].includes(location.protocol)) return;
  localStorage.removeItem('atr.apiBaseUrl');
  localStorage.removeItem('atr.activeApiBase');
})();
"""
    )
    context.add_init_script(script=MEDIA_TRACKER_JS)
    raw = {
        "console": [],
        "page_errors": [],
        "request_failures": [],
        "http_errors": [],
        "responses": [],
    }
    router = LiveRouter(base)
    page = create_observed_live_page(
        context, router, raw, timeout, page_lifetime="today-entry"
    )
    return context, page, router, raw


def create_observed_live_page(
    context: Any,
    router: LiveRouter,
    raw: dict[str, list[Any]],
    timeout: int,
    *,
    page_lifetime: str,
) -> Page:
    """Create one guarded live Page and retain its sanitized lifetime label."""
    page = context.new_page()
    page.set_default_timeout(timeout)
    attach_observers(page, raw, page_lifetime=page_lifetime)
    router.install(page, page_lifetime=page_lifetime)
    return page


def navigate_shadow(page: Page, base: str, run: dict[str, Any], timeout: int) -> None:
    response = page.goto(base + "/shadow/", wait_until="domcontentloaded", timeout=timeout)
    navigation = {"status": response.status if response else None, "path": urlparse(page.url).path}
    run["navigation"] = navigation
    add_check(
        run,
        "navigation.shadow-loaded",
        response is not None and response.ok and urlparse(page.url).path.rstrip("/") == "/shadow",
        expected="2xx response at /shadow/",
        actual=navigation,
    )
    page.get_by_role("heading", name="Find your rhythm.", exact=True).wait_for(state="visible", timeout=timeout)
    page.get_by_role("region", name="Shadowing player", exact=True).wait_for(state="visible", timeout=timeout)


def chooser(page: Page) -> Any:
    return page.get_by_role("combobox", name="Choose clip", exact=True)


def collection_selector(page: Page) -> Any:
    return page.get_by_role("combobox", name="Audio collection", exact=True)


def source_selector(page: Page) -> Any:
    return page.get_by_role("combobox", name="Source", exact=True)


def wait_ready(page: Page, timeout: int, *, minimum_options: int = 1) -> None:
    chooser(page).wait_for(state="visible", timeout=timeout)
    page.wait_for_function(
        """(minimum) => {
          const select = Array.from(document.querySelectorAll('select'))
            .find((item) => item.getAttribute('aria-label') === 'Choose clip');
          return Boolean(select && !select.disabled && Array.from(select.options).filter((option) => option.value).length >= minimum);
        }""",
        arg=minimum_options,
        timeout=timeout,
    )


def option_state(select: Any) -> list[dict[str, Any]]:
    return select.evaluate(
        r"""(element) => Array.from(element.options).filter((option) => option.value).map((option) => ({
          value: option.value,
          text: (option.textContent || '').replace(/\s+/g, ' ').trim(),
          disabled: option.disabled,
        }))"""
    )


def select_clip(page: Page, phrase_id: int, spanish: str) -> None:
    select = chooser(page)
    options = option_state(select)
    direct = next((item for item in options if item["value"] == str(phrase_id)), None)
    if direct:
        select.select_option(direct["value"])
        return
    fallback = next((item for item in options if spanish in item["text"]), None)
    if not fallback:
        raise AssertionError(f"Synthetic fixture clip {phrase_id} was not present in Choose clip")
    select.select_option(fallback["value"])


def player_phase(page: Page) -> str | None:
    return page.locator('[data-phase]').first.get_attribute("data-phase")


def wait_phase(page: Page, phases: set[str], timeout: int) -> str:
    page.wait_for_function(
        """(wanted) => {
          const element = document.querySelector('[data-phase]');
          return Boolean(element && wanted.includes(element.getAttribute('data-phase')));
        }""",
        arg=sorted(phases),
        timeout=timeout,
    )
    return player_phase(page) or ""


def media_summary(page: Page) -> dict[str, Any]:
    return page.evaluate("window.__shadowQa.summary()")


def latest_media(summary: dict[str, Any]) -> dict[str, Any] | None:
    return summary["media"][-1] if summary.get("media") else None


def visible_exact_text(page: Page, value: str) -> bool:
    return bool(
        page.evaluate(
            """(value) => Array.from(document.querySelectorAll('[aria-label="Shadowing player"] *'))
              .filter((element) => element.tagName !== 'OPTION')
              .some((element) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return (element.textContent || '').trim() === value
                  && style.display !== 'none' && style.visibility !== 'hidden'
                  && rect.width > 0 && rect.height > 0;
              })""",
            value,
        )
    )


def inspect_layout(page: Page) -> dict[str, Any]:
    return page.evaluate(
        r"""() => {
          const root = document.documentElement;
          const body = document.body;
          const width = root.clientWidth;
          const documentWidth = Math.max(root.scrollWidth, body?.scrollWidth || 0);
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const overflowers = Array.from(document.querySelectorAll('body *')).filter(visible).map((element) => {
            const rect = element.getBoundingClientRect();
            if (rect.left >= -1 && rect.right <= width + 1) return null;
            return {
              tag: element.tagName.toLowerCase(),
              className: typeof element.className === 'string' ? element.className.split(/\s+/).slice(0, 3).join('.') : '',
              left: Math.round(rect.left * 10) / 10,
              right: Math.round(rect.right * 10) / 10,
              width: Math.round(rect.width * 10) / 10,
            };
          }).filter(Boolean).slice(0, 15);
          const controls = Array.from(document.querySelectorAll('button, a, select, input[type="checkbox"], summary'))
            .filter(visible).map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                name: (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
                width: Math.round(rect.width * 10) / 10,
                height: Math.round(rect.height * 10) / 10,
              };
            });
          return {
            viewport: {width, height: root.clientHeight},
            documentWidth,
            horizontalOverflow: documentWidth > width + 1,
            overflowers,
            controls,
            theme: root.dataset.theme || null,
          };
        }"""
    )


def add_semantic_checks(page: Page, run: dict[str, Any], device: str, theme: str) -> None:
    region = page.get_by_role("region", name="Shadowing player", exact=True)
    collection = collection_selector(page)
    source = source_selector(page)
    choose = chooser(page)
    collection_options = collection.locator("option").all_text_contents()
    repeat_values = page.get_by_role("combobox", name="Repeat pause", exact=True).locator("option").evaluate_all(
        "options => options.map(option => option.value)"
    )
    speed_state = {
        label: region.get_by_role("button", name=label, exact=True).get_attribute("aria-pressed")
        for label in ("0.5×", "0.75×", "1×")
    }
    controls = {
        "start": region.get_by_role("button", name="Start shadowing", exact=True).count(),
        "replay": region.get_by_role("button", name="Replay", exact=True).count(),
        "previous": region.get_by_role("button", name="Previous clip", exact=True).count(),
        "next": region.get_by_role("button", name="Next clip", exact=True).count(),
        "exit": page.get_by_role("link", name="Exit shadowing", exact=True).count(),
        "refresh": page.get_by_role("button", name="Refresh clips", exact=True).count(),
    }
    add_check(
        run,
        "contract.primary-semantics",
        page.get_by_role("heading", name="Find your rhythm.", exact=True).count() == 1
        and region.count() == 1
        and all(value == 1 for value in controls.values()),
        expected="one authoritative heading/region and all named primary controls",
        actual=controls,
    )
    add_check(
        run,
        "contract.filter-options",
        collection_options == ["Imported clips", "All active clips", "Generated clips", "Other / unknown"]
        and source.locator("option").first.inner_text().strip() == "All sources"
        and collection.input_value() != ""
        and choose.count() == 1,
        expected={
            "Audio collection": ["Imported clips", "All active clips", "Generated clips", "Other / unknown"],
            "Source first option": "All sources",
        },
        actual={"collection": collection_options, "source_first": source.locator("option").first.inner_text().strip()},
    )
    add_check(
        run,
        "contract.practice-controls",
        set(repeat_values) == {"0", "1", "2", "3", "5", "8"}
        and sum(value == "true" for value in speed_state.values()) == 1
        and region.get_by_role("button", name="Listen and repeat", exact=True).count() == 1
        and region.get_by_role("button", name="Shadow along", exact=True).count() == 1
        and region.get_by_role("checkbox", name="Show Spanish", exact=True).count() == 1,
        expected="rates, repeat pauses 0/1/2/3/5/8, both modes, and Show Spanish",
        actual={"repeat_values": repeat_values, "speed_aria_pressed": speed_state},
    )
    count_text = region.get_by_test_id("shadow-count").inner_text().strip()
    position_text = region.get_by_test_id("shadow-position").inner_text().strip()
    add_check(
        run,
        "contract.status-count-position",
        count_text == "0 completed playbacks this visit"
        and "/" in position_text
        and region.get_by_test_id("shadow-status").count() == 1,
        expected="zero visit count, elapsed / total position, and visible status",
        actual={"count": count_text, "position": position_text},
    )
    media = media_summary(page)
    add_check(
        run,
        "media.one-detached-audio-for-selection",
        len(media["media"]) == 1 and all(item["detachedAtCreate"] and not item["connected"] for item in media["media"]),
        expected="exactly one detached audio element after initial clip selection",
        actual={"created": len(media["media"]), "media": media["media"]},
    )
    add_check(
        run,
        "privacy.no-microphone-or-session-ui",
        page.locator('[aria-label*="microphone" i], [data-testid*="microphone" i]').count() == 0,
        expected="no microphone control in dedicated shadowing",
        actual=page.locator('[aria-label*="microphone" i], [data-testid*="microphone" i]').count(),
    )

    layout = inspect_layout(page)
    run["layout"] = layout
    targets = region.locator("button, select, .shadow-text-toggle").evaluate_all("els => els.filter(e => e.getClientRects().length).map(e => ({name: e.getAttribute('aria-label') || e.textContent.trim().slice(0,40), width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height}))")
    add_check(run, "accessibility.touch-targets", all(t["width"] >= 44 and t["height"] >= 44 for t in targets), expected="all key player touch controls at least 44 by 44 CSS pixels", actual=[t for t in targets if t["width"] < 44 or t["height"] < 44])
    add_check(
        run,
        "layout.no-horizontal-overflow",
        not layout["horizontalOverflow"],
        expected="document width <= viewport width",
        actual={"viewport": layout["viewport"], "document_width": layout["documentWidth"], "overflowers": layout["overflowers"]},
    )
    add_check(
        run,
        "theme.requested-theme-applied",
        layout["theme"] == THEMES[theme],
        expected=THEMES[theme],
        actual=layout["theme"],
    )

    if device == "desktop":
        shadow_links = page.get_by_role("link", name="Shadowing", exact=True)
        visible = [shadow_links.nth(index).is_visible() for index in range(shadow_links.count())]
        add_check(
            run,
            "navigation.desktop-shadowing-link",
            any(visible),
            expected="visible desktop navigation link named Shadowing",
            actual={"count": shadow_links.count(), "visible": visible},
        )
    else:
        menu = page.locator("[data-nav-more]")
        summary = menu.locator("summary")
        if summary.count():
            summary.click()
        actual = {
            "menu": menu.count(),
            "shadowing": menu.get_by_role("link", name="Shadowing", exact=True).count() if menu.count() else 0,
            "verbs": menu.get_by_role("link", name="Verbs", exact=True).count() if menu.count() else 0,
        }
        add_check(
            run,
            "navigation.mobile-more-shadowing-and-verbs",
            menu.count() == 1
            and menu.get_by_role("link", name="Shadowing", exact=True).is_visible()
            and menu.get_by_role("link", name="Verbs", exact=True).is_visible(),
            expected="mobile More contains visible Shadowing and Verbs links",
            actual=actual,
        )
        if menu.get_attribute("open") is not None:
            page.keyboard.press("Escape")


def add_filter_and_text_checks(page: Page, run: dict[str, Any], router: FixtureRouter, timeout: int) -> None:
    collection = collection_selector(page)
    source = source_selector(page)
    choose = chooser(page)

    imported = option_state(choose)
    add_check(
        run,
        "filters.default-imported",
        len(imported) == 5 and MAIN_SPANISH in imported[0]["text"],
        expected="Imported clips default with 5 playable fixtures and imported audio sorted first",
        actual={"count": len(imported), "first": imported[0]["text"] if imported else None},
    )

    collection.select_option(label="All active clips")
    page.wait_for_function(
        """() => Array.from(document.querySelectorAll('select'))
          .find((item) => item.getAttribute('aria-label') === 'Choose clip')
          ?.querySelectorAll('option[value]').length >= 108""",
        timeout=timeout,
    )
    all_active = option_state(choose)
    values = {item["value"] for item in all_active}
    card_queries = [
        item.get("query")
        for item in router.api_requests
        if item["path"].rstrip("/") == "/api/cards"
    ]
    expected_queries = [
        {"active": "1", "limit": 100, "offset": 0},
        {"active": "1", "limit": 100, "offset": 100},
    ]
    add_check(
        run,
        "pagination.all-active-complete",
        len(all_active) == FIXTURE_TOTAL
        and len(values) == FIXTURE_TOTAL
        and card_queries == expected_queries,
        expected="108 unique active clips after exact offset 0/100 pagination",
        actual={
            "option_count": len(all_active),
            "unique_values": len(values),
            "card_queries": card_queries,
        },
    )
    missing = [item for item in all_active if MISSING_SPANISH in item["text"]]
    add_check(
        run,
        "filters.missing-audio-suffix",
        len(missing) == 1 and "unavailable" in missing[0]["text"].casefold(),
        expected="missing-audio clip retained in All active clips with an unavailable suffix",
        actual=missing,
    )

    source_labels = [value.strip() for value in source.locator("option").all_text_contents()]
    generated_source = next((label for label in source_labels if "4200" in label), None)
    imported_source = next((label for label in source_labels if "abcdefghijk" in label), None)
    add_check(
        run,
        "filters.source-labels",
        generated_source is not None and imported_source is not None,
        expected="source URL label for YouTube plus generated group id 4200 label",
        actual=source_labels,
    )
    if generated_source:
        source.select_option(label=generated_source)
        page.wait_for_timeout(100)
        generated_source_options = option_state(choose)
        add_check(
            run,
            "filters.source-group",
            len(generated_source_options) == 100
            and all("generada" in item["text"].casefold() for item in generated_source_options),
            expected="generated source group 42 narrows Choose clip to 100 generated fixtures",
            actual={"count": len(generated_source_options)},
        )
    source.select_option(index=0)

    collection.select_option(label="Generated clips")
    page.wait_for_timeout(100)
    generated = option_state(choose)
    add_check(
        run,
        "filters.generated",
        len(generated) == 100 and all("generada" in item["text"].casefold() for item in generated),
        expected="100 generated clips",
        actual={"count": len(generated)},
    )
    collection.select_option(label="Other / unknown")
    page.wait_for_timeout(100)
    other = option_state(choose)
    add_check(
        run,
        "filters.other-unknown",
        len(other) == 3 and any(MISSING_SPANISH in item["text"] for item in other),
        expected="2 unknown-provenance clips plus the actionable missing-audio YouTube card",
        actual={"count": len(other)},
    )

    collection.select_option(label="All active clips")
    page.wait_for_timeout(100)
    select_clip(page, 1, MAIN_SPANISH)
    checkbox = page.get_by_role("checkbox", name="Show Spanish", exact=True)
    if not checkbox.is_checked():
        checkbox.check()
    page.wait_for_timeout(50)
    shown = visible_exact_text(page, MAIN_SPANISH)
    english_before = visible_exact_text(page, MAIN_ENGLISH)
    checkbox.uncheck()
    page.wait_for_timeout(50)
    hidden = not visible_exact_text(page, MAIN_SPANISH)
    english_after = visible_exact_text(page, MAIN_ENGLISH)
    add_check(
        run,
        "text.spanish-toggle-english-always-visible",
        shown and hidden and english_before and english_after,
        expected="Show Spanish controls Spanish only; English stays visible and unchanged",
        actual={
            "spanish_before": shown,
            "spanish_hidden": hidden,
            "english_before": english_before,
            "english_after": english_after,
        },
    )
    checkbox.check()

    select_clip(page, 6, MISSING_SPANISH)
    page.wait_for_timeout(100)
    unavailable_status = page.get_by_test_id("shadow-status").inner_text()
    start = page.get_by_role("button", name=re.compile(r"^(Start|Resume) shadowing$"))
    actionable = page.get_by_role("link", name=re.compile(r"^(Library|Add a source)$"))
    add_check(
        run,
        "missing-audio.actionable-state",
        bool(unavailable_status.strip())
        and start.is_disabled()
        and actionable.count() >= 1,
        expected="visible missing-audio status, disabled start, and Library/Add a source action",
        actual={
            "status": unavailable_status,
            "start_disabled": start.is_disabled(),
            "action_link_count": actionable.count(),
        },
    )
    select_clip(page, 1, MAIN_SPANISH)


def save_screenshot(page: Page, output: Path, run: dict[str, Any], suffix: str = "") -> None:
    filename = f"{run['browser']}--{run['scenario']}--{run['device']}--{run['theme']}{suffix}.png"
    page.screenshot(path=str(output / filename), full_page=not suffix.endswith("--controls"), animations="disabled")
    run.setdefault("screenshots", []).append(filename)


def finish_fixture_run(
    run: dict[str, Any],
    router: FixtureRouter,
    raw: dict[str, list[Any]],
) -> None:
    run["network"] = router.evidence()
    runtime, counts = public_runtime(raw, run["scenario"], live=False)
    run["runtime"] = runtime
    add_check(
        run,
        "safety.no-application-mutations",
        not router.mutation_attempts,
        expected="zero non-GET/HEAD/OPTIONS application requests",
        actual=router.mutation_attempts,
        detail="Every mutation is aborted before dispatch and still fails the suite.",
    )
    add_check(
        run,
        "safety.no-fsrs-or-session-endpoints",
        not any(item["path"].startswith("/api/sessions") or "grade" in item["path"] for item in router.api_requests),
        expected="no /api/sessions or grading/FSRS request",
        actual=[item for item in router.api_requests if item["path"].startswith("/api/sessions") or "grade" in item["path"]],
    )
    add_check(
        run,
        "safety.no-unexpected-api-or-external-read",
        not router.unexpected_api_gets and not router.blocked_external,
        expected="all API/media reads fixture-handled; no external dependencies except exact classified telemetry",
        actual={"unexpected_api_gets": router.unexpected_api_gets, "blocked_external": router.blocked_external},
    )
    add_check(
        run,
        "runtime.no-page-errors",
        counts["page_errors"] == 0,
        expected=0,
        actual=counts["page_errors"],
    )
    add_check(
        run,
        "runtime.only-exact-expected-errors",
        counts["unexpected_console"] == 0
        and counts["unexpected_request_failures"] == 0
        and counts["unexpected_http_errors"] == 0,
        expected="no console/request/HTTP errors outside exact scenario and telemetry classifications",
        actual=counts,
    )


def visual_run(
    browser: Browser,
    browser_name: str,
    base: str,
    output: Path,
    device: str,
    theme: str,
    timeout: int,
    deep_checks: bool,
) -> dict[str, Any]:
    run = new_run(browser_name, "ready", device, theme)
    context, page, router, raw = create_fixture_page(browser, base, "ready", device, theme, timeout)
    try:
        navigate_shadow(page, base, run, timeout)
        wait_ready(page, timeout)
        add_semantic_checks(page, run, device, theme)
        if deep_checks:
            add_filter_and_text_checks(page, run, router, timeout)
        save_screenshot(page, output, run)
        if device != "desktop":
            page.get_by_role("button", name="Start shadowing", exact=True).scroll_into_view_if_needed()
            save_screenshot(page, output, run, "--controls")
    except Exception as exc:
        run["execution_error"] = safe_error(exc, live=False)
        add_check(
            run,
            "runner.scenario-completed",
            False,
            expected="ready visual/semantic scenario completed",
            actual=run["execution_error"],
        )
        try:
            save_screenshot(page, output, run, "--failure")
        except Exception as screenshot_exc:
            run["screenshot_error"] = safe_error(screenshot_exc, live=False)
    finally:
        finish_fixture_run(run, router, raw)
        context.close()
    return run


def button_start_or_resume(page: Page) -> Any:
    return page.get_by_role("button", name=re.compile(r"^(Start shadowing|Resume shadowing)$"))


def event_count(summary: dict[str, Any], event_type: str) -> int:
    return sum(item["type"] == event_type for item in summary["events"])


def playback_and_persistence_run(
    browser: Browser,
    browser_name: str,
    base: str,
    output: Path,
    timeout: int,
) -> dict[str, Any]:
    run = new_run(browser_name, "playback_clock_loop_persistence", "desktop", "light")
    context, page, router, raw = create_fixture_page(
        browser, base, run["scenario"], "desktop", "light", timeout
    )
    try:
        navigate_shadow(page, base, run, timeout)
        wait_ready(page, timeout)
        select_clip(page, 1, MAIN_SPANISH)
        page.get_by_role("button", name="1×", exact=True).click()
        page.get_by_role("button", name="Shadow along", exact=True).click()
        button_start_or_resume(page).click()
        wait_phase(page, {"playing"}, timeout)
        before = latest_media(media_summary(page))
        wall_before = time.monotonic()
        page.wait_for_timeout(500)
        after = latest_media(media_summary(page))
        wall_elapsed = time.monotonic() - wall_before
        advance = (after or {}).get("currentTime", 0) - (before or {}).get("currentTime", 0)
        add_check(
            run,
            "clock.real-media-advances",
            bool(before and after) and advance > 0.25 and 0.45 <= advance / wall_elapsed <= 1.55,
            expected="real decoded media clock advances at approximately 1x wall time",
            actual={"media_advance": round(advance, 3), "wall_elapsed": round(wall_elapsed, 3)},
        )

        page.get_by_role("button", name="0.5×", exact=True).click()
        rate_before = latest_media(media_summary(page))
        rate_wall_before = time.monotonic()
        page.wait_for_timeout(700)
        rate_after = latest_media(media_summary(page))
        rate_wall = time.monotonic() - rate_wall_before
        rate_advance = (rate_after or {}).get("currentTime", 0) - (rate_before or {}).get("currentTime", 0)
        add_check(
            run,
            "rate.real-half-speed",
            bool(rate_before and rate_after)
            and (rate_after or {}).get("playbackRate") == 0.5
            and 0.20 <= rate_advance / rate_wall <= 0.80,
            expected="HTMLMediaElement playbackRate=0.5 and real media time advances near half wall time",
            actual={
                "playback_rate": (rate_after or {}).get("playbackRate"),
                "media_advance": round(rate_advance, 3),
                "wall_elapsed": round(rate_wall, 3),
            },
        )

        page.get_by_role("button", name="Pause", exact=True).click()
        wait_phase(page, {"paused"}, timeout)
        paused_before = latest_media(media_summary(page))
        page.wait_for_timeout(450)
        paused_after = latest_media(media_summary(page))
        paused_delta = abs((paused_after or {}).get("currentTime", 0) - (paused_before or {}).get("currentTime", 0))
        add_check(
            run,
            "pause.freezes-real-clock",
            bool(paused_before and paused_after)
            and paused_delta <= 0.06
            and bool((paused_after or {}).get("paused")),
            expected="paused media clock remains stable",
            actual={"delta": round(paused_delta, 3), "paused": (paused_after or {}).get("paused")},
        )
        button_start_or_resume(page).click()
        wait_phase(page, {"playing"}, timeout)
        page.wait_for_timeout(300)
        resumed = latest_media(media_summary(page))
        add_check(
            run,
            "pause.user-gesture-resume",
            bool(resumed and paused_after)
            and (resumed or {}).get("currentTime", 0) > (paused_after or {}).get("currentTime", 0) + 0.08,
            expected="Resume shadowing user gesture advances the media clock",
            actual={
                "before": (paused_after or {}).get("currentTime"),
                "after": (resumed or {}).get("currentTime"),
            },
        )

        page.get_by_role("button", name="Replay", exact=True).click()
        wait_phase(page, {"playing"}, timeout)
        page.wait_for_timeout(120)
        replayed = latest_media(media_summary(page))
        add_check(
            run,
            "replay.starts-from-zero",
            bool(replayed) and replayed["currentTime"] < 0.35,
            expected="Replay user gesture restarts selected clip from zero",
            actual={"current_time": (replayed or {}).get("currentTime")},
        )

        # Use the short real WAV for both gapless and repeat-gap loops.
        select_clip(page, 2, ALT_SPANISH)
        page.get_by_role("button", name="1×", exact=True).click()
        page.get_by_role("button", name="Shadow along", exact=True).click()
        summary_before_loop = media_summary(page)
        count_before_loop = int(page.get_by_test_id("shadow-count").inner_text().split()[0])
        button_start_or_resume(page).click()
        page.wait_for_function(
            """(baseline) => window.__shadowQa.summary().events.filter((event) => event.type === 'ended').length > baseline""",
            arg=event_count(summary_before_loop, "ended"),
            timeout=timeout,
        )
        page.wait_for_function(
            """(baseline) => window.__shadowQa.summary().events.filter((event) => event.type === 'play-call').length >= baseline + 2""",
            arg=event_count(summary_before_loop, "play-call"),
            timeout=timeout,
        )
        loop_summary = media_summary(page)
        ended_event = next(item for item in loop_summary["events"] if item["type"] == "ended" and item["at"] >= summary_before_loop["events"][-1]["at"] if summary_before_loop["events"])
        later_plays = [item for item in loop_summary["events"] if item["type"] == "play-call" and item["at"] >= ended_event["at"]]
        gapless_delay = later_plays[0]["at"] - ended_event["at"] if later_plays else 9999
        count_after_loop = int(page.get_by_test_id("shadow-count").inner_text().split()[0])
        add_check(
            run,
            "loop.shadow-along-gapless",
            gapless_delay < 350 and count_after_loop > count_before_loop and player_phase(page) == "playing",
            expected="real ended increments count and Shadow along immediately loops without a gap",
            actual={
                "ended_to_play_ms": gapless_delay,
                "count_before": count_before_loop,
                "count_after": count_after_loop,
                "phase": player_phase(page),
            },
        )

        page.get_by_role("button", name="Listen and repeat", exact=True).click()
        page.get_by_role("combobox", name="Repeat pause", exact=True).select_option("1")
        page.get_by_role("button", name="Replay", exact=True).click()
        wait_phase(page, {"gap"}, timeout)
        gap_summary = media_summary(page)
        gap_play_calls = event_count(gap_summary, "play-call")
        page.wait_for_timeout(250)
        page.get_by_role("button", name="Pause", exact=True).click()
        wait_phase(page, {"gap-paused"}, timeout)
        page.wait_for_timeout(900)
        gap_paused = media_summary(page)
        frozen = event_count(gap_paused, "play-call") == gap_play_calls
        resume_started = time.monotonic()
        button_start_or_resume(page).click()
        page.wait_for_function(
            """(baseline) => window.__shadowQa.summary().events.filter((event) => event.type === 'play-call').length > baseline""",
            arg=gap_play_calls,
            timeout=timeout,
        )
        resume_delay = time.monotonic() - resume_started
        add_check(
            run,
            "gap.pause-freezes-and-resumes-remaining-delay",
            frozen and 0.35 <= resume_delay <= 1.45,
            expected="pause freezes the remaining real 1s gap; resume uses the remainder rather than elapsed paused time",
            actual={"play_calls_frozen": frozen, "resume_delay_seconds": round(resume_delay, 3)},
        )

        # Let the short clip finish again, then switch source while its repeat
        # timer is pending. No old loop may fire and the new source must not autoplay.
        wait_phase(page, {"gap"}, timeout)
        pending_gap = media_summary(page)
        pending_play_calls = event_count(pending_gap, "play-call")
        select_clip(page, 1, MAIN_SPANISH)
        page.wait_for_timeout(1_200)
        switched = media_summary(page)
        add_check(
            run,
            "gap.source-switch-cancels-pending-loop",
            event_count(switched, "play-call") == pending_play_calls
            and player_phase(page) not in {"playing", "loading", "gap"},
            expected="source switch cancels pending repeat timer and never autoplays the new clip",
            actual={"play_calls_before": pending_play_calls, "play_calls_after": event_count(switched, "play-call"), "phase": player_phase(page)},
        )

        # Persist only the approved minimal preference/clip shape.
        page.get_by_role("button", name="0.75×", exact=True).click()
        page.get_by_role("button", name="Listen and repeat", exact=True).click()
        page.get_by_role("combobox", name="Repeat pause", exact=True).select_option("3")
        spanish_toggle = page.get_by_role("checkbox", name="Show Spanish", exact=True)
        if spanish_toggle.is_checked():
            spanish_toggle.uncheck()
        page.wait_for_timeout(100)
        stored = page.evaluate("JSON.parse(localStorage.getItem('atr.shadow.v1'))")
        expected_storage = {
            "version": 1,
            "clipId": 1,
            "preferences": {"rate": 0.75, "gapSeconds": 3, "mode": "repeat", "showSpanish": False},
        }
        add_check(
            run,
            "persistence.minimal-shape",
            stored == expected_storage,
            expected=expected_storage,
            actual=stored,
            detail="Fixture text is synthetic; production/live storage is never copied to JSON.",
        )

        page.reload(wait_until="domcontentloaded", timeout=timeout)
        page.get_by_role("heading", name="Find your rhythm.", exact=True).wait_for(timeout=timeout)
        wait_ready(page, timeout)
        page.wait_for_timeout(250)
        restored_no_play = media_summary(page)
        restoration = {
            "clip": chooser(page).input_value(),
            "rate_pressed": page.get_by_role("button", name="0.75×", exact=True).get_attribute("aria-pressed"),
            "gap": page.get_by_role("combobox", name="Repeat pause", exact=True).input_value(),
            "repeat_pressed": page.get_by_role("button", name="Listen and repeat", exact=True).get_attribute("aria-pressed"),
            "show_spanish": page.get_by_role("checkbox", name="Show Spanish", exact=True).is_checked(),
            "count": page.get_by_test_id("shadow-count").inner_text().strip(),
            "resume_visible": page.get_by_role("button", name="Resume shadowing", exact=True).is_visible(),
            "play_calls": event_count(restored_no_play, "play-call"),
        }
        add_check(
            run,
            "persistence.restore-requires-user-gesture",
            restoration["clip"] == "1"
            and restoration["rate_pressed"] == "true"
            and restoration["gap"] == "3"
            and restoration["repeat_pressed"] == "true"
            and not restoration["show_spanish"]
            and restoration["count"] == "0 completed playbacks this visit"
            and restoration["resume_visible"]
            and restoration["play_calls"] == 0,
            expected="minimal preferences/clip restored stopped; visit count reset; Resume requires a gesture",
            actual=restoration,
        )

        page.get_by_role("button", name="Resume shadowing", exact=True).click()
        wait_phase(page, {"playing"}, timeout)
        page.wait_for_timeout(300)
        before_refresh_summary = media_summary(page)
        card_reads_before = len([item for item in router.api_requests if item["path"].rstrip("/") == "/api/cards"])
        page.get_by_role("button", name="Refresh clips", exact=True).click()
        refresh_deadline = time.monotonic() + timeout / 1000
        while time.monotonic() < refresh_deadline:
            card_reads_now = len(
                [item for item in router.api_requests if item["path"].rstrip("/") == "/api/cards"]
            )
            refresh_control = page.get_by_role("button", name="Refresh clips", exact=True)
            if card_reads_now >= card_reads_before + 2 and refresh_control.count() and refresh_control.is_enabled():
                break
            page.wait_for_timeout(25)
        first_stopped_summary = media_summary(page)
        page.wait_for_timeout(450)
        second_stopped_summary = media_summary(page)
        first_stopped = latest_media(first_stopped_summary)
        second_stopped = latest_media(second_stopped_summary)
        card_reads_after = len([item for item in router.api_requests if item["path"].rstrip("/") == "/api/cards"])
        stopped_delta = abs(
            (second_stopped or {}).get("currentTime", 0) - (first_stopped or {}).get("currentTime", 0)
        )
        refresh_stable = bool(
            first_stopped
            and second_stopped
            and all(item["paused"] for item in second_stopped_summary["media"])
            and stopped_delta <= 0.06
            and event_count(second_stopped_summary, "play-call")
            == event_count(before_refresh_summary, "play-call")
        )
        add_check(
            run,
            "refresh.stops-audio-and-reloads-full-library",
            refresh_stable and card_reads_after >= card_reads_before + 2,
            expected="Refresh clips stops audio and performs another complete two-page read without autoplay",
            actual={
                "all_media_paused": all(item["paused"] for item in second_stopped_summary["media"]),
                "stopped_clock_delta": round(stopped_delta, 3),
                "play_calls_before": event_count(before_refresh_summary, "play-call"),
                "play_calls_after": event_count(second_stopped_summary, "play-call"),
                "card_reads_before": card_reads_before,
                "card_reads_after": card_reads_after,
                "phase": player_phase(page),
            },
        )

        button_start_or_resume(page).click()
        wait_phase(page, {"playing"}, timeout)
        pause_calls_before_exit = media_summary(page)["sessionPauseCalls"]
        page.get_by_role("link", name="Exit shadowing", exact=True).click()
        page.wait_for_function(r"location.pathname.replace(/\/$/, '') !== '/shadow'", timeout=timeout)
        page.get_by_role("link", name=re.compile(r"^(Start|Resume) shadowing$"), exact=True).wait_for(
            state="visible", timeout=timeout
        )
        pause_calls_after_exit = page.evaluate("Number(sessionStorage.getItem('__shadowQaPauseCalls') || '0')")
        today_link = page.get_by_role("link", name=re.compile(r"^(Start|Resume) shadowing$"), exact=True)
        add_check(
            run,
            "navigation.exit-stops-and-today-entry-is-separate",
            pause_calls_after_exit > pause_calls_before_exit
            and today_link.get_attribute("href").rstrip("/") == "/shadow"
            and today_link.inner_text().strip() in {"Start shadowing", "Resume shadowing"},
            expected="Exit navigation pauses media and Today exposes an exact Start/Resume shadowing link to /shadow/",
            actual={
                "pause_calls_before": pause_calls_before_exit,
                "pause_calls_after": pause_calls_after_exit,
                "today_href": today_link.get_attribute("href"),
                "today_name_is_exact": today_link.inner_text().strip() in {"Start shadowing", "Resume shadowing"},
            },
        )
        save_screenshot(page, output, run, "--today-after-exit")
    except Exception as exc:
        run["execution_error"] = safe_error(exc, live=False)
        add_check(
            run,
            "runner.scenario-completed",
            False,
            expected="real clock/rate/loop/gap/persistence scenario completed",
            actual=run["execution_error"],
        )
        try:
            save_screenshot(page, output, run, "--failure")
        except Exception as screenshot_exc:
            run["screenshot_error"] = safe_error(screenshot_exc, live=False)
    finally:
        finish_fixture_run(run, router, raw)
        context.close()
    return run


def reconciliation_run(browser: Browser, browser_name: str, base: str, output: Path, timeout: int, scenario: str) -> dict[str, Any]:
    run = new_run(browser_name, scenario, "desktop", "light")
    context, page, router, raw = create_fixture_page(browser, base, scenario, "desktop", "light", timeout)
    prefs = {"rate": 0.5, "gapSeconds": 5, "mode": "repeat", "showSpanish": True}
    if scenario == "empty_library":
        router.cards = []
    elif scenario == "malformed_storage":
        context.add_init_script("localStorage.setItem('atr.shadow.v1', '{not valid json')")
    elif scenario == "storage_denied":
        context.add_init_script("""(() => {
          const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
          Storage.prototype.getItem = function(k) { if (k === 'atr.shadow.v1') throw new DOMException('Denied', 'SecurityError'); return get.call(this, k); };
          Storage.prototype.setItem = function(k,v) { if (k === 'atr.shadow.v1') throw new DOMException('Denied', 'QuotaExceededError'); return set.call(this, k,v); };
        })()""")
    elif scenario in {"removed_clip", "changed_audio"}:
        context.add_init_script("localStorage.setItem('atr.shadow.v1', " + json.dumps(json.dumps({"version": 1, "clipId": 1, "preferences": prefs})) + ")")
        if scenario == "removed_clip":
            router.cards = [c for c in router.cards if c["phrase_id"] != 1]
        else:
            next(c for c in router.cards if c["phrase_id"] == 1)["audio_url"] = base + ALT_MEDIA
    try:
        navigate_shadow(page, base, run, timeout)
        if scenario == "empty_library":
            page.get_by_role("heading", name="Your voice, your clips.").wait_for()
            add_check(run, "empty.actionable-without-player", page.get_by_role("link", name="Open Library", exact=True).is_visible() and page.get_by_role("button", name="Refresh clips", exact=True).is_visible() and not chooser(page).count(), expected="Library/source actions without an unusable player", actual={"clip_choices": chooser(page).count()})
        else:
            wait_ready(page, timeout)
            summary = media_summary(page)
            add_check(run, "restore.no-autoplay", event_count(summary, "play-call") == 0, expected="restored state never plays automatically", actual=event_count(summary, "play-call"))
            if scenario == "removed_clip":
                add_check(run, "restore.removed-id-reconciled", chooser(page).input_value() != "1" and page.get_by_text("Your previous clip is no longer active.", exact=False).is_visible(), expected="current library replaces removed saved ID with visible notice", actual=chooser(page).input_value())
            if scenario == "changed_audio":
                current = latest_media(summary) or {}
                add_check(run, "restore.current-fetched-audio", current.get("path") == ALT_MEDIA, expected="current API URL replaces historical audio", actual=current.get("path"))
            if scenario == "storage_denied":
                add_check(run, "storage.actionable-local-only-failure", page.get_by_text("Device storage is unavailable.", exact=False).is_visible(), expected="practice remains usable with truthful persistence warning", actual=page.get_by_text("Device storage is unavailable.", exact=False).count())
            button_start_or_resume(page).focus()
            page.keyboard.press("Enter")
            wait_phase(page, {"playing"}, timeout)
            page.wait_for_timeout(200)
            current = latest_media(media_summary(page)) or {}
            add_check(run, "recovery.real-playback", current.get("currentTime", 0) > 0.02, expected="real audio clock advances after explicit start", actual=current.get("currentTime"))
            # Exercise pagehide interruption without leaving the disposable page.
            page.evaluate("window.dispatchEvent(new Event('pagehide'))")
            wait_phase(page, {"idle", "paused"}, timeout)
            a = media_summary(page)
            page.wait_for_timeout(250)
            b = media_summary(page)
            add_check(run, "lifecycle.pagehide-stops", all(m["paused"] for m in b["media"]) and event_count(a, "play-call") == event_count(b, "play-call"), expected="all owners paused and no delayed restart on pagehide", actual={"all_paused": all(m["paused"] for m in b["media"])})
        save_screenshot(page, output, run)
    except Exception as exc:
        add_check(run, "runner.scenario-completed", False, expected="reconciliation scenario completes", actual=safe_error(exc, live=False))
        save_screenshot(page, output, run, "--failure")
    finally:
        finish_fixture_run(run, router, raw)
        context.close()
    return run


def pending_source_switch_run(
    browser: Browser,
    browser_name: str,
    base: str,
    output: Path,
    timeout: int,
) -> dict[str, Any]:
    run = new_run(browser_name, "pending_source_switch", "desktop", "light")
    context, page, router, raw = create_fixture_page(
        browser, base, run["scenario"], "desktop", "light", timeout
    )
    held: Any | None = None
    try:
        navigate_shadow(page, base, run, timeout)
        wait_ready(page, timeout)
        select_clip(page, 3, "Audio sintético pendiente para cambiar de fuente.")
        page.evaluate("window.__shadowQa.resetTimers()")
        button_start_or_resume(page).click()
        wait_phase(page, {"loading"}, timeout)
        held = router.wait_for_held_media(page, timeout)
        before_switch = media_summary(page)
        old_index = len(before_switch["media"]) - 1
        count_before = page.get_by_test_id("shadow-count").inner_text().strip()
        select_clip(page, 2, ALT_SPANISH)
        page.wait_for_timeout(150)
        release_result = router.release_held(held, fulfill=True)
        held = None
        page.evaluate(
            """(index) => {
              window.__shadowQa.dispatch(index, 'loadedmetadata');
              window.__shadowQa.dispatch(index, 'canplay');
              window.__shadowQa.dispatch(index, 'ended');
            }""",
            old_index,
        )
        page.wait_for_timeout(300)
        after_switch = media_summary(page)
        long_timers = [timer for timer in after_switch["timers"] if 1_000 <= timer["delay"] <= 15_000]
        add_check(
            run,
            "source-switch.cancels-pending-load-timer",
            bool(long_timers)
            and any(timer["cleared"] for timer in long_timers)
            and player_phase(page) not in {"loading", "playing", "gap"},
            expected="pending <=15s load/play timeout is cleared when source changes",
            actual={"timers": long_timers, "phase": player_phase(page), "held_release": release_result},
        )
        add_check(
            run,
            "source-switch.fences-stale-media-events",
            page.get_by_test_id("shadow-count").inner_text().strip() == count_before
            and event_count(after_switch, "play-call") == event_count(before_switch, "play-call"),
            expected="late loaded/canplay/ended from detached old audio cannot complete or autoplay the new source",
            actual={
                "count_before": count_before,
                "count_after": page.get_by_test_id("shadow-count").inner_text().strip(),
                "play_calls_before": event_count(before_switch, "play-call"),
                "play_calls_after": event_count(after_switch, "play-call"),
            },
        )
        button_start_or_resume(page).click()
        wait_phase(page, {"playing"}, timeout)
        page.wait_for_timeout(250)
        current = latest_media(media_summary(page))
        add_check(
            run,
            "source-switch.new-source-user-start",
            bool(current) and current["path"] == ALT_MEDIA and current["currentTime"] > 0.08,
            expected="new source starts only after a fresh user gesture",
            actual={"path": (current or {}).get("path"), "current_time": (current or {}).get("currentTime")},
        )
        page.get_by_role("button", name="Pause", exact=True).click()
    except Exception as exc:
        run["execution_error"] = safe_error(exc, live=False)
        add_check(
            run,
            "runner.scenario-completed",
            False,
            expected="pending source-switch cancellation scenario completed",
            actual=run["execution_error"],
        )
        try:
            save_screenshot(page, output, run, "--failure")
        except Exception as screenshot_exc:
            run["screenshot_error"] = safe_error(screenshot_exc, live=False)
    finally:
        if held is not None:
            router.release_held(held, fulfill=False)
        for pending in list(router.held_media):
            router.release_held(pending, fulfill=False)
        finish_fixture_run(run, router, raw)
        context.close()
    return run


def recovery_run(
    browser: Browser,
    browser_name: str,
    base: str,
    output: Path,
    timeout: int,
    scenario: str,
    phrase_id: int,
    spanish: str,
) -> dict[str, Any]:
    run = new_run(browser_name, scenario, "desktop", "light")
    context, page, router, raw = create_fixture_page(browser, base, scenario, "desktop", "light", timeout)
    try:
        navigate_shadow(page, base, run, timeout)
        wait_ready(page, timeout)
        select_clip(page, phrase_id, spanish)
        retry = page.get_by_role("button", name="Retry audio", exact=True)
        if scenario == "error_retry":
            try:
                # preload="auto" normally surfaces the intercepted 404 as soon
                # as the source is selected. If an engine defers the read, use
                # the visible Start control as the required user gesture.
                retry.wait_for(state="visible", timeout=min(3_000, timeout))
            except PlaywrightTimeoutError:
                if not (retry.count() and retry.is_visible()):
                    button_start_or_resume(page).click()
        else:
            button_start_or_resume(page).click()
        retry.wait_for(state="visible", timeout=timeout)
        error_status = page.get_by_test_id("shadow-status").inner_text().strip()
        failed_summary = media_summary(page)
        add_check(
            run,
            f"{scenario}.actionable-error",
            player_phase(page) == "error" and retry.is_enabled() and bool(error_status),
            expected="error phase, visible actionable status, enabled Retry audio",
            actual={"phase": player_phase(page), "retry_enabled": retry.is_enabled(), "status": error_status},
        )
        if scenario == "error_retry":
            add_check(
                run,
                "error-retry.exact-media-404",
                router.error_media_attempts == 1
                and (any(item["path"] == ERROR_MEDIA and item["status"] == 404 for item in raw["http_errors"])
                     or any(item["path"] == ERROR_MEDIA and item["failure"] == "Load request cancelled" for item in raw["request_failures"])),
                expected="one exact locally intercepted media 404; WebKit can cancel failed media before its response callback",
                actual={"attempts": router.error_media_attempts, "http_errors": raw["http_errors"]},
            )
        else:
            add_check(
                run,
                "rejected-play.promise-observed",
                event_count(failed_summary, "play-rejected") == 1 and not raw["http_errors"],
                expected="one synthetic NotAllowedError play rejection and no HTTP error",
                actual={"rejections": event_count(failed_summary, "play-rejected"), "http_error_count": len(raw["http_errors"])},
            )

        retry.click()
        wait_phase(page, {"playing"}, timeout)
        page.wait_for_timeout(300)
        recovered = latest_media(media_summary(page))
        add_check(
            run,
            f"{scenario}.user-gesture-retry-recovers",
            bool(recovered) and recovered["currentTime"] > 0.08,
            expected="Retry audio user gesture starts real decoded WAV playback",
            actual={
                "current_time": (recovered or {}).get("currentTime"),
                "media_attempts": router.error_media_attempts if scenario == "error_retry" else len(router.media_requests),
            },
        )
        if scenario == "error_retry":
            add_check(
                run,
                "error-retry.second-read-succeeds",
                router.error_media_attempts == 2,
                expected="exactly two media reads: fixture 404 then decodable WAV",
                actual=router.error_media_attempts,
            )
        page.get_by_role("button", name="Pause", exact=True).click()
    except Exception as exc:
        run["execution_error"] = safe_error(exc, live=False)
        add_check(
            run,
            "runner.scenario-completed",
            False,
            expected=f"{scenario} scenario completed",
            actual=run["execution_error"],
        )
        try:
            save_screenshot(page, output, run, "--failure")
        except Exception as screenshot_exc:
            run["screenshot_error"] = safe_error(screenshot_exc, live=False)
    finally:
        finish_fixture_run(run, router, raw)
        context.close()
    return run


def finish_live_run(
    run: dict[str, Any],
    router: LiveRouter,
    raw: dict[str, list[Any]],
    live_context: dict[str, Any],
) -> None:
    run["network"] = router.evidence()
    runtime_context = {
        **live_context,
        "expected_telemetry_guard_blocks": router.expected_telemetry_attempts,
    }
    runtime, counts = public_runtime(
        raw, run["scenario"], live=True, live_context=runtime_context
    )
    lifetime_observations = {
        lifetime: {
            "response_count": sum(
                item.get("page_lifetime") == lifetime for item in raw["responses"]
            ),
            "console_count": sum(
                item.get("page_lifetime") == lifetime for item in raw["console"]
            ),
            "page_error_count": sum(
                isinstance(item, dict) and item.get("page_lifetime") == lifetime
                for item in raw["page_errors"]
            ),
            "request_failure_count": sum(
                item.get("page_lifetime") == lifetime
                for item in raw["request_failures"]
            ),
            "http_error_count": sum(
                item.get("page_lifetime") == lifetime for item in raw["http_errors"]
            ),
        }
        for lifetime in ("today-entry", "shadow-playback-exit")
    }
    both_page_lifetimes_observed = all(
        evidence["response_count"] > 0
        for evidence in lifetime_observations.values()
    )
    runtime["page_lifetime_observations"] = lifetime_observations
    run["runtime"] = runtime
    add_check(
        run,
        "live.safety-no-writes",
        not router.mutation_attempts,
        expected=(
            "zero unexpected non-GET/HEAD/OPTIONS requests; the only expected exception is "
            "an exact same-origin Cloudflare RUM POST blocked before dispatch"
        ),
        actual={
            "count": len(router.mutation_attempts),
            "methods": sorted({item["method"] for item in router.mutation_attempts}),
            "expected_blocked_rum_posts": len(router.expected_telemetry_attempts),
        },
    )
    selected = run.get("selected_media_evidence", {})
    add_check(
        run,
        "live.actual-get-api-and-selected-media",
        router.api_get_count > 0
        and selected.get("exact_selected_get_count", 0) > 0
        and selected.get("successful_response_count", 0) > 0
        and selected.get("media_content_type_count", 0) > 0
        and selected.get("performance_entry_count", 0) > 0
        and selected.get("performance_completed_count", 0) > 0,
        expected=(
            "actual API GET plus exact selected-media GET with successful media Content-Type "
            "response and completed Resource Timing evidence"
        ),
        actual={
            "api_get_count": router.api_get_count,
            "route_media_resource_type_count": router.media_get_count,
            **selected,
        },
    )
    add_check(
        run,
        "live.runtime-clean",
        counts["unexpected_console"] == 0
        and counts["page_errors"] == 0
        and counts["unexpected_request_failures"] == 0
        and counts["unexpected_http_errors"] == 0
        and both_page_lifetimes_observed,
        expected=(
            "both isolated Page lifetimes observed with no unexpected runtime/HTTP "
            "failures (exact telemetry remains classified)"
        ),
        actual={
            **counts,
            "both_page_lifetimes_observed": both_page_lifetimes_observed,
        },
    )


def live_run(
    browser: Browser,
    browser_name: str,
    base: str,
    output: Path,
    timeout: int,
    device: str,
) -> dict[str, Any]:
    del output  # Live public artifacts are report-only; screenshots are prohibited.
    run = new_run(browser_name, "live_read_only", device, "light")
    run["artifact_privacy"] = "No live screenshots or learner text are written."
    context, today_page, router, raw = create_live_page(browser, base, timeout, device)
    live_context: dict[str, Any] = {
        "base_origin": base.rstrip("/"),
        "base_netloc": urlparse(base).netloc,
        "selected_media_url": "",
        "selected_media_proven_success": False,
        "today_document_proven_success": False,
        "today_entry_click_proven_success": False,
        "today_entry_page_lifetime": "today-entry",
        "today_entry_started_at": 0.0,
        "today_entry_completed_at": 0.0,
        "shadow_document_proven_success": False,
        "shadow_navigation_page_lifetime": "shadow-playback-exit",
        "shadow_navigation_started_at": 0.0,
        "shadow_navigation_completed_at": 0.0,
        "exit_page_lifetime": "shadow-playback-exit",
        "exit_started_at": 0.0,
        "exit_completed_at": 0.0,
        "exit_target_proven_success": False,
    }
    try:
        # Settle Today completely before exercising the real user entry. This
        # Page remains observed for the whole run, but playback/exit uses a
        # second Page so a harness navigation cannot cancel Today assets.
        today_response = today_page.goto(
            base + "/", wait_until="load", timeout=timeout
        )
        today_entry = today_page.get_by_role(
            "link", name=re.compile(r"^(Start|Resume) shadowing$"), exact=True
        )
        today_entry.wait_for(state="visible", timeout=timeout)
        today_page.wait_for_function(
            "document.readyState === 'complete'", timeout=timeout
        )
        # Network-idle is not a valid readiness condition on the live page:
        # Cloudflare RUM can retry while the fully loaded, hydrated control is
        # already stable. Require the actual accessible entry to remain visible
        # across a bounded quiet window before the user click instead.
        today_page.wait_for_timeout(750)
        today_entry.wait_for(state="visible", timeout=timeout)
        today_href = today_entry.get_attribute("href") or ""
        today_label_valid = today_entry.inner_text().strip() in {
            "Start shadowing",
            "Resume shadowing",
        }
        today_href_valid = urlparse(today_href).path.rstrip("/") == "/shadow"
        live_context["today_document_proven_success"] = bool(
            today_response and today_response.ok and today_label_valid and today_href_valid
        )

        live_context["today_entry_started_at"] = time.monotonic()
        today_entry.click()
        today_page.wait_for_url(
            re.compile(r"/shadow/?$"), wait_until="domcontentloaded", timeout=timeout
        )
        today_heading = today_page.get_by_role(
            "heading", name="Find your rhythm.", exact=True
        )
        today_shadow_region = today_page.get_by_role(
            "region", name="Shadowing player", exact=True
        )
        today_heading.wait_for(state="visible", timeout=timeout)
        today_shadow_region.wait_for(state="visible", timeout=timeout)
        wait_ready(today_page, timeout)
        today_page.wait_for_timeout(500)
        today_entry_path_valid = urlparse(today_page.url).path.rstrip("/") == "/shadow"
        live_context["today_entry_click_proven_success"] = bool(
            live_context["today_document_proven_success"]
            and today_entry_path_valid
            and today_heading.is_visible()
            and today_shadow_region.is_visible()
        )
        live_context["today_entry_completed_at"] = time.monotonic()

        # Playback starts in an independently observed Page. A direct document
        # load here cannot terminate the settled Today-entry Page lifetime.
        page = create_observed_live_page(
            context,
            router,
            raw,
            timeout,
            page_lifetime="shadow-playback-exit",
        )
        live_context["shadow_navigation_started_at"] = time.monotonic()
        shadow_response = page.goto(
            base.rstrip("/") + "/shadow/", wait_until="domcontentloaded", timeout=timeout
        )
        page.get_by_role("heading", name="Find your rhythm.", exact=True).wait_for(
            state="visible", timeout=timeout
        )
        page.get_by_role("region", name="Shadowing player", exact=True).wait_for(
            state="visible", timeout=timeout
        )
        wait_ready(page, timeout)
        live_context["shadow_navigation_completed_at"] = time.monotonic()
        live_context["shadow_document_proven_success"] = bool(
            shadow_response
            and shadow_response.ok
            and urlparse(page.url).path.rstrip("/") == "/shadow"
        )
        run["navigation"] = {
            "today_status": today_response.status if today_response else None,
            "entry_shadow_path_valid": today_entry_path_valid,
            "playback_shadow_status": shadow_response.status if shadow_response else None,
            "playback_shadow_path_valid": urlparse(page.url).path.rstrip("/") == "/shadow",
            "observed_page_lifetimes": ["today-entry", "shadow-playback-exit"],
        }
        add_check(
            run,
            "live.today-start-resume-click",
            live_context["today_entry_click_proven_success"]
            and live_context["shadow_document_proven_success"]
            and page is not today_page,
            expected=(
                "a settled Today Start/Resume user click reaches the real hydrated Shadowing "
                "region, independently from the playback document"
            ),
            actual={
                "today_status": today_response.status if today_response else None,
                "label_valid": today_label_valid,
                "href_valid": today_href_valid,
                "clicked_shadow_path_valid": today_entry_path_valid,
                "clicked_shadow_heading_visible": today_heading.is_visible(),
                "clicked_shadow_region_visible": today_shadow_region.is_visible(),
                "playback_shadow_status": shadow_response.status if shadow_response else None,
                "playback_shadow_ready": live_context["shadow_document_proven_success"],
                "separate_page_lifetimes_observed": page is not today_page,
            },
        )

        if device == "desktop":
            nav_links = page.get_by_role("link", name="Shadowing", exact=True)
            nav_valid = any(
                nav_links.nth(index).is_visible()
                and urlparse(nav_links.nth(index).get_attribute("href") or "").path.rstrip("/")
                == "/shadow"
                for index in range(nav_links.count())
            )
            nav_actual = {"desktop_visible_shadowing_link": nav_valid}
        else:
            menu = page.locator("[data-nav-more]")
            summary = menu.locator("summary")
            if summary.count():
                summary.click()
            mobile_link = menu.get_by_role("link", name="Shadowing", exact=True)
            nav_valid = bool(
                menu.count() == 1
                and mobile_link.count() == 1
                and mobile_link.is_visible()
                and urlparse(mobile_link.get_attribute("href") or "").path.rstrip("/")
                == "/shadow"
            )
            nav_actual = {"mobile_more_visible_shadowing_link": nav_valid}
            if menu.get_attribute("open") is not None:
                page.keyboard.press("Escape")
        add_check(
            run,
            "live.responsive-navigation-entry",
            nav_valid,
            expected="responsive navigation exposes an exact Shadowing link to /shadow/",
            actual=nav_actual,
        )

        # No selected option text, source URL, localStorage value, console text,
        # or body copy is copied into this run/report.
        start = button_start_or_resume(page)
        start.click()
        wait_phase(page, {"playing"}, timeout)
        first = latest_media(media_summary(page))
        page.wait_for_timeout(650)
        second = latest_media(media_summary(page))
        advance = (second or {}).get("currentTime", 0) - (first or {}).get("currentTime", 0)
        live_context["selected_media_url"] = page.evaluate(
            "window.__shadowQa.selectedUrl()"
        )
        performance_entries = page.evaluate(
            """(url) => performance.getEntriesByName(url).map((entry) => ({
              initiator_type: entry.initiatorType || '',
              duration_positive: entry.duration > 0,
              response_end_positive: entry.responseEnd > 0,
            }))""",
            live_context["selected_media_url"],
        )
        run["selected_media_evidence"] = router.selected_media_evidence(
            live_context["selected_media_url"], raw["responses"], performance_entries
        )
        selected_evidence = run["selected_media_evidence"]
        live_context["selected_media_proven_success"] = bool(
            selected_evidence["exact_selected_get_count"] > 0
            and selected_evidence["successful_response_count"] > 0
            and selected_evidence["media_content_type_count"] > 0
            and selected_evidence["performance_completed_count"] > 0
        )
        add_check(
            run,
            "live.user-start-clock",
            bool(first and second) and advance > 0.12,
            expected="user gesture starts selected live media and its real clock advances",
            actual={"advanced": advance > 0.12, "advance_seconds": round(max(0.0, advance), 3)},
        )
        page.get_by_role("button", name="Pause", exact=True).click()
        wait_phase(page, {"paused"}, timeout)
        paused_first = latest_media(media_summary(page))
        page.wait_for_timeout(400)
        paused_second = latest_media(media_summary(page))
        paused_delta = abs((paused_second or {}).get("currentTime", 0) - (paused_first or {}).get("currentTime", 0))
        add_check(
            run,
            "live.pause-freezes-clock",
            bool(paused_second) and paused_second["paused"] and paused_delta <= 0.08,
            expected="Pause freezes live media clock",
            actual={"paused": bool(paused_second and paused_second["paused"]), "stable": paused_delta <= 0.08},
        )

        button_start_or_resume(page).click()
        wait_phase(page, {"playing"}, timeout)
        pauses_before = media_summary(page)["sessionPauseCalls"]
        live_context["exit_started_at"] = time.monotonic()
        page.get_by_role("link", name="Exit shadowing", exact=True).click()
        page.wait_for_function(r"location.pathname.replace(/\/$/, '') !== '/shadow'", timeout=timeout)
        live_context["exit_completed_at"] = time.monotonic()
        pauses_after = page.evaluate("Number(sessionStorage.getItem('__shadowQaPauseCalls') || '0')")
        returned_entry = page.get_by_role(
            "link", name=re.compile(r"^(Start|Resume) shadowing$"), exact=True
        )
        returned_entry.wait_for(state="visible", timeout=timeout)
        returned_href_valid = (
            urlparse(returned_entry.get_attribute("href") or "").path.rstrip("/") == "/shadow"
        )
        returned_today_path = urlparse(page.url).path.rstrip("/") == ""
        live_context["exit_target_proven_success"] = bool(
            live_context["today_document_proven_success"]
            and returned_href_valid
            and returned_today_path
        )
        add_check(
            run,
            "live.navigation-stops-playback-and-restores-today-entry",
            pauses_after > pauses_before and returned_href_valid and returned_today_path,
            expected="Exit stops live playback and restores the Today Start/Resume route",
            actual={
                "pause_observed": pauses_after > pauses_before,
                "today_entry_restored": returned_href_valid,
                "today_path_restored": returned_today_path,
            },
        )
    except Exception as exc:
        run["execution_error"] = safe_error(exc, live=True)
        add_check(
            run,
            "runner.scenario-completed",
            False,
            expected="live Today/navigation/start/clock/pause/exit smoke completed",
            actual=run["execution_error"],
        )
    finally:
        finish_live_run(run, router, raw, live_context)
        context.close()
    return run


def deadline_run(report: dict[str, Any], browser_name: str) -> None:
    report["runs"].append(
        {
            "browser": browser_name,
            "scenario": "suite_deadline",
            "device": "n/a",
            "theme": "n/a",
            "checks": [
                {
                    "id": "runner.bounded-deadline",
                    "passed": False,
                    "expected": "all scenarios complete before --max-seconds",
                    "actual": "bounded suite deadline reached",
                    "detail": "Investigate the stalled preview; the safety cap cannot exceed 295 seconds.",
                }
            ],
        }
    )


def markdown_report(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "# Shadowing browser harness report",
        "",
        "## Result",
        "",
        f"- **Status:** {report['status'].upper()}",
        f"- **Mode:** {report['mode']}",
        f"- **Target:** `{report['base']}`",
        f"- **Browser host:** `{report['browser_execution_host']}`",
        f"- **Browsers:** {', '.join(report['browsers_requested'])}",
        f"- **Runs:** {summary['run_count']}",
        f"- **Checks:** {summary['check_count']} ({summary['passed_checks']} passed, {summary['failed_checks']} failed)",
        f"- **Screenshots:** {summary['screenshot_count']}",
        f"- **Attempted application writes:** {summary['mutation_attempts']}",
        f"- **Production writes:** {summary['production_writes']}",
        "",
        "## Safety",
        "",
    ]
    if report["live"]:
        lines.extend(
            [
                "- Actual API/media reads were GET/HEAD/OPTIONS only.",
                "- The exact same-origin Cloudflare RUM POST was separately counted and blocked before dispatch.",
                "- Every other non-safe method was blocked before dispatch and would fail the run.",
                "- JSON excludes selected source text, option labels, query strings, response bodies, localStorage values, and console text.",
                "- Live mode writes no screenshots; public artifacts contain sanitized reports only.",
            ]
        )
    else:
        lines.extend(
            [
                "- `/api/cards` used exact `{cards,total,limit,offset}` in-process fixtures with 108 active cards and 100-item pagination.",
                f"- Media was the in-memory labelled PCM WAV `{WAV_LABEL}`; no fixture API/media read reached production.",
                "- Every non-safe method was blocked before dispatch and treated as a failure.",
                "- Only the exact Cloudflare beacon family and exact `/cdn-cgi/rum` path were classified as telemetry.",
            ]
        )
    lines.extend(["", "## Actionable failures", ""])
    failures = report["actionable_failures"]
    if not failures:
        lines.append("None.")
    else:
        lines.extend(["| Browser | Scenario | Device | Check | Actual |", "|---|---|---|---|---|"])
        for failure in failures:
            actual = json.dumps(failure.get("actual"), ensure_ascii=False).replace("|", "\\|")
            if len(actual) > 400:
                actual = actual[:397] + "..."
            lines.append(
                f"| {failure['browser']} | {failure['scenario']} | {failure['device']} | `{failure['id']}` | {actual} |"
            )
    lines.extend(["", "## Run matrix", "", "| Browser | Scenario | Device | Theme | Result | Screenshots |", "|---|---|---|---|---|---|"])
    for run in report["runs"]:
        failed = sum(not check.get("passed") for check in run.get("checks", []))
        result = "PASS" if failed == 0 else f"FAIL ({failed})"
        screenshots = ", ".join(f"`{name}`" for name in run.get("screenshots", [])) or "—"
        lines.append(
            f"| {run.get('browser')} | {run.get('scenario')} | {run.get('device')} | {run.get('theme')} | {result} | {screenshots} |"
        )
    lines.extend(
        [
            "",
            "## Coverage",
            "",
            "- Chromium and WebKit; desktop 1440×1000, mobile 390×844, and narrow 320×700",
            "- Light and dark screenshots, overflow, navigation, mobile More, and authoritative accessible names",
            "- Complete >100 active-card pagination, provenance/source filters, missing audio, and Spanish/English visibility",
            "- Real decoded media clock, playback rates, replay, gapless and delayed loops, pause/resume, and visit counts",
            "- Pending timeout cancellation, stale callback fencing, source changes, refresh stop, and navigation stop",
            "- HTTP media error retry, rejected `play()` retry, minimal persistence, and gesture-only restoration",
            "- No microphone, `/api/sessions`, grading, FSRS activity, or production writes",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    base, browsers = validate_args(args)
    # Keep argument validation and Python syntax/import checks usable on the VPS;
    # refuse immediately before Playwright starts or launches a browser.
    execution_host = refuse_vps_browser_launch()
    if sync_playwright is None:
        raise SystemExit(
            "Playwright for Python is required. Install Playwright 1.63 and the requested "
            "Chromium/WebKit browser binaries in CI or on the browser worker."
        ) from PLAYWRIGHT_IMPORT_ERROR
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    deadline = started + args.max_seconds
    report: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "live read-only" if args.live else "fixture-only (not live validation)",
        "live": args.live,
        "base": base,
        "output": str(args.output.resolve()),
        "browser_execution_host": execution_host,
        "browsers_requested": browsers,
        "browser_versions": {},
        "devices": {name: value["viewport"] for name, value in DEVICES.items()},
        "fixture": None
        if args.live
        else {
            "active_card_count": FIXTURE_TOTAL,
            "page_size": 100,
            "envelope_keys": ["cards", "total", "limit", "offset"],
            "media_label": WAV_LABEL,
            "media_format": "PCM WAV, mono, 16-bit, 16000 Hz",
            "text": "synthetic Spanish/English only",
        },
        "safety": {
            "allowed_methods": sorted(SAFE_METHODS),
            "mutations": "blocked before dispatch and treated as failures",
            "service_workers": "blocked",
            "production_writes": 0,
            "live_json_private_text": "excluded" if args.live else "not applicable; fixtures are synthetic",
        },
        "runs": [],
        "browser_launch_failures": [],
    }

    with sync_playwright() as playwright:
        for browser_name in browsers:
            if time.monotonic() >= deadline:
                deadline_run(report, browser_name)
                break
            browser: Browser | None = None
            try:
                browser = getattr(playwright, browser_name).launch(headless=True)
                assert browser is not None
                report["browser_versions"][browser_name] = browser.version
                if args.live:
                    for device in ("desktop", "mobile-390"):
                        report["runs"].append(
                            live_run(
                                browser,
                                browser_name,
                                base,
                                args.output,
                                args.timeout,
                                device,
                            )
                        )
                    continue

                for device in DEVICES:
                    for theme in THEMES:
                        if time.monotonic() >= deadline:
                            deadline_run(report, browser_name)
                            raise TimeoutError("bounded suite deadline reached")
                        report["runs"].append(
                            visual_run(
                                browser,
                                browser_name,
                                base,
                                args.output,
                                device,
                                theme,
                                args.timeout,
                                deep_checks=device == "desktop" and theme == "light",
                            )
                        )
                for behavior in (
                    *(lambda scenario=scenario: reconciliation_run(browser, browser_name, base, args.output, args.timeout, scenario) for scenario in ("empty_library", "malformed_storage", "storage_denied", "removed_clip", "changed_audio")),
                    lambda: playback_and_persistence_run(browser, browser_name, base, args.output, args.timeout),
                    lambda: pending_source_switch_run(browser, browser_name, base, args.output, args.timeout),
                    lambda: recovery_run(
                        browser,
                        browser_name,
                        base,
                        args.output,
                        args.timeout,
                        "error_retry",
                        4,
                        "Audio sintético con un error recuperable.",
                    ),
                    lambda: recovery_run(
                        browser,
                        browser_name,
                        base,
                        args.output,
                        args.timeout,
                        "rejected_play",
                        5,
                        "Audio sintético con reproducción rechazada.",
                    ),
                ):
                    if time.monotonic() >= deadline:
                        deadline_run(report, browser_name)
                        raise TimeoutError("bounded suite deadline reached")
                    report["runs"].append(behavior())
            except TimeoutError as exc:
                report["browser_launch_failures"].append(
                    {"browser": browser_name, "error": f"{type(exc).__name__}: {exc}"}
                )
                break
            except Exception as exc:
                report["browser_launch_failures"].append(
                    {"browser": browser_name, "error": safe_error(exc, live=args.live)}
                )
            finally:
                if browser is not None:
                    browser.close()

    checks = [check for run in report["runs"] for check in run.get("checks", [])]
    failures = [
        {
            "browser": run.get("browser"),
            "scenario": run.get("scenario"),
            "device": run.get("device"),
            "theme": run.get("theme"),
            **check,
        }
        for run in report["runs"]
        for check in run.get("checks", [])
        if not check.get("passed")
    ]
    mutation_attempts = sum(
        len(run.get("network", {}).get("mutation_attempts", []))
        + int(run.get("network", {}).get("mutation_attempt_count", 0))
        for run in report["runs"]
    )
    screenshots = sorted({name for run in report["runs"] for name in run.get("screenshots", [])})
    report["summary"] = {
        "run_count": len(report["runs"]),
        "check_count": len(checks),
        "passed_checks": sum(bool(check.get("passed")) for check in checks),
        "failed_checks": len(failures),
        "mutation_attempts": mutation_attempts,
        "production_writes": 0,
        "screenshot_count": len(screenshots),
        "screenshots": screenshots,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "bounded_under_seconds": args.max_seconds,
    }
    report["status"] = (
        "passed" if not failures and not report["browser_launch_failures"] and mutation_attempts == 0 else "failed"
    )
    report["actionable_failures"] = failures

    json_path = args.output / "report.json"
    markdown_path = args.output / "report.md"
    json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    markdown_path.write_text(markdown_report(report) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": report["status"],
                "mode": report["mode"],
                "report_json": str(json_path.resolve()),
                "report_markdown": str(markdown_path.resolve()),
                **report["summary"],
                "browser_launch_failures": report["browser_launch_failures"],
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
