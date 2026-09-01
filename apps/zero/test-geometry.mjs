/* Target geometry, tested as arithmetic rather than through a browser.
 *
 * Everything else about Zero is tested through the built app, because that is
 * where its bugs live. This file is the exception: the functions below are pure
 * mathematics, they are wrong or right by inches, and driving them through a
 * tap target would test the tap handler at the same time and report the sum.
 *
 * They are extracted from the source by name rather than imported, because
 * Zero.jsx is one file with no exports and turning it into a module to make it
 * testable would be a large change made for the test's benefit. The extraction
 * is deliberately brittle: if a function is renamed this file fails loudly on
 * the next run rather than silently testing nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, 'Zero.jsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const section = (s) => console.log('\n' + s);

const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`test-geometry: Zero.jsx has no function ${name} — renamed?`);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error(`test-geometry: could not read the body of ${name}`);
};
const NAMES = ['pointInShape', 'shapeBoundR', 'rayToEdge', 'zoneMidR', 'xyToZone',
               'synthRingsFromZones', 'ringMidR', 'clockToXY', 'shotXY'];
const G = new Function(NAMES.map(grab).join('\n') + `\nreturn {${NAMES.join(',')}};`)();
const mk = (zones) => ({ zones, rings: G.synthRingsFromZones(zones) });

/* ================================================ the shot comes back where it went */
/* A shot is stored as (score, how-far-through-that-zone, clock) whenever its
 * exact coordinates are not kept -- a session from an older build, a row pulled
 * from the server, a miss. Reconstructing it is what analytics, the plot and
 * every trend read, so if the reconstruction is wrong the group size is wrong.
 *
 * "How far through the zone" used to be measured against the BOUNDING CIRCLE,
 * which is the same distance in every direction. A rectangle is not: a hole
 * 3.1" right of centre on a 12"-wide zone is 23% of the way to the corner, and
 * 23% of the way to the corner measured sideways is 7.9". The shot came back
 * 4.8 INCHES from where it was fired, on a target 12 inches wide.
 *
 * It is measured along the shot's own bearing now, so it inverts exactly. */
section('a shot on a zone target reconstructs where it was fired');
{
  const cases = [
    ['a rectangular A zone inside a rectangular C', mk([
      { score: 'A', shape: { kind: 'rect', w: 6, h: 11 } },
      { score: 'C', shape: { kind: 'rect', w: 12, h: 24 } }])],
    ['a 12x20 steel plate', mk([{ score: '1', shape: { kind: 'rect', w: 12, h: 20, rx: 0.25 } }])],
    ['a round plate — the case that always worked', mk([{ score: '1', shape: { kind: 'circle', d: 10 } }])],
    ['an offset head box above a body zone', mk([
      { score: 'A', shape: { kind: 'rect', w: 6, h: 4, cx: 0, cy: 9 } },
      { score: 'C', shape: { kind: 'rect', w: 12, h: 24 } }])],
    ['a six-sided silhouette', mk([{ score: '1', shape: { kind: 'poly',
      pts: [[-5, -8], [5, -8], [7, 0], [5, 9], [-5, 9], [-7, 0]] } }])],
  ];

  for (const [label, target] of cases) {
    let worst = 0, n = 0, at = null;
    for (const z of target.zones) {
      for (let a = 0; a < 360; a += 7) {
        const th = a * Math.PI / 180, ux = Math.sin(th), uy = Math.cos(th);
        const edge = G.rayToEdge(z.shape, ux, uy);
        if (!edge) continue;
        for (const frac of [0.05, 0.3, 0.62, 0.95]) {
          const x = ux * edge * frac, y = uy * edge * frac;
          if (!G.pointInShape(z.shape, x, y)) continue;
          const s = G.xyToZone(target, x, y);
          const back = G.shotXY({ ring: s.ring, ringPos: s.ringPos,
                                 clockH: s.clockH, clockM: s.clockM }, target);
          const err = Math.hypot(back.x - x, back.y - y);
          n++;
          if (err > worst) { worst = err; at = [x, y, back.x, back.y]; }
        }
      }
    }
    /* 0.02" is the clock's own resolution -- a bearing is stored to the
     * nearest minute, which is 0.1 degrees, and at 13" that is about ten
     * thousandths. A RING target has exactly the same floor, so this is the
     * representation's limit and not the shape's. */
    ok(n > 100 && worst < 0.02,
       `${label}: ${n} points, worst error ${worst.toFixed(4)}"`
       + (worst >= 0.02 && at ? ` at (${at[0].toFixed(2)},${at[1].toFixed(2)}) -> (${at[2].toFixed(2)},${at[3].toFixed(2)})` : ''));
  }

  /* The specific number that started this, kept as its own assertion because a
   * summary statistic is easy to read past. */
  const t = mk([{ score: 'A', shape: { kind: 'rect', w: 6, h: 11 } },
                { score: 'C', shape: { kind: 'rect', w: 12, h: 24 } }]);
  const s = G.xyToZone(t, 3.1, 0);
  const back = G.shotXY({ ring: s.ring, ringPos: s.ringPos, clockH: s.clockH, clockM: s.clockM }, t);
  ok(Math.abs(back.x - 3.1) < 0.01,
     `a hole 3.1" right of centre comes back at ${back.x.toFixed(2)}", not 7.92"`);
}

/* ============================================ and it still scores the right zone */
/* The hit test was never the broken half -- worth pinning so the fix to the
 * other half cannot quietly change it. */
section('the zone a shot scores');
{
  const t = mk([{ score: 'A', shape: { kind: 'rect', w: 6, h: 11 } },
                { score: 'C', shape: { kind: 'rect', w: 12, h: 24 } }]);
  const cases = [[0, 0, 'A'], [2.9, 5.4, 'A'], [3.1, 0, 'C'], [0, 12.5, 'M'],
                 [5.9, 11.9, 'C'], [7, 0, 'M'], [-2.99, -5.49, 'A']];
  const wrong = cases.filter(([x, y, want]) => G.xyToZone(t, x, y).ring !== want);
  ok(wrong.length === 0,
     `every hole scores the zone it is in (${cases.length} points`
     + (wrong.length ? `, wrong: ${wrong.map(c => `(${c[0]},${c[1]})`).join(' ')}` : '') + ')');

  /* Nested zones resolve to the BETTER score, which is how paper scores: a
   * hole inside the A is also inside the C. */
  ok(G.xyToZone(t, 0, 0).ring === 'A', 'a hole inside both zones scores the better one');

  /* A miss is placed just outside the outermost zone IN ITS OWN DIRECTION.
   * Against the bounding circle it landed half a target away from the edge the
   * shot actually went past -- on a 12x24 zone, a miss 0.5" over the top of the
   * paper was drawn 3" above it. */
  const m = G.xyToZone(t, 0, 12.5);
  const mBack = G.shotXY({ ring: 'M', ringPos: m.ringPos, clockH: m.clockH, clockM: m.clockM }, t);
  ok(mBack.y > 12 && mBack.y < 15,
     `a miss over the top is drawn just over the top (${mBack.y.toFixed(2)}", the zone ends at 12")`);
}

/* ================================================== rings are left alone */
/* Every conventional target is rings, and none of this may touch them. */
section('ring targets are unchanged');
{
  const t = { rings: [{ score: 'X', diam: 3 }, { score: '10', diam: 7 }, { score: '9', diam: 13 }] };
  /* The 10 ring runs from the X's edge at 1.5" to its own at 3.5", so halfway
   * through it is 2.5" out -- measured, not asserted against a number typed
   * from memory, which is how the first version of this line was wrong. */
  const mid = G.shotXY({ ring: '10', ringPos: 0.5, clockH: 12, clockM: 0 }, t);
  ok(Math.abs(Math.hypot(mid.x, mid.y) - 2.5) < 1e-9,
     `a ring target still places a shot midway between its ring edges (${Math.hypot(mid.x, mid.y).toFixed(3)}")`);
  /* And at both ends of the ring, so the interpolation itself is pinned. */
  const inner = G.shotXY({ ring: '10', ringPos: 0, clockH: 3, clockM: 0 }, t);
  const outer = G.shotXY({ ring: '10', ringPos: 1, clockH: 3, clockM: 0 }, t);
  ok(Math.abs(inner.x - 1.5) < 1e-9 && Math.abs(outer.x - 3.5) < 1e-9,
     `...from the inner edge (${inner.x.toFixed(2)}") to the outer (${outer.x.toFixed(2)}")`);
  ok(Math.abs(G.ringMidR(t, 'M') - 13 / 2 * 1.15) < 1e-9,
     'and a miss on a ring target is still just outside the outermost ring');
}

/* ==================================== the NRA library, checked against itself */
/* Forty targets of transcribed numbers is forty chances to fat-finger a
 * diameter, and a wrong one is invisible: the target renders, the shot scores,
 * and every group measured against it is quietly wrong. These are the checks
 * that can be made without a rule book in hand.
 *
 * The reduction arithmetic is the strongest of them. NRA publishes the
 * relationships in words ("the MR-31 is a reduction of the MR-1 for 300 yards")
 * and no formula, but the published numbers do follow one:
 *
 *     D_reduced = ratio × (D_parent + 0.30) − 0.30      (.30-cal allowance)
 *
 * It is used here ONLY as a checksum on the typing, never as a source. Where it
 * disagrees by more than a hundredth, someone mistyped. */
section('the NRA target library');
{
  const lib = (() => {
    const i = src.indexOf('const BUILTIN_TARGETS = [');
    /* Through the loop that follows the array, not just the array: the two
     * zone targets get their synthetic rings there, and a library evaluated
     * without it is not the library the app runs. */
    const j = src.indexOf('const DEFAULT_PINNED', i);
    if (j < 0) throw new Error('test-geometry: DEFAULT_PINNED no longer follows the library');
    return new Function(grab('shapeBoundR') + grab('synthRingsFromZones')
      + src.slice(i, j) + '\nreturn BUILTIN_TARGETS;')();
  })();

  ok(lib.length >= 40, `${lib.length} targets in the library`);
  ok(new Set(lib.map(t => t.id)).size === lib.length, 'every target id is unique');
  ok(new Set(lib.map(t => t.name)).size === lib.length, 'and so is every name');

  /* The three that shipped before this library must keep their ids, or every
   * session already logged against them loses its paper. */
  for (const id of ['sr', 'sr3', 'mr1']) {
    ok(lib.some(t => t.id === id), `the original ${id} keeps its id, so existing sessions still resolve`);
  }

  const bad = [];
  for (const t of lib) {
    const rings = t.rings || [];
    if (!rings.length) { bad.push(`${t.name}: no rings`); continue; }
    for (let i = 1; i < rings.length; i++) {
      if (!(rings[i].diam > rings[i - 1].diam)) {
        bad.push(`${t.name}: ${rings[i].score} (${rings[i].diam}") is not outside ${rings[i-1].score} (${rings[i-1].diam}")`);
      }
    }
    if (rings.some(r => !(r.diam > 0))) bad.push(`${t.name}: a ring with no diameter`);
    if (!t.discipline) bad.push(`${t.name}: no discipline, so it cannot be grouped`);
  }
  ok(bad.length === 0, `every ring is larger than the one inside it${bad.length ? ' — ' + bad.slice(0, 3).join('; ') : ''}`);

  /* Scores run inward: X (or 10) is the smallest ring. A target whose scores
   * ascend outward would score every shot backwards. */
  const backwards = lib.filter(t => {
    const nums = (t.rings || []).map(r => (r.score === 'X' ? 11 : Number(r.score)))
      .filter(n => Number.isFinite(n));
    return nums.some((n, i) => i > 0 && n > nums[i - 1]);
  });
  ok(backwards.length === 0,
     `scores descend outward on every target${backwards.length ? ' — ' + backwards.map(t => t.name).join(', ') : ''}`);

  /* The reduction checksum. */
  const byId = Object.fromEntries(lib.map(t => [t.id, t]));
  const REDUCTIONS = [
    ['sr1',  'sr',   1 / 2],   ['sr42', 'sr3', 2 / 3],
    ['mr31', 'mr1',  1 / 6],   ['mr63', 'mr1', 1 / 2],
    ['mr52', 'mr1',  1 / 3],   ['sr21', 'sr3', 1 / 3],
  ];
  const off = [];
  for (const [kid, parent, ratio] of REDUCTIONS) {
    const c = byId[kid], p = byId[parent];
    if (!c || !p) { off.push(`${kid}: missing`); continue; }
    for (let i = 0; i < c.rings.length && i < p.rings.length; i++) {
      const want = ratio * (p.rings[i].diam + 0.30) - 0.30;
      const got = c.rings[i].diam;
      /* 0.02" of slack: NRA truncates rather than rounds, and the two
       * one-third reductions are uniformly 0.01 low against an exact ratio --
       * consistent with the ratio itself having been truncated to 0.3333
       * before the rings were computed. */
      if (Math.abs(got - want) > 0.02) {
        off.push(`${c.name} ${c.rings[i].score}: ${got}" vs ${want.toFixed(2)}" from ${p.name}`);
      }
    }
  }
  ok(off.length === 0,
     `all 6 published reductions reproduce their parent's rings${off.length ? ' — ' + off.slice(0, 4).join('; ') : ''}`);

  /* The two Long Range targets are zone targets because their outermost
   * scoring area is the square sheet, not a ring. A radius-only model scores a
   * corner hit as a miss where the rule book scores it a 6. */
  const lr = byId['lr'];
  ok(lr && lr.zones && lr.zones.some(z => z.shape.kind === 'rect'),
     'the LR carries a square outer zone, not a seventh circle');
  if (lr) {
    const corner = G.xyToZone(lr, 34, 34);      // inside the 72" sheet, far outside the 7 ring
    ok(corner.ring === '6',
       `a hit in the corner of the LR sheet scores a 6, not a miss (${corner.ring})`);
    const off72 = G.xyToZone(lr, 40, 40);       // outside the sheet
    ok(off72.ring === 'M', `and a hit off the paper is still a miss (${off72.ring})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
