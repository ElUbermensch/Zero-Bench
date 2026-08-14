import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// resolve against this file, so `npm run build` works from the repo root
const HERE = path.dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);
const read = f => fs.readFileSync(f, 'utf8');
const shell = read('src/shell.html');
const js = [read('src/qr.js'), read('src/app.js')].join('\n');
if (/<\/script|<!--/i.test(js)) throw new Error('payload would close the inline script');
// replace via a FUNCTION: a string replacement expands $' and $& inside the payload
const out = shell.replace('<!--APP-->', () => '<script>\n' + js + '\n<\/script>');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', out);
for (const f of ['manifest.webmanifest', 'sw.js']) fs.copyFileSync('src/' + f, 'dist/' + f);
// Icons are committed under src/ rather than generated: dist/ is gitignored, so
// a fresh clone would otherwise build a PWA with no icons at all.
fs.mkdirSync('dist/icons', { recursive: true });
for (const f of fs.readdirSync('src/icons')) fs.copyFileSync('src/icons/' + f, 'dist/icons/' + f);
console.log('dist/index.html', (out.length / 1024).toFixed(1), 'KB');
