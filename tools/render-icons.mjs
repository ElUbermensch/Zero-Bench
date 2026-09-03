#!/usr/bin/env node
/* Cut each app's PNG icons from its own icon.svg.
 *
 *   node tools/render-icons.mjs
 *
 * The SVG beside them is the master; the PNGs are output that happens to be
 * committed, because dist/ is gitignored and a fresh clone must still build a
 * PWA with icons. Without this script they are three binaries per app that
 * nobody can regenerate, and editing the SVG silently changes nothing that
 * ships -- the manifests name the PNGs.
 *
 * Playwright is already a devDependency and its chromium is already installed
 * for the app suites, so this needs no new tooling.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['zero', 'bench', 'admin'];
const BG = '#0f1117';

/* A maskable icon is cropped by Android -- to a circle on most launchers, to
 * assorted squircles elsewhere -- and only the middle 80% is guaranteed to
 * survive. So the mark is scaled about the centre while the background stays
 * full bleed. 0.78 rather than 0.80 because a mark ending exactly on the
 * boundary looks like it is about to be cut even when it is not. */
const SAFE = 0.78;

const inner = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const browser = await chromium.launch();
const shoot = async (svg, px) => {
  const page = await browser.newPage({ viewport: { width: px, height: px } });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:${BG}}` +
    `svg{display:block;width:${px}px;height:${px}px}</style>${svg}`, { waitUntil: 'load' });
  const buf = await page.screenshot();
  await page.close();
  return buf;
};

for (const app of APPS) {
  const dir = path.join(ROOT, 'apps', app, 'src', 'icons');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

  // The full-bleed background is re-added around the scaled mark, so dropping
  // the original rect is what keeps it from being scaled with it.
  const maskable =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img">` +
    `<rect width="512" height="512" fill="${BG}"/>` +
    `<g transform="translate(256 256) scale(${SAFE}) translate(-256 -256)">` +
    `${inner(svg).replace(/<rect width="512" height="512"[^/]*\/>/, '')}</g></svg>`;

  for (const px of [192, 512]) {
    fs.writeFileSync(path.join(dir, `icon-${px}.png`), await shoot(svg, px));
  }
  fs.writeFileSync(path.join(dir, 'icon-maskable-512.png'), await shoot(maskable, 512));
  console.log(`${app}: icon-192.png, icon-512.png, icon-maskable-512.png from icon.svg`);
}
await browser.close();
