#!/usr/bin/env node
/* Zero.jsx carries zero-core inline rather than importing it, because the
 * single-file build has to be openable straight off disk with no bundler.
 *
 * That inline copy used to be maintained by hand, and it drifted: the relay
 * client gained per-shooter attribution in packages/zero-core while Zero.jsx
 * kept the old host-only version, so the app silently refused to mirror a
 * second shooter's shots and every symptom pointed somewhere else. Successive
 * hand-patches also left four orphaned copies of the header comment behind.
 *
 * So it is a generated region now, fenced by markers, and a build step.
 * `--check` fails instead of writing, which is what `npm test` runs: drift
 * becomes a red build rather than an afternoon of debugging the wrong file.
 *
 *   node tools/embed-core.mjs            rewrite the region
 *   node tools/embed-core.mjs --check    exit 1 if it is out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'apps/zero/Zero.jsx');
const SOURCE = path.join(ROOT, 'packages/zero-core/zero-core.js');

const BEGIN = '//#region zero-core — GENERATED from packages/zero-core/zero-core.js, do not edit';
const FINISH = '//#endregion zero-core';
// Used only to locate the region the very first time, before markers exist.
const LEGACY_HEAD = ' * zero-core — shared auth + sync layer for the Zero PWA family';
const LEGACY_TAIL = '/* ── Shared deployment ';

const core = fs.readFileSync(SOURCE, 'utf8')
  .replace("if (typeof module !== 'undefined' && module.exports) module.exports = ZeroCore;\n", '')
  .replace(/\s+$/, '');

const src = fs.readFileSync(TARGET, 'utf8');

let start = src.indexOf(BEGIN);
let end;
if (start >= 0) {
  const f = src.indexOf(FINISH, start);
  if (f < 0) { console.error('embed-core: begin marker without end marker'); process.exit(2); }
  end = f + FINISH.length + 1;                       // include the newline
} else {
  // First run: swallow everything from the first stray copy of the header
  // down to the next real declaration, orphaned duplicates included.
  const h = src.indexOf(LEGACY_HEAD);
  const t = src.indexOf(LEGACY_TAIL);
  if (h < 0 || t < 0 || t < h) {
    console.error('embed-core: could not locate the embedded region in Zero.jsx');
    process.exit(2);
  }
  start = src.lastIndexOf('/*', h);
  end = t;
}

const next = src.slice(0, start) + BEGIN + '\n' + core + '\n' + FINISH + '\n' + src.slice(end);

if (next === src) { console.log('embed-core: up to date'); process.exit(0); }
if (process.argv.includes('--check')) {
  console.error("embed-core: Zero.jsx's inline zero-core is STALE.\n" +
                '  Run `node tools/embed-core.mjs` and rebuild.');
  process.exit(1);
}
fs.writeFileSync(TARGET, next);
console.log(`embed-core: refreshed (${core.split('\n').length} lines)`);
