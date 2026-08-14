/* Build Zero into a real installable PWA.
 *
 * Three things happen here that used to be manual or missing:
 *   1. the shared backend config is injected, so it lives in ONE file
 *   2. the service-worker cache name is a hash of what was actually built,
 *      so shipping an update cannot depend on remembering to bump a string
 *   3. the manifest, icons and service worker get copied at all — Zero was
 *      served as a bare index.html and could not be installed to a home
 *      screen, which is the one place a range app needs to be
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { loadConfig } from '../../tools/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);

const cfg = loadConfig();
const shared = JSON.stringify({ url: cfg.url, anonKey: cfg.anonKey });

await esbuild.build({
  absWorkingDir: HERE,
  entryPoints: ['entry.jsx'],
  bundle: true,
  loader: { '.jsx': 'jsx' },
  jsx: 'automatic',
  define: { __SUPABASE_CONFIG__: shared },
  outfile: 'dist/bundle.js',
});

const bundle = fs.readFileSync('dist/bundle.js');
const hash = crypto.createHash('sha256').update(bundle).digest('hex').slice(0, 12);

fs.mkdirSync('dist/icons', { recursive: true });
fs.writeFileSync('dist/index.html', fs.readFileSync('src/shell.html', 'utf8'));
fs.writeFileSync('dist/sw.js',
  fs.readFileSync('src/sw.js', 'utf8').replace('__CACHE_VERSION__', `zero-${hash}`));
fs.copyFileSync('src/manifest.webmanifest', 'dist/manifest.webmanifest');
for (const f of fs.readdirSync('src/icons')) fs.copyFileSync('src/icons/' + f, 'dist/icons/' + f);

/* A single self-contained file, for opening straight off disk or sending to a
 * phone without deploying. No service worker: an inlined page has nothing to
 * fetch, and registering one from a file:// origin fails anyway. */
const single = fs.readFileSync('src/shell.html', 'utf8')
  .replace('<script src="bundle.js"></script>', () => '<script>\n' + bundle.toString('utf8') + '\n</script>')
  .replace(/<link rel="manifest"[^>]*>\n?/, '')
  .replace(/<script>\n\/\* Registered from the page[\s\S]*?<\/script>\n?/, '');
if (/<\/script/i.test(bundle.toString('utf8'))) throw new Error('bundle would close its own script tag');
fs.writeFileSync('dist/zero-single.html', single);

console.log(`dist/bundle.js ${(bundle.length / 1024 / 1024).toFixed(2)} MB · cache zero-${hash}` +
            (cfg.ok ? '' : `\n  ⚠ backend not configured (${cfg.reason}) — the app will ask for it on first run`));
