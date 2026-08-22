import crypto from 'node:crypto';
import { loadConfig } from '../../tools/config.mjs';
import { FACE_CSS, FONT_FILES } from '../../packages/fonts/face-css.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// resolve against this file, so `npm run build` works from the repo root
const HERE = path.dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);
const read = f => fs.readFileSync(f, 'utf8');
const shell = read('src/shell.html');
// zero-core is embedded verbatim, the same generated copy Zero carries, so the
// two apps cannot drift into different sync behaviour. tools/embed-core.mjs
// owns the copy; `npm test` fails if it goes stale.
const core = read('../../packages/zero-core/zero-core.js')
  .replace("if (typeof module !== 'undefined' && module.exports) module.exports = ZeroCore;\n", '');
// The backend, injected the same way Zero gets it: one file, both apps.
const cfg = loadConfig();
const conf = `const SHARED_SUPABASE = ${JSON.stringify({ url: cfg.url, anonKey: cfg.anonKey })};`;
const js = [conf, read('src/qr.js'), core, read('src/sync.js'), read('src/app.js')].join('\n');
if (/<\/script|<!--/i.test(js)) throw new Error('payload would close the inline script');
// replace via a FUNCTION: a string replacement expands $' and $& inside the payload
/* The faces go in ahead of everything else in the stylesheet, so a rule can
 * rely on them. Injected rather than pasted into shell.html so the two apps
 * cannot end up declaring different faces for the same family. */
const withFaces = shell.replace('<style>', () => '<style>\n' + FACE_CSS);
const out = withFaces.replace('<!--APP-->', () => '<script>\n' + js + '\n<\/script>');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', out);
fs.copyFileSync('src/manifest.webmanifest', 'dist/manifest.webmanifest');
// Cache name = hash of the page actually built, so shipping an update never
// depends on remembering to bump a version string.
const hash = crypto.createHash('sha256').update(out).digest('hex').slice(0, 12);
fs.writeFileSync('dist/sw.js',
  read('src/sw.js')
    .replace('__CACHE_VERSION__', `bench-${hash}`)
    .replace('__FONT_URLS__', JSON.stringify(FONT_FILES.map(f => './fonts/' + f))));
// Icons are committed under src/ rather than generated: dist/ is gitignored, so
// a fresh clone would otherwise build a PWA with no icons at all.
fs.mkdirSync('dist/fonts', { recursive: true });
for (const f of FONT_FILES) {
  fs.copyFileSync(path.join('../../packages/fonts', f), path.join('dist/fonts', f));
}
fs.mkdirSync('dist/icons', { recursive: true });
for (const f of fs.readdirSync('src/icons')) fs.copyFileSync('src/icons/' + f, 'dist/icons/' + f);
console.log('dist/index.html', (out.length / 1024).toFixed(1), 'KB · cache bench-' + hash
  + (cfg.ok ? '' : '\n  \u26a0 backend not configured — Bench stays local-only'));
