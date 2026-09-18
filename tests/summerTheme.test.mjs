import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const css = read('src/styles/studio.css');
const vars = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(block, `Missing ${selector} palette`);
  return Object.fromEntries([...block[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
};
const light = vars(':root');
const dark = { ...light, ...vars('html[data-theme="dark"]') };
const resolve = (palette, key, seen = new Set()) => {
  assert.ok(!seen.has(key), `Cyclic color alias: ${key}`);
  seen.add(key);
  const value = palette[key];
  assert.ok(value, `Missing token ${key}`);
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  return alias ? resolve(palette, alias[1], seen) : value;
};
function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return channels.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(fg, bg) {
  const [low, high] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}
function aa(palette, foreground, background) {
  const fg = foreground.startsWith('--') ? resolve(palette, foreground) : foreground;
  const bg = background.startsWith('--') ? resolve(palette, background) : background;
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1; needs 4.5:1`);
}
for (const [theme, palette] of Object.entries({ light, dark })) {
  test(`${theme}: normal text remains AA on every learning surface`, () => {
    for (const surface of ['--bg', '--paper', '--paper-warm', '--sky-soft', '--coral-soft', '--sun-soft']) {
      for (const text of ['--text', '--text-dim', '--text-faint', '--accent', '--accent-2']) aa(palette, text, surface);
    }
  });
  test(`${theme}: hero, primary buttons, and status labels retain AA contrast`, () => {
    for (const surface of ['--hero-bg', '--hero-panel']) {
      for (const text of ['--hero-ink', '--hero-muted']) aa(palette, text, surface);
    }
    aa(palette, '--on-accent', '--accent');
    aa(palette, '--forest', '--sun');
    aa(palette, '#ffffff', '--ocean');
    aa(palette, '#e6f5ff', '--ocean');
    for (const text of ['--good', '--bad', '--warn']) aa(palette, text, '--paper');
  });
  test(`${theme}: three practice areas have distinct, shared color tokens`, () => {
    assert.equal(new Set(['--sky-soft', '--coral-soft', '--sun-soft'].map(k => resolve(palette, k))).size, 3);
    for (const key of ['sky-soft', 'coral-soft', 'sun-soft']) {
      assert.ok(read('src/styles/daily-home.css').includes(`var(--${key})`));
      assert.ok(css.includes(`background: var(--${key})`));
    }
  });
}
test('PWA chrome and runtime theme updates match both CSS canvases', () => {
  const layout = read('src/layouts/Base.astro');
  for (const palette of [light, dark]) {
    const color = resolve(palette, '--bg');
    assert.ok(layout.includes(`content="${color}"`));
    assert.ok(layout.includes(`"${color}"`));
  }
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.background_color, resolve(light, '--bg'));
  assert.equal(manifest.theme_color, resolve(light, '--bg'));
});
test('bright accents stay separate from readable action/text colors', () => {
  assert.notEqual(resolve(light, '--coral'), resolve(light, '--accent-2'));
  assert.notEqual(resolve(light, '--sun'), resolve(light, '--accent'));
  assert.ok(luminance(resolve(light, '--bg')) > 0.9);
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
});
