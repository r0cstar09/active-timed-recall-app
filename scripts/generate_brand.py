#!/usr/bin/env python3
"""Generate Recall's deterministic summer PWA brand assets.

No network or SVG renderer is required. Run with:
    python3 scripts/generate_brand.py
"""

from __future__ import annotations

from math import cos, pi, sin
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1] / "public"
ICONS = ROOT / "icons"
SPLASH = ROOT / "splash"
OG = ROOT / "og"

CREAM = "#fffaf0"
SUN = "#ffd34d"
CORAL = "#e96b50"
BLUE = "#1266a1"
TEXT = "#183b4b"
DARK = "#112c40"

FONT_REGULAR = Path("/usr/share/fonts/truetype/lato/Lato-Regular.ttf")
FONT_BOLD = Path("/usr/share/fonts/truetype/lato/Lato-Bold.ttf")
FONT_HEAVY = Path("/usr/share/fonts/truetype/lato/Lato-Heavy.ttf")
RESAMPLE = Image.Resampling.LANCZOS


def svg_icon(label: str = "Recall — Spanish, every day") -> str:
    """Return the canonical solar speech-bubble/R mark as standalone SVG."""
    rays = [
        ("82", "80", "105", "103", CORAL),
        ("256", "47", "256", "80", CREAM),
        ("407", "80", "384", "103", CORAL),
        ("439", "229", "406", "229", CREAM),
        ("407", "378", "384", "355", CORAL),
        ("256", "411", "256", "378", CREAM),
        ("73", "229", "106", "229", CORAL),
    ]
    ray_markup = "\n".join(
        f'  <path d="M{x1} {y1}L{x2} {y2}" stroke="{color}" stroke-width="18" stroke-linecap="round"/>'
        for x1, y1, x2, y2, color in rays
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="{label}">
  <rect width="512" height="512" fill="{BLUE}"/>
{ray_markup}
  <path d="M184 309 139 386 232 340Z" fill="{SUN}"/>
  <circle cx="256" cy="229" r="118" fill="{SUN}"/>
  <path d="M211 293V176h55c35 0 57 18 57 46s-22 46-57 46h-55m61 0 56 50" fill="none" stroke="{DARK}" stroke-width="27" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="322" cy="166" r="13" fill="{CORAL}"/>
</svg>
'''


def _font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    if not path.is_file():
        raise FileNotFoundError(f"Required deterministic brand font is missing: {path}")
    return ImageFont.truetype(str(path), size=size)


def _capsule(draw: ImageDraw.ImageDraw, points: tuple[tuple[float, float], tuple[float, float]], width: float, fill: str) -> None:
    p1, p2 = points
    draw.line((p1, p2), fill=fill, width=round(width))
    radius = width / 2
    for x, y in (p1, p2):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def _curve(points: list[tuple[float, float]], steps: int = 24) -> list[tuple[float, float]]:
    """Sample one cubic Bézier for deterministic Pillow rendering."""
    p0, p1, p2, p3 = points
    result = []
    for index in range(steps + 1):
        t = index / steps
        mt = 1 - t
        result.append(
            (
                mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0],
                mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1],
            )
        )
    return result


def draw_mark(image: Image.Image, box: tuple[int, int, int, int], *, rounded_tile: bool = False) -> None:
    """Draw the canonical mark into box using the same geometry as the SVG."""
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = box
    scale = min(right - left, bottom - top) / 512
    ox = left + ((right - left) - 512 * scale) / 2
    oy = top + ((bottom - top) - 512 * scale) / 2

    def p(x: float, y: float) -> tuple[float, float]:
        return ox + x * scale, oy + y * scale

    if rounded_tile:
        draw.rounded_rectangle(box, radius=112 * scale, fill=BLUE)
    else:
        draw.rectangle(box, fill=BLUE)

    ray_specs = [
        ((82, 80), (105, 103), CORAL),
        ((256, 47), (256, 80), CREAM),
        ((407, 80), (384, 103), CORAL),
        ((439, 229), (406, 229), CREAM),
        ((407, 378), (384, 355), CORAL),
        ((256, 411), (256, 378), CREAM),
        ((73, 229), (106, 229), CORAL),
    ]
    for start, end, color in ray_specs:
        _capsule(draw, (p(*start), p(*end)), 18 * scale, color)

    draw.polygon([p(184, 309), p(139, 386), p(232, 340)], fill=SUN)
    cx, cy = p(256, 229)
    radius = 118 * scale
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=SUN)

    width = 27 * scale
    vertical_and_top = [p(211, 293), p(211, 176), p(266, 176)]
    bowl = _curve([p(266, 176), p(342, 176), p(342, 268), p(266, 268)])
    bowl_return = [p(211, 268)]
    _capsule(draw, (vertical_and_top[0], vertical_and_top[1]), width, DARK)
    draw.line(vertical_and_top[1:] + bowl + bowl_return, fill=DARK, width=round(width), joint="curve")
    _capsule(draw, (p(272, 268), p(328, 318)), width, DARK)

    dot_x, dot_y = p(322, 166)
    dot_radius = 13 * scale
    draw.ellipse((dot_x - dot_radius, dot_y - dot_radius, dot_x + dot_radius, dot_y + dot_radius), fill=CORAL)


def _save_png(image: Image.Image, path: Path) -> None:
    image.save(path, format="PNG", optimize=True, compress_level=9)


def generate_icons() -> None:
    source_size = 1536
    source = Image.new("RGB", (source_size, source_size), BLUE)
    draw_mark(source, (0, 0, source_size, source_size))
    for name, size in (
        ("icon-192.png", 192),
        ("icon-512.png", 512),
        ("icon-maskable-512.png", 512),
        ("apple-touch-icon.png", 180),
    ):
        _save_png(source.resize((size, size), RESAMPLE), ICONS / name)

    canonical_svg = svg_icon()
    (ICONS / "icon.svg").write_text(canonical_svg, encoding="utf-8")
    (ICONS / "favicon.svg").write_text(canonical_svg, encoding="utf-8")
    (ICONS / "icon-maskable.svg").write_text(svg_icon("Recall maskable app icon"), encoding="utf-8")


def generate_splash() -> None:
    factor = 2
    width, height = 1170, 2532
    image = Image.new("RGB", (width * factor, height * factor), CREAM)
    draw = ImageDraw.Draw(image)

    # A restrained high-summer horizon keeps the tall launch screen lively.
    sun_center = (1015 * factor, 230 * factor)
    sun_radius = 205 * factor
    draw.ellipse(
        (
            sun_center[0] - sun_radius,
            sun_center[1] - sun_radius,
            sun_center[0] + sun_radius,
            sun_center[1] + sun_radius,
        ),
        fill=SUN,
    )
    for degrees in (145, 180, 215):
        angle = degrees * pi / 180
        inner = 248 * factor
        outer = 305 * factor
        _capsule(
            draw,
            (
                (sun_center[0] + cos(angle) * inner, sun_center[1] + sin(angle) * inner),
                (sun_center[0] + cos(angle) * outer, sun_center[1] + sin(angle) * outer),
            ),
            12 * factor,
            CORAL,
        )

    tile = (415 * factor, 940 * factor, 755 * factor, 1280 * factor)
    draw_mark(image, tile, rounded_tile=True)

    title_font = _font(FONT_HEAVY, 104 * factor)
    strap_font = _font(FONT_BOLD, 35 * factor)
    draw.text((585 * factor, 1405 * factor), "Recall", font=title_font, fill=TEXT, anchor="mm")
    draw.rounded_rectangle((445 * factor, 1482 * factor, 725 * factor, 1489 * factor), radius=4 * factor, fill=CORAL)
    draw.text(
        (585 * factor, 1560 * factor),
        "SPANISH, EVERY DAY.",
        font=strap_font,
        fill=BLUE,
        anchor="mm",
        stroke_width=0,
    )

    # Mediterranean-blue base with one coral swell; kept clear of the lockup.
    wave_top = 2240
    blue_wave: list[tuple[float, float]] = [(0, height * factor), (0, wave_top * factor)]
    coral_wave: list[tuple[float, float]] = [(0, height * factor), (0, 2380 * factor)]
    for x in range(0, width + 1, 10):
        blue_y = wave_top + 26 * sin((x / width) * 2 * pi)
        coral_y = 2380 + 18 * sin((x / width) * 2 * pi + 1.0)
        blue_wave.append((x * factor, blue_y * factor))
        coral_wave.append((x * factor, coral_y * factor))
    blue_wave.extend([(width * factor, height * factor)])
    coral_wave.extend([(width * factor, height * factor)])
    draw.polygon(blue_wave, fill=BLUE)
    draw.polygon(coral_wave, fill=CORAL)

    _save_png(image.resize((width, height), RESAMPLE), SPLASH / "apple-splash-1170-2532.png")


def generate_og() -> None:
    factor = 2
    width, height = 1200, 630
    image = Image.new("RGB", (width * factor, height * factor), CREAM)
    draw = ImageDraw.Draw(image)

    # A slim color rail adds energy without competing with the message.
    draw.rectangle((0, 0, 18 * factor, height * factor), fill=CORAL)
    draw.rectangle((18 * factor, 0, 28 * factor, height * factor), fill=SUN)

    mini_box = (78 * factor, 58 * factor, 134 * factor, 114 * factor)
    draw_mark(image, mini_box, rounded_tile=True)
    label_font = _font(FONT_BOLD, 22 * factor)
    draw.text((153 * factor, 87 * factor), "RECALL  ·  SPANISH, EVERY DAY.", font=label_font, fill=BLUE, anchor="lm")

    heading_font = _font(FONT_HEAVY, 72 * factor)
    draw.text((78 * factor, 206 * factor), "Find the words.", font=heading_font, fill=TEXT, anchor="lm")
    draw.text((78 * factor, 300 * factor), "Make them yours.", font=heading_font, fill=CORAL, anchor="lm")

    body_font = _font(FONT_REGULAR, 25 * factor)
    draw.text(
        (82 * factor, 410 * factor),
        "Meaning-first learning. A little practice. Lasting confidence.",
        font=body_font,
        fill=TEXT,
        anchor="lm",
    )

    mark_box = (860 * factor, 158 * factor, 1138 * factor, 436 * factor)
    draw_mark(image, mark_box, rounded_tile=True)

    draw.rectangle((0, 566 * factor, width * factor, height * factor), fill=DARK)
    draw.ellipse((1045 * factor, 585 * factor, 1065 * factor, 605 * factor), fill=SUN)
    draw.ellipse((1083 * factor, 585 * factor, 1103 * factor, 605 * factor), fill=CORAL)
    draw.rectangle((1121 * factor, 592 * factor, 1160 * factor, 598 * factor), fill=BLUE)

    _save_png(image.resize((width, height), RESAMPLE), OG / "spanish-recall-og.png")


def main() -> None:
    for directory in (ICONS, SPLASH, OG):
        directory.mkdir(parents=True, exist_ok=True)
    generate_icons()
    generate_splash()
    generate_og()
    print("Generated 4 PNG icons, 3 vector icons, iPhone splash, and social preview.")


if __name__ == "__main__":
    main()
