/* Build Zero into a real installable PWA.
 *
 * Three things happen here that used to be manual or missing:
 *   1. the shared backend config is injected, so it lives in ONE file
 *   2. the service-worker cache name is a hash of what was actually built,
 *      so shipping an update cannot depend on remembering to bump a string
 *   3. the manifest, icons and service worker get copied at all — Zero was
 *      served as a bare index.html and could not be installed to a home
 *      screen, which is the one place a range app needs to be
 *
 * Exported rather than script-only because the browser suites build their own
 * copy pointed at the mock. That is deliberate: with a backend configured, the
 * app correctly HIDES the manual server-address fields, and tests that typed
 * into those fields only ever passed because the config was empty. Building
 * the way a deploy builds means the suites exercise the shipped path.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { loadConfig } from '../../tools/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const at = (...p) => path.join(HERE, ...p);

/** @param {{url:string, anonKey:string, outdir?:string, single?:boolean}} o */
export async function buildZero(o) {
  const outdir = o.outdir ? at(o.outdir) : at('dist');
  const shared = JSON.stringify({ url: o.url || '', anonKey: o.anonKey || '' });

  await esbuild.build({
    absWorkingDir: HERE,
    entryPoints: ['entry.jsx'],
    bundle: true,
    loader: { '.jsx': 'jsx' },
    jsx: 'automatic',
    define: { __SUPABASE_CONFIG__: shared },
    outfile: path.join(outdir, 'bundle.js'),
  });

  const bundle = fs.readFileSync(path.join(outdir, 'bundle.js'));
  const hash = crypto.createHash('sha256').update(bundle).digest('hex').slice(0, 12);

  fs.mkdirSync(path.join(outdir, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(outdir, 'index.html'), fs.readFileSync(at('src/shell.html')));
  fs.writeFileSync(path.join(outdir, 'sw.js'),
    fs.readFileSync(at('src/sw.js'), 'utf8').replace('__CACHE_VERSION__', `zero-${hash}`));
  fs.copyFileSync(at('src/manifest.webmanifest'), path.join(outdir, 'manifest.webmanifest'));
  for (const f of fs.readdirSync(at('src/icons'))) {
    fs.copyFileSync(at('src/icons', f), path.join(outdir, 'icons', f));
  }

  /* A single self-contained file, for opening straight off disk or sending to
   * a phone without deploying. No service worker: an inlined page has nothing
   * to fetch, and registering one from a file:// origin fails anyway. */
  if (o.single !== false) {
    const text = bundle.toString('utf8');
    if (/<\/script/i.test(text)) throw new Error('bundle would close its own script tag');
    fs.writeFileSync(path.join(outdir, 'zero-single.html'),
      fs.readFileSync(at('src/shell.html'), 'utf8')
        .replace('<script src="bundle.js"></script>', () => '<script>\n' + text + '\n</script>')
        .replace(/<link rel="manifest"[^>]*>\n?/, '')
        .replace(/<script>\n\/\* Registered from the page[\s\S]*?<\/script>\n?/, ''));
  }

  return { bytes: bundle.length, cache: `zero-${hash}` };
}

/* CLI: build for deployment, from supabase.config.json. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const r = await buildZero({ url: cfg.url, anonKey: cfg.anonKey });
  console.log(`dist/bundle.js ${(r.bytes / 1024 / 1024).toFixed(2)} MB · cache ${r.cache}` +
              (cfg.ok ? '' : `\n  ⚠ backend not configured (${cfg.reason}) — the app will ask for it on first run`));
}
