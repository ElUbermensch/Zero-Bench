#!/usr/bin/env node
/* Build both apps and assemble the deployable site.
 *
 *   site/            Zero
 *   site/bench/      Bench
 *
 * Zero is at the root because it is the app that already has users. They are
 * bookmarked at the origin, their home screens point there, and the PWA they
 * installed has that scope. Putting Bench at the root would have sent every
 * returning shooter to a reloading app they had never seen, with their logbook
 * apparently gone -- it is still in localStorage, which is per-origin, but they
 * would have no way to know that.
 *
 * One assembly path, used by every host. The GitHub Pages workflow used to do
 * this inline in bash and Vercel would have needed its own copy -- two
 * procedures that must agree, which is the same shape of mistake as the
 * hand-maintained zero-core copy. There is one now, and the workflow calls it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');

const cfg = loadConfig();
execFileSync(process.execPath, [path.join(ROOT, 'apps/bench/build.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(ROOT, 'apps/zero/build.mjs')], { stdio: 'inherit' });

fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(path.join(SITE, 'bench'), { recursive: true });
fs.cpSync(path.join(ROOT, 'apps/zero/dist'), SITE, { recursive: true });
fs.cpSync(path.join(ROOT, 'apps/bench/dist'), path.join(SITE, 'bench'), { recursive: true });

const count = (d) => fs.readdirSync(d, { recursive: true }).length;
console.log(`site/ assembled — ${count(SITE)} entries` +
  (cfg.ok ? `\n  backend: ${cfg.url}` : `\n  ⚠ NO BACKEND (${cfg.reason}) — both apps will ask for one on first run`));
