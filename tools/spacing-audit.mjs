/* Vertical rhythm and edge inset, measured rather than eyeballed.
 *
 * "Slight issue with the padding below in bench as well as the padding above on
 * zero's more tab. Also in loads and firearms it has some weirdness with the
 * spacing that feels inconsistent."
 *
 * Three complaints, three different measurements, and none of them is visible
 * to a suite that only asserts on content. This walks every screen in both apps
 * and prints:
 *
 *   TOP     the gap between the header and the first thing under it
 *   INSET   each block's distance from the left and right edges
 *   GAP     the gap between consecutive blocks
 *   TAIL    whether anything is hidden behind, or short of, the tab bar
 *
 * Inconsistency is the finding, not any particular number: a screen where the
 * blocks sit at 13px and 14px alternately reads as broken without anyone being
 * able to say why.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startMock } from '../packages/zero-core/mock-supabase.mjs';
import { buildZero } from '../apps/zero/build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH = fs.existsSync(CHROME) ? { executablePath: CHROME } : {};

const mock = await startMock({ ttlSec: 3600 });
await buildZero({ url: mock.url, anonKey: 'anon-key', outdir: 'dist-audit', single: false });
execFileSync(process.execPath, [path.join(ROOT, 'apps/bench/build.mjs')], {
  stdio: 'pipe', env: { ...process.env, SUPABASE_URL: mock.url, SUPABASE_ANON_KEY: 'anon-key' },
});

const ZERO_DIR = path.join(ROOT, 'apps/zero/dist-audit');
const BENCH_DIR = path.join(ROOT, 'apps/bench/dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  let dir = ZERO_DIR;
  if (p.startsWith('/bench/')) { dir = BENCH_DIR; p = p.slice('/bench'.length); }
  if (p === '/' || p === '') p = '/index.html';
  const f = path.join(dir, p);
  if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch(LAUNCH);
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const page = await ctx.newPage();

/* A notched phone, simulated.
 *
 * Chromium has no safe-area insets, so `env(safe-area-inset-bottom)` is 0 and
 * every layout that depends on paying that inset back renders perfectly here
 * and wrong on the device. That is not hypothetical -- it is the whole reason
 * the tab-bar bugs in both apps were only ever found by looking at a phone.
 *
 * Overriding the four variables the CSS actually reads reproduces the device
 * condition in a headless browser. It is not the same as real insets (nothing
 * moves the viewport), but every rule in either app consumes the inset through
 * these variables, so it exercises exactly the code that was getting it wrong.
 */
const NOTCH = `:root{--safe-t:59px !important;--safe-b:34px !important;
                     --safe-l:0px !important;--safe-r:0px !important}`;
const wearNotch = () => page.addStyleTag({ content: NOTCH });

let findings = 0;
const flag = (s) => { findings++; console.log('    ⚠ ' + s); };

/* One screen's geometry. `scope` is the scrolling region, `header` the thing
 * above it and `bar` the thing below, so the same probe serves both apps. */
const probe = (scopeSel, headerSel, barSel) => page.evaluate(([scopeSel, headerSel, barSel]) => {
  const scope = document.querySelector(scopeSel);
  const header = document.querySelector(headerSel);
  const bar = document.querySelector(barSel);
  if (!scope) return null;
  /* CARDS, and only cards.
   *
   * A general "what does the eye line up" heuristic is a rabbit hole: it
   * descends into section headers and reports that a right-aligned button is
   * not centred, which is true and not a defect. What a reader actually
   * registers as alignment is the painted panel -- rounded, bordered, running
   * most of the width -- and everything else takes its margin from those.
   *
   * So: rounded by at least 6px, wider than 60% of the screen, with a border
   * or a background. Outermost match on each branch; nothing inside a card is
   * measured, because a card's internals are its own business. */
  const isCard = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (parseFloat(cs.borderRadius) < 6) return false;
    if (r.width < document.documentElement.clientWidth * 0.6) return false;
    const bg = cs.backgroundColor;
    return (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg))
        || parseFloat(cs.borderTopWidth) > 0;
  };
  const kids = [];
  (function walk(node, depth) {
    for (const el of node.children) {
      const r = el.getBoundingClientRect();
      if (getComputedStyle(el).display === 'none' || r.height <= 0) continue;
      if (isCard(el)) { kids.push(el); continue; }
      if (depth < 5) walk(el, depth + 1);
    }
  })(scope, 0);
  const vw = document.documentElement.clientWidth;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: Math.round(r.left),
             right: Math.round(vw - r.right), h: Math.round(r.height),
             tag: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
               ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
             text: (el.textContent || '').trim().slice(0, 28).replace(/\s+/g, ' ') };
  };
  const boxes = kids.map(box);
  return {
    headerBottom: header ? header.getBoundingClientRect().bottom : null,
    barTop: bar ? bar.getBoundingClientRect().top : null,
    barBottom: bar ? bar.getBoundingClientRect().bottom : null,
    viewportH: document.documentElement.clientHeight,
    scrollH: scope.scrollHeight, clientH: scope.clientHeight,
    scopePadTop: parseFloat(getComputedStyle(scope).paddingTop),
    scopePadBottom: parseFloat(getComputedStyle(scope).paddingBottom),
    boxes,
  };
}, [scopeSel, headerSel, barSel]);

function report(label, g) {
  console.log('\n  ' + label);
  if (!g) { flag('screen did not render'); return; }
  if (!g.boxes.length) { flag('nothing rendered in the scroll region'); return; }

  const top = Math.round(g.boxes[0].top - g.headerBottom);
  console.log(`    TOP    ${top}px below the header`);
  if (top < 6) flag(`content is flush against the header (${top}px) — nothing separates them`);

  const insets = new Set();
  for (const b of g.boxes) {
    insets.add(`${b.left}/${b.right}`);
    if (b.left !== b.right) {
      flag(`"${b.text}" is not centred: ${b.left}px left, ${b.right}px right`);
    }
  }
  console.log(`    INSET  ${[...insets].join(', ')}`);
  if (insets.size > 1) {
    flag(`${insets.size} different edge insets on one screen — blocks do not line up`);
  }

  const gaps = [];
  for (let i = 1; i < g.boxes.length; i++) {
    gaps.push(Math.round(g.boxes[i].top - g.boxes[i - 1].bottom));
  }
  if (gaps.length) console.log(`    GAP    ${gaps.join(', ')}`);

  /* The tail. Two different failures look the same in a screenshot: content
   * running under the bar, and the bar itself stopping short of the screen. */
  if (g.barBottom != null) {
    const short = Math.round(g.viewportH - g.barBottom);
    console.log(`    TAIL   bar ends ${short}px above the viewport bottom`);
    if (short > 1) flag(`the tab bar stops ${short}px short — the page shows through beneath it`);
  }
  const last = g.boxes[g.boxes.length - 1];
  if (g.barTop != null && g.scrollH <= g.clientH + 1 && last.bottom > g.barTop) {
    flag('the last block runs under the tab bar on a screen that cannot scroll');
  }
}

/* ============================================================== Zero */
console.log('\n════ ZERO');
await page.goto(BASE);
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('rifles_v1', JSON.stringify([{ id: 'r1', name: 'Leander SR-01',
    caliber: '.223 Remington', barrelLife: 4000, roundsAtStart: 1000, ts: 1 }]));
  localStorage.setItem('ammo_v1', JSON.stringify([{ id: 'am1', name: '.223 77gr SMK XC',
    bullet: 'Sierra 77 MK', powder: 'Varget', charge: '24.1', rifleId: 'r1',
    batchId: '11111111-2222-3333-4444-555555555555', batchSerial: 'B26H23-02X', ts: 1 }]));
  localStorage.setItem('sessions_v1', JSON.stringify([{ id: 's1', name: 'league night',
    date: '2026-08-13', type: 'Score', targetId: 'any', rangeYards: 100, rifleId: 'r1',
    ammoId: 'am1', ts: 1, shots: [
      { id: 'x1', ring: '10', clockH: 12, clockM: 0, xy: { x: 0, y: 0 } },
      { id: 'x2', ring: '9', clockH: 3, clockM: 0, xy: { x: 0.42, y: 0 } }] }]));
});
await page.reload();
await page.waitForTimeout(800);

const zeroScreens = [
  ['Sessions', async () => { await page.click('.tabbar button:has-text("Sessions")'); }],
  ['Analytics', async () => { await page.click('.tabbar button:has-text("Analytics")'); }],
  ['DOPE', async () => { await page.click('.tabbar button:has-text("DOPE")'); }],
  ['More (menu)', async () => { await page.click('.tabbar button:has-text("More")'); }],
  ['More › Firearms & loads', async () => {
    await page.click('.tabbar button:has-text("More")'); await page.waitForTimeout(200);
    await page.click('button:has-text("Firearms & loads")'); }],
  ['More › Targets', async () => {
    await page.click('.tabbar button:has-text("More")'); await page.waitForTimeout(200);
    await page.click('button:has-text("Targets")'); }],
  ['More › Loads from Bench', async () => {
    await page.click('.tabbar button:has-text("More")'); await page.waitForTimeout(200);
    await page.click('button:has-text("Loads from Bench")'); }],
  ['More › Backup & data', async () => {
    await page.click('.tabbar button:has-text("More")'); await page.waitForTimeout(200);
    await page.click('button:has-text("Backup & data")'); }],
];
for (const [label, go] of zeroScreens) {
  await go(); await page.waitForTimeout(400);
  report(label, await probe('.content', '.hdr', '.tabbar'));
}

/* ============================================================= Bench */
console.log('\n════ BENCH');
await page.goto(BASE + 'bench/');
await page.waitForTimeout(700);
await page.evaluate(() => {
  DB.cartridges = [{ id: 'ca1', name: '.223 Remington' }];
  DB.brassLots = [{ id: 'bl1', serial: 'R-7K2', marks: { neck: 'R', head: 'K' },
    cartridge: 'ca1', headstamp: 'LAPUA', initialQty: 200, qty: 196, firings: 1,
    expectedFirings: 8, origin: 'new' }];
  save(); reset('lookup');
});
await page.waitForTimeout(300);

const benchScreens = [
  ['Identify', 'lookup'], ['Brass', 'brass'], ['Ammo', 'ammo'], ['More', 'more'],
];
for (const [label, arg] of benchScreens) {
  await page.click(`[data-act="tab"][data-arg="${arg}"]`);
  await page.waitForTimeout(400);
  report(label, await probe('main', 'header', 'nav.tabs'));
}

/* ================================================== the notch, simulated */
/* Chromium reports no safe-area insets, so every rule that pays one back is a
 * no-op here and the two tab-bar bugs in this project were both found by
 * looking at a phone. This pass overrides the variables and asks the one
 * question a screenshot answers instantly and a headless test never did: what
 * is painted in the strip at the very bottom of the screen? */
console.log('\n════ WEARING A NOTCH (--safe-b: 34px)');
for (const [label, url] of [['Zero', BASE], ['Bench', BASE + 'bench/']]) {
  await page.goto(url);
  await page.waitForTimeout(700);
  await wearNotch();
  /* The column is shortened by the inset to reproduce what iOS does in
   * standalone: the layout ends above the physical bottom, and whatever is
   * under it shows through. */
  await page.addStyleTag({ content: `body{height:calc(100dvh - 34px) !important}
                                     .app{min-height:calc(100dvh - 34px) !important}` });
  await page.waitForTimeout(300);
  /* Geometry, not elementFromPoint: the shim is `pointer-events:none` so that
   * it can never eat a tap, and elementFromPoint skips exactly such elements.
   * The question is what PAINTS the band, so measure what covers it. */
  const strip = await page.evaluate(() => {
    const h = document.documentElement.clientHeight;
    const bar = document.querySelector('nav.tabs, .tabbar');
    const barBottom = bar ? bar.getBoundingClientRect().bottom : h;
    const gap = Math.round(h - barBottom);
    let covers = null;
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      const bg = cs.backgroundColor;
      if (/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) continue;
      const r = el.getBoundingClientRect();
      if (r.top <= barBottom + 1 && r.bottom >= h - 1 && r.width >= window.innerWidth - 2) {
        covers = { el: el.tagName.toLowerCase() +
          (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''),
          bg };
        break;
      }
    }
    return { gap, covers, body: getComputedStyle(document.body).backgroundColor };
  });
  console.log(`\n  ${label}`);
  console.log(`    STRIP  ${strip.gap}px below the bar, painted by ` +
              (strip.covers ? `${strip.covers.el} (${strip.covers.bg})` : 'NOTHING'));
  if (strip.gap > 1 && !strip.covers) {
    flag('the strip under the tab bar paints the PAGE background: on a notched '
       + 'phone that is a dark band beneath the icons');
  }
}

console.log(`\n${findings} finding${findings === 1 ? '' : 's'}`);
await browser.close(); server.close(); await mock.stop();
process.exit(0);
