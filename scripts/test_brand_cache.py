#!/usr/bin/env python3
"""Brand assets use immutable cache headers: every rendered URL needs a version."""
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
urls = []
for name in ('src/layouts/Base.astro', 'src/components/Nav.astro'):
    urls.extend(re.findall(r'(?:src|href|content)="(/(?:icons/|og/|splash/|manifest\.webmanifest)[^"]+)"', (ROOT / name).read_text()))
manifest = json.loads((ROOT / 'public/manifest.webmanifest').read_text())
urls.extend(icon['src'] for icon in manifest['icons'])
assert len(urls) >= 12, ('Missing brand references', urls)
versions = set()
for url in urls:
    parsed = urlparse(url)
    version = parse_qs(parsed.query).get('v')
    assert version and version[0], ('Unversioned immutable brand URL', url)
    versions.add(version[0])
    assert (ROOT / 'public' / parsed.path.lstrip('/')).is_file(), ('Missing asset', url)
assert len(versions) == 1, ('Mixed branding versions', versions)
print(f'Brand cache contract passed: {len(urls)} rendered/PWA references; version {next(iter(versions))}')
