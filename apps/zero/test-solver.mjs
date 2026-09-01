/* The ballistics solver.
 *
 * Two things are being tested and they are different in kind. The physics is
 * checked against a published trajectory, because it either reproduces a known
 * load or it does not. The TRUING is checked by giving the solver data from a
 * rifle it does not know — a synthetic rifle whose real velocity and drag are
 * chosen in advance — and asking whether it recovers them. That second test is
 * the one that matters: a solver that integrates beautifully and trues badly
 * produces confident numbers that are wrong, which is worse than no solver.
 */
import * as S from './src/solver.js';

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const section = (s) => console.log('\n' + s);

/* ═══════════════════════════════ the physics, against a published trajectory */
/* Federal Gold Medal 175gr Sierra MatchKing, G7 BC 0.243, 2600 fps, 1.5" sight
 * height, 100 yd zero, standard atmosphere. Elevation come-ups and retained
 * velocities from longrangescience.com's published table for that exact load.
 *
 * This is the check that stops a change to the drag curve or the integrator
 * silently moving every trajectory. Truing would absorb a systematic shift and
 * report it as a strange muzzle velocity, so without this the error would
 * surface as the shooter doubting their chronograph. */
section('the trajectory, against a published table');
{
  const PUB = {
    200: [1.98, 2251], 300: [4.82, 2087], 400: [8.16, 1928], 500: [11.95, 1777],
    600: [16.24, 1632], 700: [21.09, 1493], 800: [26.60, 1360], 900: [32.89, 1232],
    1000: [40.11, 1121],
  };
  const t = S.integrate({ mv: 2600, bc: 0.243, sightHeightIn: 1.5, zeroYd: 100,
                          densityRatio: 1, tempF: 59, maxYd: 1050 });
  let worstMoa = 0, worstV = 0, sse = 0, n = 0, at = '';
  for (const yd of Object.keys(PUB).map(Number)) {
    const r = t[yd];
    if (!r) { ok(false, `no row at ${yd} yd`); continue; }
    const moa = S.dropToMoa(r.dropFt, yd);
    const dm = Math.abs(moa - PUB[yd][0]);
    if (dm > worstMoa) { worstMoa = dm; at = `${yd} yd: ${moa.toFixed(2)} vs ${PUB[yd][0]}`; }
    worstV = Math.max(worstV, Math.abs(r.v - PUB[yd][1]));
    sse += dm * dm; n++;
  }
  ok(worstMoa < 0.30,
     `come-ups match the published table to ${worstMoa.toFixed(2)} MOA over 200–1000 yd (worst ${at})`);
  ok(Math.sqrt(sse / n) < 0.20, `RMS ${Math.sqrt(sse / n).toFixed(3)} MOA across nine distances`);
  ok(worstV < 20, `retained velocity within ${worstV.toFixed(0)} fps`);

  /* The zero is where it was asked for -- if the launch-angle search is wrong
   * every number above is wrong by the same amount and the comparison would
   * still pass. */
  ok(Math.abs(S.dropToMoa(t[100].dropFt, 100)) < 0.02,
     'and the rifle is actually zeroed at the distance it was zeroed at');

  /* Transonic where the load really goes transonic. */
  const last = [...Array(1050).keys()].filter(y => t[y] && t[y].v > 1116).pop();
  ok(last > 930 && last < 1010, `supersonic to about ${last} yd, as this load is`);
}

/* ══════════════════════════════════════════ atmosphere moves it the right way */
section('atmosphere');
{
  ok(Math.abs(S.airDensityRatio({ tempF: 59, pressureInHg: 29.92, humidity: 0 }) - 1) < 0.001,
     'standard conditions are the standard density');
  ok(S.airDensityRatio({ tempF: 20, pressureInHg: 29.92 }) > 1,
     'cold air is denser');
  ok(S.airDensityRatio({ tempF: 95, pressureInHg: 29.92 }) < 1,
     'hot air is thinner');
  ok(S.airDensityRatio({ tempF: 59, pressureInHg: 24.9 }) < 0.85,
     'and five thousand feet of altitude is a lot thinner');

  const hot = S.integrate({ mv: 2600, bc: 0.243, sightHeightIn: 1.5, zeroYd: 100,
                            densityRatio: S.airDensityRatio({ tempF: 95 }), tempF: 95, maxYd: 1010 });
  const cold = S.integrate({ mv: 2600, bc: 0.243, sightHeightIn: 1.5, zeroYd: 100,
                             densityRatio: S.airDensityRatio({ tempF: 20 }), tempF: 20, maxYd: 1010 });
  const hotMoa = S.dropToMoa(hot[1000].dropFt, 1000);
  const coldMoa = S.dropToMoa(cold[1000].dropFt, 1000);
  ok(coldMoa > hotMoa + 1,
     `thin summer air needs less elevation than dense winter air at 1000 (${hotMoa.toFixed(1)} vs ${coldMoa.toFixed(1)} MOA)`);
}

/* ═══════════════════════════════════════ truing: does it find a rifle it cannot see */
/* The real test. A synthetic rifle is given a true muzzle velocity and BC that
 * differ from what is "on the box", its confirmed zeros are generated from
 * those true values, and the solver is handed the zeros and the box numbers.
 * If truing works it recovers the rifle. If it does not, it produces a curve
 * that fits three points and diverges everywhere else — which is precisely the
 * failure a shooter cannot detect until they are on the line at 1000. */
section('truing, against a rifle the solver cannot see');
{
  const TRUE_MV = 2712, TRUE_BC = 0.259;      // what the rifle actually does
  const BOX_MV = 2800, BOX_BC = 0.243;        // what the box says
  const base = { sightHeightIn: 1.9, zeroYd: 100, densityRatio: 1, tempF: 59 };

  const truth = S.integrate({ ...base, mv: TRUE_MV, bc: TRUE_BC, maxYd: 1100 });
  const dopeAt = (yd) => ({ yd, moa: S.dropToMoa(truth[yd].dropFt, yd) });

  /* Three anchors, which is what a shooter has after a season: 200, 300, 600. */
  const anchors = [dopeAt(200), dopeAt(300), dopeAt(600)];
  const trued = S.trueToDope(anchors, { ...base, mv: BOX_MV, bc: BOX_BC });

  ok(trued && trued.trued, 'three anchors over 400 yards is enough to true');
  ok(trued.rmsMoa < 0.08,
     `the trued curve passes through the confirmed zeros (${trued.rmsMoa.toFixed(3)} MOA RMS)`);
  ok(Math.abs(trued.mv - TRUE_MV) < 60,
     `it recovers a muzzle velocity near the truth (${trued.mv.toFixed(0)} vs ${TRUE_MV} fps, box said ${BOX_MV})`);

  /* What it is FOR: the distances the shooter has never fired. */
  for (const yd of [500, 800, 1000]) {
    const p = S.predict(trued, yd);
    const actual = S.dropToMoa(truth[yd].dropFt, yd);
    ok(p && Math.abs(p.moa - actual) < 0.9,
       `${yd} yd predicted ${p.moa.toFixed(2)} MOA against a true ${actual.toFixed(2)} — off by ${Math.abs(p.moa - actual).toFixed(2)}`);
  }

  /* And the untrued box numbers, to show what truing is worth. A solver whose
   * output is no better than the box is a solver not worth shipping. */
  const raw = S.trueToDope([anchors[0]], { ...base, mv: BOX_MV, bc: BOX_BC });
  const rawAt1000 = S.predict(raw, 1000);
  const truedAt1000 = S.predict(trued, 1000);
  const actual1000 = S.dropToMoa(truth[1000].dropFt, 1000);
  ok(Math.abs(truedAt1000.moa - actual1000) < Math.abs(rawAt1000.moa - actual1000) / 3,
     `truing beats the box at 1000 by more than 3× (${Math.abs(truedAt1000.moa - actual1000).toFixed(2)} vs ${Math.abs(rawAt1000.moa - actual1000).toFixed(2)} MOA)`);
}

/* ══════════════════════════════════ it refuses to true what it cannot separate */
/* Velocity moves the near end of the curve and drag moves the far end. One
 * anchor constrains neither: raise the velocity and lower the BC and the curve
 * passes through the same single point. Reporting a trued solution from one
 * zero would be a fabrication, and it is the fabrication a shooter is least
 * equipped to catch. */
section('what it refuses to do');
{
  const base = { sightHeightIn: 1.9, zeroYd: 100, densityRatio: 1, tempF: 59, mv: 2700, bc: 0.25 };
  const one = S.trueToDope([{ yd: 300, moa: 5.0 }], base);
  ok(one && !one.trued, 'one confirmed zero is not trued');
  ok(/single point|cannot be separated/.test(one.reason || ''),
     `...and says why (${one.reason})`);

  const close = S.trueToDope([{ yd: 200, moa: 2.1 }, { yd: 250, moa: 3.2 }], base);
  ok(close && !close.trued,
     'two zeros fifty yards apart is not trued either — that cannot separate velocity from drag');

  const none = S.trueToDope([], base);
  ok(none === null, 'and no zeros at all returns nothing rather than a guess');
}

/* ═════════════════════════════════════ the interval says what it should say */
section('the confidence interval');
{
  const base = { sightHeightIn: 1.9, zeroYd: 100, densityRatio: 1, tempF: 59, mv: 2700, bc: 0.25 };
  const truth = S.integrate({ ...base, maxYd: 1100 });
  const at = (yd) => ({ yd, moa: S.dropToMoa(truth[yd].dropFt, yd) });
  const trued = S.trueToDope([at(200), at(300), at(600)], base);

  const inside = S.predict(trued, 500);
  const edge = S.predict(trued, 600);
  const far = S.predict(trued, 1000);

  ok(inside.inside && !far.inside,
     '500 is interpolation between the anchors; 1000 is extrapolation past them');
  ok(far.ci > inside.ci * 2,
     `and the interval widens for it (±${inside.ci.toFixed(2)} at 500, ±${far.ci.toFixed(2)} at 1000)`);
  ok(edge.ci < far.ci, 'growing with the distance past the furthest anchor, not in one step');
  ok(inside.ci >= 0.15, 'with a floor, because a confirmed zero is read off paper by a person');

  /* The prediction has to be honest about the transonic region, where a G7
   * curve is least reliable and where a real bullet can go unstable. */
  ok(far.transonic === true, 'and it says when a prediction is in the transonic region');
  const near = S.predict(trued, 300);
  ok(near.transonic === false, '...and when it is not');
}

/* ══════════════════════════ position offsets, learned rather than assumed */
/* A confirmed zero is per position because it is not the same zero: the cant
 * differs, the cheek weld moves, and it shows up as a couple of minutes. Every
 * shooter's are their own, so they are measured from their own DOPE. */
section('position offsets');
{
  const cells = [
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.0, wind: 0.0 },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Standing', elev: 2.5, wind: -0.75 },
    { rifleId: 'r1', location: 'home', yards: 300, position: 'Prone',    elev: 4.5, wind: 0.25 },
    { rifleId: 'r1', location: 'home', yards: 300, position: 'Standing', elev: 5.1, wind: -0.5 },
    { rifleId: 'r1', location: 'home', yards: 600, position: 'Prone',    elev: 14.0, wind: 0.0 },
  ];
  const offs = S.positionOffsets(cells);
  const pToS = offs.find(o => o.from === 'Prone' && o.to === 'Standing');
  ok(!!pToS, 'an offset is found between two positions shot at the same distance and place');
  ok(pToS.n === 2, `from both distances that have the pair (${pToS.n} observations)`);
  ok(Math.abs(pToS.elevMoa - 0.55) < 0.01,
     `averaging the elevation difference (${pToS.elevMoa.toFixed(2)} MOA up, from +0.5 and +0.6)`);
  /* 0.0 → −0.75 at 200, and +0.25 → −0.5 at 300. Both are −0.75, so the mean
   * is −0.75 — the value is worked from the fixture rather than typed from
   * memory, which is how the first version of this line was wrong. */
  ok(Math.abs(pToS.windMoa - (-0.75)) < 0.01,
     `and the windage, which is where a cant difference actually shows (${pToS.windMoa.toFixed(3)} MOA left)`);
  ok(pToS.elevSd !== null && pToS.elevSd < 0.1,
     'with the spread across observations, so one outlier is visible');

  /* The 600 yd prone cell has no partner, and must not invent one. */
  ok(!offs.some(o => o.n > 2), 'a position with no partner at a distance contributes nothing');

  const single = S.positionOffsets([cells[0], cells[1]]);
  ok(single[0].n === 1 && single[0].elevSd === null,
     'a single observation reports no spread rather than a spread of zero');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
