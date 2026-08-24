import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT=path.resolve('dist');
const srv=http.createServer((q,r)=>{let p=q.url.split('?')[0];if(!p.startsWith('/bench/')){r.writeHead(404);return r.end()}p=p.slice(6);if(p==='/'||p==='')p='/index.html';const f=path.join(ROOT,p);if(!fs.existsSync(f)){r.writeHead(404);return r.end()}r.writeHead(200,{'Content-Type':'text/html'});fs.createReadStream(f).pipe(r)});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await (await b.newContext({viewport:{width:420,height:900},deviceScaleFactor:2.5})).newPage();
await p.goto(`http://127.0.0.1:${srv.address().port}/bench/`);
await p.waitForTimeout(500);
await p.evaluate(()=>{
  const combos=[['bottleneck','rimless','6.5 Creedmoor — bottleneck, rimless'],
                ['bottleneck','rimmed','.303 British — bottleneck, rimmed'],
                ['bottleneck','belted','7mm Rem Mag — bottleneck, belted'],
                ['straight','rimless','9mm Luger — straight, rimless'],
                ['straight','rimmed','.45-70 — straight, rimmed']];
  document.getElementById('view').innerHTML = combos.map(([shape,head,label])=>
    `<div class="card"><div class="small muted">${label}</div>
     <div class="casewrap mt8">${caseSvg({neck:'R',head:'K'},{cart:{shape,head}})}</div></div>`).join('');
});
await p.waitForTimeout(300);
await p.locator('#view').screenshot({path:'shots/case-shapes.png'});
await b.close(); srv.close();
