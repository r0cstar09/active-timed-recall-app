"""Generate Recall's PWA assets from its version-controlled vector mark.
Run with: uv run --with cairosvg python scripts/generate_brand.py
"""
from pathlib import Path
import cairosvg

ROOT = Path(__file__).resolve().parents[1] / 'public'
ICON = (ROOT / 'icons/icon.svg').read_text()
for name, size in [('icon-192.png',192), ('icon-512.png',512), ('icon-maskable-512.png',512), ('apple-touch-icon.png',180)]:
    cairosvg.svg2png(bytestring=ICON.encode(), write_to=str(ROOT / 'icons' / name), output_width=size, output_height=size)
(ROOT / 'icons/favicon.svg').write_text(ICON)
splash = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1170 2532"><rect width="1170" height="2532" fill="#f7f8f2"/><svg x="465" y="1100" width="240" height="240" viewBox="0 0 512 512">''' + ICON.split('>',1)[1].rsplit('</svg>',1)[0] + '''</svg><text x="585" y="1440" text-anchor="middle" fill="#182b25" font-size="64" font-family="Georgia,serif">Recall</text></svg>'''
cairosvg.svg2png(bytestring=splash.encode(), write_to=str(ROOT / 'splash/apple-splash-1170-2532.png'))
og = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#182b25"/><circle cx="1150" cy="570" r="225" fill="none" stroke="#d7f568" stroke-width="2" opacity=".28"/><circle cx="1150" cy="570" r="285" fill="none" stroke="#d7f568" stroke-width="2" opacity=".16"/><text x="80" y="110" fill="#d7f568" font-family="sans-serif" font-size="23" letter-spacing="5">RECALL / SPANISH, EVERY DAY.</text><text x="76" y="290" fill="#f7f8f2" font-family="Georgia,serif" font-size="84">Find the words.</text><text x="76" y="395" fill="#d7f568" font-family="Georgia,serif" font-size="84">Make them yours.</text><text x="80" y="535" fill="#becdb5" font-family="sans-serif" font-size="25">Meaning-first learning. A little practice. Lasting confidence.</text></svg>'''
cairosvg.svg2png(bytestring=og.encode(), write_to=str(ROOT / 'og/spanish-recall-og.png'))
print('Generated 4 PNG icons, vector favicon, iPhone splash, and social preview.')
