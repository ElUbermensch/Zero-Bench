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

/* The staleness gate runs HERE, on the path a deploy actually takes.
 *
 * It existed, and it was wired into `npm test` and `npm run build:zero` -- but
 * vercel.json's buildCommand is `npm run build:site`, and this script called
 * apps/zero/build.mjs directly. So Vercel and the Pages workflow both skipped
 * it. Worse than skipping: Bench reads packages/zero-core/zero-core.js at build
 * time while Zero ships the copy inlined in Zero.jsx, so a stale embed does not
 * ship an old engine to both apps -- it ships the NEW engine to Bench and the
 * OLD one to Zero. A sync fix lands in one app and silently does not land in
 * the other, which is the exact class of bug the shared package exists to end,
 * and the build log says nothing. */
try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools/embed-core.mjs'), '--check'],
               { stdio: 'inherit' });
} catch (e) {
  // The check has already said what is wrong; a stack trace on top of it just
  // buries the one line a deploy log reader needs.
  console.error('build:site: refusing to ship a stale embed — '
    + 'run `node tools/embed-core.mjs`, commit, and redeploy.');
  process.exit(1);
}

/* And a deploy does not ship an app that cannot reach its backend.
 *
 * loadConfig returns { ok: false } and every caller printed a warning and
 * carried on, so the failure was a log line. A Preview deploy, or Production
 * variables set after the first build, produced an app that shows the
 * manual server-address fields again to a user who had already signed in --
 * and quietly stops syncing while their outbox grows. */
const cfg = loadConfig();
if (!cfg.ok && process.env.ALLOW_UNCONFIGURED_BUILD !== '1') {
  console.error(`build:site: refusing to ship without a backend — ${cfg.reason}\n`
    + '  Set SUPABASE_URL and SUPABASE_ANON_KEY, or fill supabase.config.json.\n'
    + '  ALLOW_UNCONFIGURED_BUILD=1 to build a deliberately local-only site.');
  process.exit(1);
}

execFileSync(process.execPath, [path.join(ROOT, 'apps/bench/build.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(ROOT, 'apps/zero/build.mjs')], { stdio: 'inherit' });

fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(path.join(SITE, 'bench'), { recursive: true });
fs.cpSync(path.join(ROOT, 'apps/zero/dist'), SITE, { recursive: true });
fs.cpSync(path.join(ROOT, 'apps/bench/dist'), path.join(SITE, 'bench'), { recursive: true });

const count = (d) => fs.readdirSync(d, { recursive: true }).length;
console.log(`site/ assembled — ${count(SITE)} entries` +
  (cfg.ok ? `\n  backend: ${cfg.url}` : `\n  ⚠ NO BACKEND (${cfg.reason}) — both apps will ask for one on first run`));
