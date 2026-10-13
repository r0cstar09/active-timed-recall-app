#!/usr/bin/env python3
"""Read-only live verification on CI/Alienware. Never submit learner work."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from test_verb_selector_browser import CORE_SPANISH_VERBS, NEXT_30_SPANISH_VERBS, refuse_vps_browser_launch

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://spanish-app.tonymuzo.dev'
API = 'https://api-spanish.tonymuzo.dev'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', choices=['chromium', 'webkit'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    refuse_vps_browser_launch()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'mode': 'live GET-only, no fixtures', 'browser': args.browser, 'assets': [], 'views': [], 'mutation_attempts': [], 'blocked_analytics': []}
    try:
        with sync_playwright() as p:
            browser = getattr(p, args.browser).launch()
            request = p.request.new_context()
            html = (ROOT / 'dist/verbs/index.html').read_text()
            assets = sorted(set(re.findall(r'(?:component-url|href)="(/_astro/[^" ]+(?:\.js|\.css))"', html)))
            assets = [a for a in assets if 'VerbTrainer.' in a or a.endswith('.css')]
            assert any('VerbTrainer.' in a for a in assets), 'Missing expected built island'
            live = request.get(BASE + '/verbs/')
            assert live.ok, live.status
            for asset in assets:
                assert asset in live.text(), f'Live document does not reference {asset}'
                response = request.get(BASE + asset)
                assert response.ok, (asset, response.status)
                expected = hashlib.sha256((ROOT / 'dist' / asset.lstrip('/')).read_bytes()).hexdigest()
                actual = hashlib.sha256(response.body()).hexdigest()
                assert actual == expected, f'Asset mismatch: {asset}'
                report['assets'].append({'path': asset, 'sha256': actual})
            for device, viewport in [('desktop', {'width': 1440, 'height': 1000}), ('phone', {'width': 390, 'height': 844})]:
                context = browser.new_context(viewport=viewport, service_workers='block')
                errors, payloads = [], {}
                page = context.new_page()
                page.set_default_timeout(45000)
                page.on('pageerror', lambda error: errors.append(str(error)))

                def guard(route):
                    req = route.request
                    url = urlparse(req.url)
                    if req.method not in {'GET', 'HEAD', 'OPTIONS'}:
                        target = 'blocked_analytics' if url.netloc == urlparse(BASE).netloc and url.path == '/cdn-cgi/rum' and req.method == 'POST' else 'mutation_attempts'
                        report[target].append({'method': req.method, 'url': req.url})
                        route.abort()
                    else:
                        route.continue_()

                def observe(response):
                    url = urlparse(response.url)
                    if url.netloc == urlparse(API).netloc and url.path in ['/api/study/verbs', '/api/study/verb-progress'] and response.ok:
                        payloads[url.path] = response.json()

                page.route('**/*', guard)
                page.on('response', observe)
                response = page.goto(BASE + '/verbs/', wait_until='domcontentloaded')
                assert response.ok
                selector = page.get_by_role('combobox', name='Choose verb', exact=True)
                page.wait_for_function("Array.from(document.querySelectorAll('select')).some(s => !s.disabled && s.querySelectorAll('optgroup').length === 4)")
                assert selector.is_enabled()
                catalog = payloads['/api/study/verbs']['verbs']
                progress = {v['verb']: v for v in payloads['/api/study/verb-progress']['items']}
                completed = [v['verb'] for v in catalog if progress.get(v['verb'], {}).get('completed') in (1, True)]
                core = [v for v in CORE_SPANISH_VERBS if v not in completed]
                next30 = [v for v in NEXT_30_SPANISH_VERBS if v not in completed]
                other = [v['verb'] for v in catalog if v['verb'] not in set(completed) | set(CORE_SPANISH_VERBS) | set(NEXT_30_SPANISH_VERBS)]
                groups = selector.evaluate('(s) => Array.from(s.querySelectorAll("optgroup")).map(g => Array.from(g.querySelectorAll("option")).map(o => o.value))')
                assert groups == [completed, core, next30, other], 'Live partition/order mismatch'
                expected_completed = sum(v in completed for v in NEXT_30_SPANISH_VERBS)
                panel = page.locator('.verb-next-priority')
                assert f'{expected_completed} / 30 completed' in panel.inner_text()
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'Horizontal overflow'
                page.screenshot(path=str(args.output / f'{device}-ready.png'), animations='disabled')
                selector.select_option('pagar')
                page.get_by_text('Next 30 · priority 6', exact=True).wait_for(state='visible')
                panel.locator('summary').click()
                assert panel.locator('.verb-next-list li strong').all_text_contents() == list(NEXT_30_SPANISH_VERBS)
                panel.screenshot(path=str(args.output / f'{device}-next30.png'), animations='disabled')
                assert not errors, errors
                assert not report['mutation_attempts'], report['mutation_attempts']
                report['views'].append({'device': device, 'catalog_count': len(catalog), 'group_counts': [len(g) for g in groups], 'next_completed': expected_completed, 'page_errors': errors})
                context.close()
            request.dispose()
            browser.close()
        report['status'] = 'passed'
    except Exception as exc:
        report['status'] = 'failed'
        report['error'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        (args.output / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
        print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
