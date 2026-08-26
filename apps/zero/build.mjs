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
import { FACE_CSS, FONT_FILES } from '../../packages/fonts/face-css.mjs';
import { buildId } from '../../tools/build-id.mjs';

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

  fs.mkdirSync(path.join(outdir, 'fonts'), { recursive: true });
  for (const f of FONT_FILES) {
    fs.copyFileSync(at('../../packages/fonts', f), path.join(outdir, 'fonts', f));
  }
  fs.mkdirSync(path.join(outdir, 'icons'), { recursive: true });
  /* The faces go in the HEAD rather than in the bundle: the browser can start
   * fetching them while the JavaScript is still downloading, and they are
   * plain CSS with no reason to sit inside a 1.5MB script. One source
   * (packages/fonts) feeds both apps, so the two cannot declare different
   * faces for the same family. */
  /* The build stamp goes in the HEAD, not the bundle: the cache name is a hash
   * OF the bundle, so anything derived from it cannot also be inside it. */
  const build = buildId();
  const shellBody = fs.readFileSync(at('src/shell.html'), 'utf8')
    .replace('</head>', () => `<style>\n${FACE_CSS}\n</style>\n</head>`);
  fs.writeFileSync(path.join(outdir, 'index.html'),
    shellBody.replace('</head>',
      () => `<script>window.__BUILD__=${JSON.stringify(build.id)}</script>\n</head>`));

  /* The cache name hashes the SHELL as well as the bundle.
   *
   * It used to hash bundle.js alone, and index.html is cache-first with no
   * revalidation -- so a change confined to the shell never reached an
   * installed user. Not "eventually": the served sw.js was byte-identical, and
   * the registration URL carries ?v=window.__BUILD__ read from the CACHED
   * index.html, so the version query did not change either. A fix to the iOS
   * status-bar style, a theme colour, a font declaration, or the registration
   * logic itself stayed invisible until some unrelated bundle change happened
   * to move the hash. Worse, the on-device build stamp -- which exists purely
   * to answer "is this the new one" -- kept reporting the old build, so the
   * diagnosis was actively misleading.
   *
   * The stamp itself is deliberately EXCLUDED from the hashed text: it carries
   * a minute-resolution timestamp, so including it would change the cache name
   * on every build and re-download the whole shell for every installed user on
   * every deploy, source change or not. */
  /* The font BYTES are in the hash too, not just their names. They are copied
   * to ./fonts/<name>.woff2 with no content hash in the filename, so a face
   * that is re-cut under the same name changes neither the bundle nor the
   * shell -- and the precached copy is then served forever. */
  const h = crypto.createHash('sha256').update(bundle).update(shellBody);
  for (const f of FONT_FILES) h.update(fs.readFileSync(at('../../packages/fonts', f)));
  const hash = h.digest('hex').slice(0, 12);

  fs.writeFileSync(path.join(outdir, 'sw.js'),
    fs.readFileSync(at('src/sw.js'), 'utf8')
      .replace('__CACHE_VERSION__', `zero-${hash}`)
      .replace('__FONT_URLS__', JSON.stringify(FONT_FILES.map(f => './fonts/' + f))));
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
