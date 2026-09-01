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
/* Same idea, for a component whose parameters are destructured: `grab` starts
 * brace-matching at the first `{` it sees, which for `function C({ a, b })` is
 * the parameter list and not the body. Skip the parameter list first. */
const grabComponent = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`test-geometry: Zero.jsx has no function ${name} — renamed?`);
  let k = src.indexOf('(', i), par = 0;
  for (; k < src.length; k++) {
    if (src[k] === '(') par++;
    else if (src[k] === ')') { par--; if (!par) break; }
  }
  let depth = 0;
  for (let j = src.indexOf('{', k); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(i, j + 1); }
  }
  throw new Error(`test-geometry: could not read the body of ${name}`);
};
const NAMES = ['pointInShape', 'shapeBoundR', 'rayToEdge', 'zoneInnerR', 'zoneMidR',
               'xyToZone', 'synthRingsFromZones', 'ringMidR', 'clockToXY', 'shotXY'];
const G = new Function(NAMES.map(grab).join('\n') + `\nreturn {${NAMES.join(',')}};`)();
const mk = (zones) => ({ zones, rings: G.synthRingsFromZones(zones) });

/* The two shipped zone targets, read out of the library rather than retyped,
 * so the suite exercises the paper people actually shoot. */
const BUILTINS = (() => {
  const i = src.indexOf('const BUILTIN_TARGETS = [');
  const j = src.indexOf('const DEFAULT_PINNED', i);
  if (i < 0 || j < 0) throw new Error('test-geometry: BUILTIN_TARGETS no longer reads the same way');
  const lib = new Function(grab('shapeBoundR') + grab('synthRingsFromZones')
    + src.slice(i, j) + '\nreturn BUILTIN_TARGETS;')();
  return Object.fromEntries(lib.map(t => [t.id, t]));
})();

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
    /* The two that ship. The suite used to touch them in two hit tests only,
     * so the one target in the app with a rectangular outer zone was the one
     * target the round trip never ran on. */
    ['the LR, as shipped', BUILTINS.lr],
    ['the LR F-Class, as shipped', BUILTINS.lrfc],
  ];

  /* ── the tolerance, and where it comes from ────────────────────────────
   * A clock is stored to the nearest MINUTE. A minute is 360/(12x60) = 0.5
   * degrees -- not 0.1, which is what the comment here used to say -- so the
   * stored bearing is rounded by at most HALF a minute: 0.25 deg, 0.0043633
   * radians. That rounding is the only lossy step in the round trip. The
   * radius is stored as a fraction of a span both directions recompute
   * exactly, so given the same bearing the inverse is exact to floating point;
   * everything left over is "the same shot, fired a quarter of a degree away".
   *
   * On a circle that is a pure arc, r x dTheta: 0.222" at the 50.9" corner
   * radius of the LR's 72" sheet. On a RECTANGLE it is bigger, because the
   * fraction is divided by edge(true bearing) and multiplied by
   * edge(rounded bearing), and a rectangle's edge distance moves fast near the
   * corner direction -- d(edge)/dTheta = r x tan(angle off the normal), which
   * on a square at 45 deg equals r itself. So the radial term matches the
   * tangential one and the total is r x dTheta x sqrt(2) = 0.314" worst case
   * on the LR: about 45% more than the arc alone.
   *
   * That amplification is accepted rather than designed away. Widening the
   * stored bearing (seconds of clock, or a raw angle) would migrate a field
   * that every ring target and every already-written row shares, to buy back
   * a tenth of an inch that only appears 50" from centre on the largest sheet
   * in the library, where it is 0.2% of the radius and well inside one bullet
   * hole. Tap entry -- the only way to enter a zone shot -- stores exact `xy`
   * anyway, so this path is reached only by imported and synced rows.
   *
   * The assertion is not a number picked to pass. Each sample is checked
   * against the bearing-rounding envelope computed FROM THAT SAMPLE'S OWN
   * GEOMETRY, and separately against exactness at the unrounded bearing, so a
   * radial bug cannot hide inside the angular allowance. */
  const DTH = 0.25 * Math.PI / 180;            // half a minute of clock, radians
  const reconAt = (target, ring, pos, th) => {
    const ux = Math.sin(th), uy = Math.cos(th);
    const r = G.zoneMidR(target, ring, pos, ux, uy, 2);
    return { x: ux * r, y: uy * r };
  };
  // How far the reconstruction can move for a bearing rounded by up to DTH.
  const bearingEnvelope = (target, ring, pos, th) => {
    const base = reconAt(target, ring, pos, th);
    let b = 0;
    for (let k = -20; k <= 20; k++) {
      const q = reconAt(target, ring, pos, th + (k / 20) * DTH);
      b = Math.max(b, Math.hypot(q.x - base.x, q.y - base.y));
    }
    return b;
  };

  const sweep = (target, stepDeg) => {
    let worst = 0, worstBound = 0, n = 0, at = null, exact = 0, exactAt = null, over = 0;
    for (const z of target.zones) {
      /* Deliberately not a multiple of 0.5 deg. At 7 deg -- 14 whole minutes
       * -- every sampled bearing survived the rounding untouched and the
       * measured error was identically zero, so the tolerance below and the
       * paragraph justifying it were both dead code. */
      for (let a = 0; a < 360; a += stepDeg) {
        const th = a * Math.PI / 180, ux = Math.sin(th), uy = Math.cos(th);
        const edge = G.rayToEdge(z.shape, ux, uy);
        if (!edge) continue;
        for (const frac of [0.05, 0.3, 0.62, 0.95]) {
          const x = ux * edge * frac, y = uy * edge * frac;
          if (!G.pointInShape(z.shape, x, y)) continue;
          const s = G.xyToZone(target, x, y);
          const back = G.shotXY({ ring: s.ring, ringPos: s.ringPos, rpv: s.rpv,
                                 clockH: s.clockH, clockM: s.clockM }, target);
          const err = Math.hypot(back.x - x, back.y - y);
          // The same reconstruction at the shot's TRUE bearing: this is the
          // radius arithmetic on its own, with the clock taken out of it.
          const trueTh = Math.atan2(x, y);
          const idealPt = reconAt(target, s.ring, s.ringPos, trueTh);
          const ideal = Math.hypot(idealPt.x - x, idealPt.y - y);
          const bound = bearingEnvelope(target, s.ring, s.ringPos, trueTh);
          n++;
          if (err > bound + 1e-9) over++;
          if (bound > worstBound) worstBound = bound;
          if (ideal > exact) { exact = ideal; exactAt = [x, y]; }
          if (err > worst) { worst = err; at = [x, y, back.x, back.y]; }
        }
      }
    }
    return { worst, worstBound, n, at, exact, exactAt, over };
  };

  for (const [label, target] of cases) {
    const r = sweep(target, 7.3);
    ok(r.n > 100 && r.exact < 1e-9,
       `${label}: ${r.n} points, the radius inverts exactly (${r.exact.toExponential(1)}")`
       + (r.exact >= 1e-9 && r.exactAt ? ` — worst at (${r.exactAt[0].toFixed(2)},${r.exactAt[1].toFixed(2)})` : ''));
    ok(r.over === 0,
       `${label}: every point lands inside its own bearing-rounding envelope`
       + ` (worst error ${r.worst.toFixed(4)}", envelope ${r.worstBound.toFixed(4)}"`
       + (r.over ? `, ${r.over} outside` : '') + ')');
  }

  /* The headline number, stated in inches rather than left as a per-sample
   * comparison, because "within its own envelope" is satisfiable by an
   * envelope that has quietly grown. 0.25 deg x 50.911" x sqrt(2) = 0.3141"
   * is the arithmetic above; nothing on the shipped paper may exceed it. */
  const lrDense = sweep(BUILTINS.lr, 0.37);
  ok(lrDense.worst < 0.3142,
     `a dense sweep of the shipped LR (${lrDense.n} points) stays under the`
     + ` 0.3141" half-minute bound: worst ${lrDense.worst.toFixed(4)}"`
     + (lrDense.at ? ` at (${lrDense.at[0].toFixed(2)},${lrDense.at[1].toFixed(2)})` : ''));

  /* The specific number that started this, kept as its own assertion because a
   * summary statistic is easy to read past. */
  const t = mk([{ score: 'A', shape: { kind: 'rect', w: 6, h: 11 } },
                { score: 'C', shape: { kind: 'rect', w: 12, h: 24 } }]);
  const s = G.xyToZone(t, 3.1, 0);
  const back = G.shotXY({ ring: s.ring, ringPos: s.ringPos, rpv: s.rpv, clockH: s.clockH, clockM: s.clockM }, t);
  ok(Math.abs(back.x - 3.1) < 0.01,
     `a hole 3.1" right of centre comes back at ${back.x.toFixed(2)}", not 7.92"`);
}

/* ============================== a stored fraction stays in the zone it scored */
/* The round trip above only ever feeds back values this code wrote. Every
 * OTHER value the field can hold -- a default, a row a human edited, a shot
 * entered before tap mode, anything synced -- goes through the same inverse,
 * and it has to mean the same thing there: `ringPos` is how far through THIS
 * ZONE, 0 at the boundary with the better score inside it and 1 at its own
 * edge, exactly as on a ring target. It did not. It was a fraction of the
 * distance to the edge measured from the CENTRE, so a stored 6 at 0.5 came
 * back 18" out on the LR -- inside the 8 ring -- and a stored anything at 0
 * came back dead centre and scored an X. */
section('a fraction through a zone stays inside that zone');
{
  const lr = BUILTINS.lr;
  const mid = G.shotXY({ ring: '6', ringPos: 0.5, clockH: 12, clockM: 0, rpv: 2 }, lr);
  ok(G.xyToZone(lr, mid.x, mid.y).ring === '6',
     `a 6 stored halfway through the zone comes back a 6 at ${mid.y.toFixed(2)}", not an 8 at 18.00"`);

  const zero = G.shotXY({ ring: '6', ringPos: 0, clockH: 12, clockM: 0, rpv: 2 }, lr);
  ok(Math.abs(zero.y - 30) < 1e-9,
     `and at 0 it sits on the 7/6 boundary (${zero.y.toFixed(2)}"), not at dead centre scoring an X`);

  const one = G.shotXY({ ring: '6', ringPos: 1, clockH: 12, clockM: 0, rpv: 2 }, lr);
  ok(Math.abs(one.y - 36) < 1e-9, `...and at 1 on the edge of the 72" sheet (${one.y.toFixed(2)}")`);

  /* The sweep the review ran: every fraction, at four bearings, for every zone
   * on both shipped targets. 63 of 84 samples for the LR's 6 used to land in
   * some other zone. */
  let strayed = 0, total = 0, first = null;
  for (const target of [BUILTINS.lr, BUILTINS.lrfc]) {
    for (const z of target.zones) {
      for (const [h, m] of [[12, 0], [3, 0], [1, 30], [7, 45]]) {
        for (let p = 0; p <= 1.0001; p += 0.05) {
          const pt = G.shotXY({ ring: z.score, ringPos: Math.min(1, p), clockH: h, clockM: m, rpv: 2 }, target);
          total++;
          const got = G.xyToZone(target, pt.x, pt.y).ring;
          /* The endpoints sit exactly ON a boundary, where the hit test is
           * entitled to award the better score -- that is the rule book. */
          const onEdge = p < 1e-9 || p > 1 - 1e-9;
          if (got !== z.score && !onEdge) { strayed++; if (!first) first = `${z.score}@${p.toFixed(2)}->${got}`; }
        }
      }
    }
  }
  ok(strayed === 0,
     `${total} stored fractions across both shipped targets, none reconstructs into a different zone`
     + (strayed ? ` — ${strayed} did, e.g. ${first}` : ''));
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

/* ============================ a row from an older build still reads correctly */
/* `ringPos` on a zone target has had two meanings: a fraction of the zone's
 * BOUNDING CIRCLE, and the fraction-through-the-zone above. Nothing in the row
 * itself distinguished them, so a record written by an older build -- or
 * pulled from the server, where rows outlive builds -- was read with the wrong
 * denominator and moved. On the LR a 6 fired at 34" came back at 24.04", ten
 * inches in, and scored a 7.
 *
 * New rows are stamped `rpv: 2`. An unstamped row is read the old way, which
 * is the only reading that puts it back where it was fired. The stamp is
 * cheap, it is local to the row, and it needs no migration pass over data the
 * app may never see again -- rows on a phone that syncs next month are read
 * correctly the moment they arrive. */
section('a legacy zone row is read with the denominator it was written with');
{
  const lr = BUILTINS.lr;
  const legacyPos = 34 / G.shapeBoundR({ kind: 'rect', w: 72, h: 72 });  // what the old build stored
  const legacy = G.shotXY({ ring: '6', ringPos: legacyPos, clockH: 12, clockM: 0 }, lr);
  ok(Math.abs(legacy.y - 34) < 1e-9,
     `an unstamped 6 fired at 34" is drawn at ${legacy.y.toFixed(2)}", not 24.04"`);
  ok(G.xyToZone(lr, legacy.x, legacy.y).ring === '6',
     'and still scores the 6 it was recorded as, not a 7');

  /* Four of eight sampled legacy rows changed zone before this. */
  let moved = 0, n = 0;
  for (const z of lr.zones) {
    const bR = G.shapeBoundR(z.shape);
    for (const [h, m] of [[12, 0], [4, 30]]) {
      for (const frac of [0.35, 0.6, 0.85, 0.98]) {
        const u = G.clockToXY(h, m, 1);
        // Only fractions that were actually reachable: the hole has to have
        // been inside this zone when the old build measured it.
        const p = { x: u.x * bR * frac, y: u.y * bR * frac };
        if (!G.pointInShape(z.shape, p.x, p.y)) continue;
        if (G.xyToZone(lr, p.x, p.y).ring !== z.score) continue;
        const back = G.shotXY({ ring: z.score, ringPos: frac, clockH: h, clockM: m }, lr);
        n++;
        if (Math.hypot(back.x - p.x, back.y - p.y) > 0.32) moved++;
      }
    }
  }
  ok(n > 4 && moved === 0,
     `${n} rows in the old format all land where the old build put them (${moved} moved)`);

  /* And the stamp is actually written, or none of the above matters. */
  const fresh = G.xyToZone(lr, 0, 34);
  ok(fresh.rpv === 2, `a row written now carries its format marker (rpv: ${fresh.rpv})`);
  ok(G.xyToZone(lr, 40, 40).rpv === 2, '...including a miss');
}

/* ===================================== a ray that misses a zone says so */
/* The slab code took the nearest far plane over whichever axes had a positive
 * crossing. That is the exit GIVEN the ray hits the box; with no entry/exit
 * ordering test, a ray that misses entirely still had positive crossings of
 * the slabs it never entered together, and returned a confident number.
 * Non-offset rectangles always contain the origin so they were safe -- which
 * made this exactly the offset-zone case the feature was added for. */
section('a ray that misses a rectangle returns nothing');
{
  const box = { kind: 'rect', w: 6, h: 4, cx: 0, cy: 9 };  // a head box 9" up
  const at = (h, m) => { const u = G.clockToXY(h, m, 1); return G.rayToEdge(box, u.x, u.y); };
  ok(!at(3, 0), `3 o'clock misses the head box entirely (${at(3, 0).toFixed(2)}", was 3.00")`);
  ok(!at(4, 30), `4:30 misses it too (${at(4, 30).toFixed(2)}", was 4.24")`);
  ok(!at(6, 0), `6 o'clock, with the box behind the origin, misses (${at(6, 0).toFixed(2)}")`);
  ok(Math.abs(at(12, 0) - 11) < 1e-9, `and 12 o'clock, which does hit it, exits at ${at(12, 0).toFixed(2)}"`);
  // 12:10 is 5 deg off vertical: still leaves through the top, 11"/cos5.
  ok(Math.abs(at(12, 10) - 11 / Math.cos(5 * Math.PI / 180)) < 1e-9,
     `...as does 12:10, out through the top edge at ${at(12, 10).toFixed(3)}"`);
  // 12:40 is 20 deg off: far enough over to leave through the 3" side.
  ok(Math.abs(at(12, 40) - 3 / Math.sin(20 * Math.PI / 180)) < 1e-9,
     `...and 12:40, out through the side at ${at(12, 40).toFixed(3)}"`);

  /* The corner case the review confirmed is right, pinned so the rewrite
   * cannot have broken it. */
  const sq = G.rayToEdge({ kind: 'rect', w: 72, h: 72 }, Math.SQRT1_2, Math.SQRT1_2);
  ok(Math.abs(sq - 50.911688) < 1e-5,
     `a ray through the corner of a 72" square still exits at ${sq.toFixed(6)}"`);
}

/* ============================ the inverse has the forward path's fallback */
/* xyToZone guards with `rayToEdge(...) || shapeBoundR(...) || 1`. zoneMidR had
 * no guard, so a bearing that misses the zone multiplied zero by the fraction
 * and put the shot at dead centre -- a clean X, out of a record that says
 * otherwise, with nothing anywhere to say it had happened. */
section('a zone the bearing misses falls back instead of collapsing to centre');
{
  const head = mk([{ score: 'A', shape: { kind: 'rect', w: 6, h: 4, cx: 0, cy: 9 } },
                   { score: 'C', shape: { kind: 'rect', w: 12, h: 24 } }]);
  const p = G.shotXY({ ring: 'A', ringPos: 0.9, clockH: 6, clockM: 0, rpv: 2 }, head);
  ok(Math.hypot(p.x, p.y) > 1,
     `an A stored at 6 o'clock, where the head box is not, does not land at dead centre`
     + ` (${Math.hypot(p.x, p.y).toFixed(2)}", was 0.00" and scored a C)`);

  /* A bow-tie: self-intersecting, so pointInShape accepts points the ray
   * casting finds no crossing for. Not a shape the editor should make, but it
   * is a shape it can save. */
  const bow = mk([{ score: '1', shape: { kind: 'poly',
    pts: [[-8, -8], [8, 8], [-8, 8], [8, -8]] } }]);
  /* 4:30 is a bearing where the outline's own ray casting finds no crossing
   * at all, while the hit test still calls points along it inside. */
  const q = G.shotXY({ ring: '1', ringPos: 0.7, clockH: 4, clockM: 30, rpv: 2 }, bow);
  ok(Number.isFinite(q.x) && Number.isFinite(q.y) && Math.hypot(q.x, q.y) > 1,
     `a self-intersecting outline still puts a 0.7 somewhere other than the X ring`
     + ` (${Math.hypot(q.x, q.y).toFixed(2)}")`);
}

/* ============================================ an offset polygon has a size */
section('shapeBoundR measures an offset polygon');
{
  const asRect = G.shapeBoundR({ kind: 'rect', w: 6, h: 6, cx: 0, cy: 20 });
  const asPoly = G.shapeBoundR({ kind: 'poly', cx: 0, cy: 20,
    pts: [[-3, -3], [3, -3], [3, 3], [-3, 3]] });
  ok(Math.abs(asRect - asPoly) < 1e-9,
     `the same 6" box 20" above centre measures the same either way`
     + ` (rect ${asRect.toFixed(2)}", poly ${asPoly.toFixed(2)}", was 4.24")`);
  /* It feeds the synthetic rings, which is where a wrong one does damage. */
  const rings = G.synthRingsFromZones([
    { score: 'A', shape: { kind: 'poly', cx: 0, cy: 20, pts: [[-3, -3], [3, -3], [3, 3], [-3, 3]] } },
    { score: 'C', shape: { kind: 'circle', d: 30 } }]);
  ok(rings[0].score === 'C' && rings[1].score === 'A',
     'and an offset poly zone gets a synthetic ring outside the 30" circle it sits beyond, not inside it');
}

/* ========================================= a record with no clock is not NaN */
section('a shot record with no clock');
{
  const t = { rings: [{ score: 'X', diam: 3 }, { score: '10', diam: 7 }] };
  const p = G.shotXY({ ring: '10', ringPos: 0.5 }, t);      // clockH undefined
  ok(Number.isFinite(p.x) && Number.isFinite(p.y),
     `a ring shot with no clock has coordinates, not NaN (${p.x.toFixed(2)},${p.y.toFixed(2)})`);
  ok(Math.abs(p.x) < 1e-9 && Math.abs(p.y - 2.5) < 1e-9,
     '...and reads as twelve o\'clock, which is where the entry screen starts');

  const z = G.shotXY({ ring: '6', ringPos: 0.5, rpv: 2 }, BUILTINS.lr);
  ok(Number.isFinite(z.x) && Number.isFinite(z.y),
     `and so does a zone shot with no clock (${z.x.toFixed(2)},${z.y.toFixed(2)})`);

  /* The asymmetry that made this nasty: under NaN the circle branch returned
   * NaN and the rect branch returned 0, so one corrupt record produced two
   * different kinds of wrong on the same target. */
  ok(G.rayToEdge({ kind: 'circle', d: 10 }, NaN, NaN) === 0
     && G.rayToEdge({ kind: 'rect', w: 10, h: 10 }, NaN, NaN) === 0
     && G.rayToEdge({ kind: 'poly', pts: [[-5, -5], [5, -5], [0, 5]] }, NaN, NaN) === 0,
     'a bearing that is not a number is rejected the same way by all three shapes');
}

/* ================================= the two call sites that are not arithmetic */
/* ShotInspector and ShotEntry are React components; they are asserted through
 * the source, because building them needs a DOM and the thing being asserted
 * is which function they call, not what it returns. The extraction fails loudly
 * if either is renamed. */
section('the components that read and write these numbers');
{
  const inspector = grabComponent('ShotInspector');
  ok(/const impactXY = shotXY\(shot, target\)/.test(inspector),
     'ShotInspector asks shotXY where the shot landed');
  ok(!/ringMidR\s*\(/.test(inspector),
     'and no longer reimplements the fallback against the synthetic bounding circle');

  /* What that fallback did: it fed a fraction measured against the zone's edge
   * into ringMidR's bounding-circle interpolation. Reproduced here so the
   * assertion above has a number attached to it. */
  const lr = BUILTINS.lr;
  const s = G.xyToZone(lr, 0, 34);
  const oldWay = G.ringMidR(lr, s.ring, s.ringPos);
  const drawn = G.shotXY({ ring: s.ring, ringPos: s.ringPos, rpv: s.rpv,
                           clockH: s.clockH, clockM: s.clockM }, lr);
  const nowIs = Math.hypot(drawn.x, drawn.y);
  ok(Math.abs(nowIs - 34) < 0.01 && oldWay > 36,
     `a 6 fired at 34" on the LR is drawn at ${nowIs.toFixed(2)}", not ${oldWay.toFixed(2)}" — which is past the 36" edge of the paper`);

  const entry = grabComponent('ShotEntry');
  ok(/const needsTap = !!\(target\.zones && target\.zones\.length\)/.test(entry)
     && /const canLog = /.test(entry),
     'ShotEntry knows a zone target cannot be logged without a tap');
  ok(/function doSave\(andNext\) \{\s*\n?\s*if \(!canLog\) return;/.test(entry),
     'doSave refuses to invent one');
  ok((entry.match(/disabled=\{!canLog\}/g) || []).length === 2,
     'and both Log buttons are dead until the shot is placed');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
