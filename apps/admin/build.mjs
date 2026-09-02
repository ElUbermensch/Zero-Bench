import { loadConfig } from '../../tools/config.mjs';
import { FACE_CSS, FONT_FILES } from '../../packages/fonts/face-css.mjs';
import { buildId } from '../../tools/build-id.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// resolve against this file, so `npm run build` works from the repo root
const HERE = path.dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);
const read = f => fs.readFileSync(f, 'utf8');
const shell = read('src/shell.html');
/* The same generated zero-core copy the two apps carry. The dashboard needs it
 * for exactly three things -- sign in, rpc(), selectView() -- but embedding the
 * one file rather than a hand-written subset means the auth and token-refresh
 * behaviour here cannot drift from the apps it reports on.
 * tools/embed-core.mjs owns the copy; `npm test` fails if it goes stale. */
const core = read('../../packages/zero-core/zero-core.js')
  .replace("if (typeof module !== 'undefined' && module.exports) module.exports = ZeroCore;\n", '');
const cfg = loadConfig();
const build = buildId();
const conf = `const SHARED_SUPABASE = ${JSON.stringify({ url: cfg.url, anonKey: cfg.anonKey })};\n`
  + `const BUILD_ID = ${JSON.stringify(build.id)};`;
const js = [conf, core, read('src/app.js')].join('\n');
if (/<\/script|<!--/i.test(js)) throw new Error('payload would close the inline script');
// replace via a FUNCTION: a string replacement expands $' and $& inside the payload
const withFaces = shell.replace('<style>', () => '<style>\n' + FACE_CSS);
const out = withFaces.replace('<!--APP-->', () => '<script>\n' + js + '\n<\/script>');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', out);
/* No service worker and no manifest, deliberately. This is not an offline-first
 * PWA: every number on it comes from a query, so a cached shell would only ever
 * show a spinner or yesterday's figures. It is a page you open. */
fs.mkdirSync('dist/fonts', { recursive: true });
for (const f of FONT_FILES) {
  fs.copyFileSync(path.join('../../packages/fonts', f), path.join('dist/fonts', f));
}
console.log('dist/index.html', (out.length / 1024).toFixed(1), 'KB'
  + (cfg.ok ? '' : '\n  ⚠ backend not configured — the dashboard has nothing to read'));
