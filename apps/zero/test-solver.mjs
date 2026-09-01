/* The ballistics solver.
 *
 * Two things are being tested and they are different in kind. The physics is
 * checked for SHAPE — that a drag model with the right form, trued to a
 * published trajectory, recovers that trajectory's own stated BC — because
 * that is what someone else's table can actually evidence. The TRUING is
 * checked by giving the solver data from a rifle it does not know — a
 * synthetic rifle whose real velocity and drag are chosen in advance — and
 * asking whether it recovers them. That second test is the one that matters: a
 * solver that integrates beautifully and trues badly produces confident
 * numbers that are wrong, which is worse than no solver.
 *
 * A third kind of test runs throughout: the REFUSALS. Every case below where
 * the solver is expected to decline was a case where it previously returned a
 * confident, plausible, wrong number — a fit pinned against the edge of its
 * own search space, a mistyped zero fitted silently, a table of nonsense from
 * an out-of-range zero distance. Those are the failures a shooter cannot
 * detect until they are on the line, so each one has its own assertion here.
 */
import * as S from './src/solver.js';

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const section = (s) => console.log('\n' + s);
/* Assertion MESSAGES must never throw: a message that crashes turns a failing
 * assertion into an aborted run, which hides every assertion after it — and
 * these are read most often when something has just been broken. */
const num = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : String(v);

/* ═══════════════════════════════════ the drag constant, derived not fitted */
/* K_DRAG shipped for a while as 2.010e-4, which is 3.6% below the analytic
 * value, because it had been FITTED to the published table used below rather
 * than derived. The tell was that fitting it to the same reference against
 * drop gave 2.010e-4 and against retained velocity gave 2.027e-4 — 0.85%
 * apart, which one well-posed physical constant cannot be. This asserts the
 * derivation instead, so that nobody can quietly re-absorb a table's error
 * into a constant named as if it were physics. */
section('the drag constant');
{
  const RHO_STD_SLUG_FT3 = 0.00237689;   // standard sea-level air density
  const PI_OVER_8 = Math.PI / 8;         // from a = ρv²Cd·πd²/(8m)
  const BC_LB_IN2_TO_SLUG_FT2 = 32.174 / 144;  // lb→slug, in²→ft², from BC = m/(d²i)
  const analytic = RHO_STD_SLUG_FT3 * PI_OVER_8 * BC_LB_IN2_TO_SLUG_FT2;
  ok(Math.abs(S.K_DRAG - analytic) / analytic < 1e-4,
     `the drag constant is the derived one, ${S.K_DRAG.toExponential(4)} against an analytic ${analytic.toExponential(4)}`);

  /* And here is why that error hid for so long, and why it only ever hurt the
   * shooter who has not trued yet: K, ρ and 1/BC are exactly degenerate in
   * ρ·Cd·v²/BC, so any error in K is indistinguishable from an error in the
   * BC — which the truing step is free to absorb. */
  const a = S.integrate({ mv: 2600, bc: 0.243, sightHeightIn: 1.5, zeroYd: 100,
                          densityRatio: 1.0, tempF: 59, maxYd: 1000 });
  const b = S.integrate({ mv: 2600, bc: 0.243 * 1.25, sightHeightIn: 1.5, zeroYd: 100,
                          densityRatio: 1.25, tempF: 59, maxYd: 1000 });
  ok(a[1000].dropFt === b[1000].dropFt,
     'density and 1/BC are one product — a 25% denser atmosphere with a 25% higher BC is bit-identical');
}

/* ═══════════════════════════════ the physics, against a published trajectory */
/* Federal Gold Medal 175gr Sierra MatchKing, G7 BC 0.243, 2600 fps, 1.5" sight
 * height, 100 yd zero, standard atmosphere. Elevation come-ups and retained
 * velocities from longrangescience.com's published table for that exact load.
 *
 * This used to assert that the solver's come-ups matched that table to 0.19
 * MOA — which is exactly the assertion that motivated fudging K_DRAG, because
 * the only way to hit it was to fit the constant to the table. The table is
 * not a measurement of this load; it is somebody else's model of it, and the
 * evidence that its stated BC is not the BC it was computed with is in the
 * section above.
 *
 * So it is used the only way a table of someone else's numbers legitimately
 * can be: the solver is TRUED to it, treating its come-ups as anchors, and
 * what is asserted is that the fit is close and that the BC it recovers is
 * near the BC the table says it used. That tests whether the drag model has
 * the right SHAPE across 200 to 1000 yards, which the table can evidence,
 * rather than agreement with a number the table may itself have got wrong. */
section('the trajectory, trued to a published table');
{
  const PUB = {
    200: [1.98, 2251], 300: [4.82, 2087], 400: [8.16, 1928], 500: [11.95, 1777],
    600: [16.24, 1632], 700: [21.09, 1493], 800: [26.60, 1360], 900: [32.89, 1232],
    1000: [40.11, 1121],
  };
  const yds = Object.keys(PUB).map(Number);
  const fit = S.trueToDope(yds.map(yd => ({ yd, moa: PUB[yd][0] })),
    { mv: 2600, bc: 0.243, sightHeightIn: 1.5, zeroYd: 100,
      densityRatio: 1, tempF: 59, horizonYd: 1100 });

  ok(fit && fit.trued, 'the published trajectory is a trajectory this model can fit');
  ok(fit.rmsMoa < 0.15,
     `and it fits it across nine distances to ${fit.rmsMoa.toFixed(3)} MOA RMS`);
  let worstMoa = 0, worstV = 0, at = '';
  for (const yd of yds) {
    const p = S.predict(fit, yd);
    const dm = Math.abs(p.moa - PUB[yd][0]);
    if (dm > worstMoa) { worstMoa = dm; at = `${yd} yd: ${p.moa.toFixed(2)} vs ${PUB[yd][0]}`; }
    worstV = Math.max(worstV, Math.abs(p.velocity - PUB[yd][1]));
  }
  ok(worstMoa < 0.30, `never worse than ${worstMoa.toFixed(2)} MOA anywhere in it (worst ${at})`);

  /* The shape check. The fit was to the DROP column only; the velocity column
   * is then reproduced independently, which a drag curve of the wrong shape
   * could not do while also fitting the drop. */
  ok(worstV < 40, `and reproduces the retained-velocity column it never saw, to ${worstV.toFixed(0)} fps`);

  const bcOff = Math.abs(fit.bc / 0.243 - 1);
  ok(bcOff < 0.08,
     `recovering a BC of ${fit.bc.toFixed(4)} against the table's stated 0.243 — ${(bcOff * 100).toFixed(1)}% away`);
  ok(Math.abs(fit.mv / 2600 - 1) < 0.05,
     `at a muzzle velocity of ${fit.mv.toFixed(0)} against the table's 2600 fps`);

  /* The zero is where it was asked for -- if the launch-angle search is wrong
   * every number above is wrong by the same amount and the comparison would
   * still pass. */
  const t = S.integrate({ mv: 2600, bc: 0.243, sightHeightIn: 1.5, zeroYd: 100,
                          densityRatio: 1, tempF: 59, maxYd: 1050 });
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

/* ══════════════════ atmosphere survives truing, which is the harder half */
/* The above only shows that the INTEGRATOR responds to density. The failure
 * that mattered was downstream of it: because ρ and 1/BC enter drag as a
 * single product and bcScale is a free fitting parameter, truing every anchor
 * in TODAY's air let the fit produce a bcScale that exactly cancelled whatever
 * density was handed in. The shooter typed 5,000 ft correctly and the
 * prediction did not move — 34.08 MOA against a physical truth of 30.27, 3.8
 * MOA and about 40 inches high at 1000 yards.
 *
 * The fix is to fit each anchor in the air IT was shot in. These assertions
 * are what fail without it. */
section('atmosphere survives the truing step');
{
  const TRUE_MV = 2712, TRUE_BC = 0.259;
  const base = { sightHeightIn: 1.9, zeroYd: 100 };
  const at = (dr, tF) => S.integrate({ ...base, mv: TRUE_MV, bc: TRUE_BC,
                                       densityRatio: dr, tempF: tF, maxYd: 1100 });

  /* DOPE confirmed at sea level, on a standard day, and tagged as such. */
  const seaLevel = at(1, 59);
  const anchors = [200, 300, 600].map(yd => ({
    yd, moa: S.dropToMoa(seaLevel[yd].dropFt, yd), densityRatio: 1, tempF: 59,
  }));
  const truthSea = S.dropToMoa(seaLevel[1000].dropFt, 1000);

  /* Match day at five thousand feet, entered correctly. */
  const DR_5K = S.airDensityRatio({ tempF: 59, pressureInHg: 24.9 });
  const alt = S.trueToDope(anchors, { ...base, mv: 2800, bc: 0.243,
                                      densityRatio: DR_5K, tempF: 59, horizonYd: 1200 });
  const truthAlt = S.dropToMoa(at(DR_5K, 59)[1000].dropFt, 1000);
  const predAlt = S.predict(alt, 1000).moa;

  ok(alt.trued, 'sea-level DOPE still trues when the match is at altitude');
  ok(Math.abs(predAlt - truthAlt) < 0.35,
     `and the prediction is the ALTITUDE truth: ${predAlt.toFixed(2)} against ${truthAlt.toFixed(2)} MOA`);
  ok(Math.abs(predAlt - truthSea) > 3,
     `which is ${Math.abs(predAlt - truthSea).toFixed(2)} MOA away from the sea-level answer — ` +
     `thin air moves the dial, and before this it did not move it at all`);
  ok(alt.anchorsHaveAtmosphere === true,
     'and it reports that the correction is grounded in recorded conditions, not assumed');

  /* Temperature was equally inert: the prediction sat between 33.9 and 34.1
   * from 0°F to 110°F while the physical truth ran from 36.6 down to 32.4. */
  const spread = [];
  for (const tF of [0, 110]) {
    const dr = S.airDensityRatio({ tempF: tF, pressureInHg: 29.92 });
    const r = S.trueToDope(anchors, { ...base, mv: 2800, bc: 0.243,
                                      densityRatio: dr, tempF: tF, horizonYd: 1200 });
    const truth = S.dropToMoa(at(dr, tF)[1000].dropFt, 1000);
    const pred = S.predict(r, 1000).moa;
    spread.push(pred);
    ok(Math.abs(pred - truth) < 0.35,
       `at ${tF}°F it predicts ${pred.toFixed(2)} against a true ${truth.toFixed(2)} MOA`);
  }
  ok(Math.abs(spread[0] - spread[1]) > 3,
     `and a hundred and ten degrees is worth ${Math.abs(spread[0] - spread[1]).toFixed(2)} MOA at 1000, not the 0.2 it used to be`);

  /* Anchors with no recorded conditions are assumed standard — which is the
   * assumption the shooter is already making — and the flag says so, so the UI
   * can distinguish a grounded correction from an assumed one. */
  const untagged = S.trueToDope(anchors.map(({ yd, moa }) => ({ yd, moa })),
    { ...base, mv: 2800, bc: 0.243, densityRatio: DR_5K, tempF: 59, horizonYd: 1200 });
  ok(untagged.anchorsHaveAtmosphere === false,
     'anchors with no recorded conditions are flagged as an assumption rather than a measurement');
  ok(Math.abs(S.predict(untagged, 1000).moa - predAlt) < 0.01,
     '...and are treated as standard air, which is what they were assumed to be all along');
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

/* ═══════════════════════════ the search space has to contain real rifles */
/* A 350 fps error between the box and the barrel is ordinary — a short barrel
 * with factory ammunition does it routinely. Against the old ±8% search space
 * that rifle pinned at the lower bound and predicted 3.45 MOA wrong at 1000,
 * shown with a ±1.84 interval and an RMS of 0.150 that reads as an excellent
 * fit: wrong by 1.9× its own error bar with nothing in the output saying so. */
section('the search space, and what happens at its edge');
{
  const base = { sightHeightIn: 1.9, zeroYd: 100, densityRatio: 1, tempF: 59 };
  const BOX_MV = 2800, BOX_BC = 0.243;
  const rifle = (mv, bc) => {
    const truth = S.integrate({ ...base, mv, bc, maxYd: 1100 });
    const anchors = [200, 300, 600].map(yd => ({ yd, moa: S.dropToMoa(truth[yd].dropFt, yd) }));
    return { truth, fit: S.trueToDope(anchors, { ...base, mv: BOX_MV, bc: BOX_BC, horizonYd: 1200 }) };
  };

  /* The demonstrated case: 2450 fps against a 2800 box. */
  const short = rifle(2450, 0.243);
  const truth1000 = S.dropToMoa(short.truth[1000].dropFt, 1000);
  ok(short.fit.trued && !short.fit.pinned,
     'a rifle 350 fps below its box number is inside the search space, not against its wall');
  const p = S.predict(short.fit, 1000);
  ok(Math.abs(p.moa - truth1000) < 0.5,
     `and is predicted to ${Math.abs(p.moa - truth1000).toFixed(2)} MOA at 1000 (${p.moa.toFixed(2)} vs ${truth1000.toFixed(2)}), not the 3.45 it used to be`);
  ok(Math.abs(p.moa - truth1000) < p.ci,
     `inside its own interval of ±${p.ci.toFixed(2)}, which is the whole point of having one`);

  /* And a rifle that genuinely is not what the box says at all. There is no
   * honest answer here, so there is no answer — the fit ran out of room, and
   * that is a fact about the inputs, not about the rifle. */
  for (const [mv, dir] of [[2100, 'lower'], [3400, 'higher']]) {
    const wild = rifle(mv, 0.243);
    ok(wild.fit.trued === false && wild.fit.pinned === true,
       `a rifle truly doing ${mv} fps against a 2800 box is refused rather than fitted`);
    ok(/velocity range/.test(wild.fit.reason || '') && new RegExp(dir).test(wild.fit.reason || ''),
       `...naming which bound it ran to (${wild.fit.reason})`);
    const landed = wild.fit.pinnedAt;
    ok(!!landed &&
       landed.mvScale >= S.SEARCH_BOX.mvLo - 1e-9 && landed.mvScale <= S.SEARCH_BOX.mvHi + 1e-9 &&
       landed.bcScale >= S.SEARCH_BOX.bcLo - 1e-9 && landed.bcScale <= S.SEARCH_BOX.bcHi + 1e-9,
       '...and the refinement sweeps stayed inside the declared box rather than walking out of it');
  }
}

/* ══════════════════════════════════ a mistyped zero is data, not physics */
/* A 600 yd zero of 14.15 entered as 1.415 used to fit silently: trued, RMS
 * 4.767, predicting 21.74 ± 4.84 against a true 34.04. Twelve minutes of
 * under-dial, about 128 inches low at 1000, from one decimal point. A fit to a
 * shooter's own confirmed zeros cannot physically be that bad, so an RMS past
 * half a minute means the numbers disagree with each other and the useful
 * thing to say is WHICH one. */
section('a mistyped zero');
{
  const base = { sightHeightIn: 1.9, zeroYd: 100, densityRatio: 1, tempF: 59 };
  const truth = S.integrate({ ...base, mv: 2712, bc: 0.259, maxYd: 1100 });
  const good = [200, 300, 600].map(yd => ({ yd, moa: S.dropToMoa(truth[yd].dropFt, yd) }));

  for (const [label, factor] of [['a decimal point in the wrong place', 1 / 10], ['a ×10 slip', 10]]) {
    const bad = good.map(a => a.yd === 600 ? { yd: 600, moa: a.moa * factor } : a);
    const r = S.trueToDope(bad, { ...base, mv: 2800, bc: 0.243, horizonYd: 1200 });
    ok(r.trued === false, `${label} is refused rather than fitted`);
    ok(r.worstAnchor && r.worstAnchor.yd === 600,
       `...naming the 600 yd anchor as the one that disagrees (worst residual ${r.worstAnchor ? num(Math.abs(r.worstAnchor.residual)) : 'none reported'} MOA)`);
    ok(/600 yd zero/.test(r.reason || ''),
       `...in words a shooter can act on ("${(r.reason || '').slice(0, 72)}…")`);
    ok(r.fitRmsMoa > S.RMS_GATE_MOA,
       `...because the fit was ${num(r.fitRmsMoa)} MOA RMS, past the ${S.RMS_GATE_MOA} MOA gate`);
  }

  /* Both of those also run the fit into the edge of the search space, so the
   * boundary check would refuse them too — but it would refuse them by talking
   * about the muzzle velocity, which is not where the problem is. This case is
   * caught by the residual and ONLY by the residual: four anchors with the 450
   * three minutes out, a fit that stays comfortably inside the box, and a
   * disagreement that exists only between the anchors themselves. */
  const four = [200, 300, 450, 600].map(yd => ({ yd, moa: S.dropToMoa(truth[yd].dropFt, yd) }));
  const one = four.map(a => a.yd === 450 ? { yd: 450, moa: a.moa + 3 } : a);
  const r1 = S.trueToDope(one, { ...base, mv: 2800, bc: 0.243, horizonYd: 1200 });
  ok(r1.trued === false && r1.pinned === false,
     'an anchor that disagrees without running the fit out of search space is still refused');
  ok(r1.worstAnchor && r1.worstAnchor.yd === 450,
     `...on the residual alone, and it is the 450 that is named (${num(r1.fitRmsMoa)} MOA RMS)`);

  /* The gate must not fire on real data. Confirmed zeros read off a target
   * carry a couple of tenths of scatter and that still has to true. */
  const jitter = [0.12, -0.15, 0.1];
  const noisy = good.map((a, i) => ({ yd: a.yd, moa: a.moa + jitter[i] }));
  const r2 = S.trueToDope(noisy, { ...base, mv: 2800, bc: 0.243, horizonYd: 1200 });
  ok(r2.trued === true,
     `and a tenth or two of read error on every anchor still trues (${r2.rmsMoa.toFixed(3)} MOA RMS)`);

  /* And here is what this gate does NOT do, asserted so that nobody reads more
   * into it than is there. Three anchors against two free parameters is not
   * over-determined: a single anchor one minute out is absorbed by the fit
   * rather than showing up as a residual, so the RMS stays at 0.02 while the
   * 1000 yd prediction goes nearly seven minutes wrong. The gate catches gross
   * errors — decimal points, ×10 slips, an anchor from a different rifle — and
   * a moderate one on a three-anchor set is not visible from the residuals at
   * all. What defends against that is a fourth anchor, not a threshold. */
  const subtle = good.map(a => a.yd === 600 ? { yd: 600, moa: a.moa + 1 } : a);
  const r3 = S.trueToDope(subtle, { ...base, mv: 2800, bc: 0.243, horizonYd: 1200 });
  ok(r3.trued === true && r3.rmsMoa < 0.1,
     `a one-minute error on one of three anchors is absorbed, not detected (${r3.rmsMoa.toFixed(3)} MOA RMS) — ` +
     `the residual gate is not a substitute for a fourth anchor`);
}

/* ══════════════════════════ it does not report success for a failed fit */
/* `best` was initialised to {sse: Infinity} and updated on `r.sse < best.sse`,
 * which is never true when every candidate returns Infinity — so the initial
 * value, mvScale 1 and bcScale 1, fell through to the success return.
 * Demonstrated: trueToDope with a BC of 0.01 returned {trued: true, rmsMoa:
 * Infinity}. */
section('when every candidate fit fails');
{
  const r = S.trueToDope([{ yd: 200, moa: 2 }, { yd: 400, moa: 7 }, { yd: 600, moa: 15 }],
    { mv: 2700, bc: 0.01, sightHeightIn: 1.9, zeroYd: 100, densityRatio: 1, tempF: 59 });
  ok(r && r.trued === false, 'a fit where nothing integrated is not a successful fit');
  ok(!(r.rmsMoa > 0) || Number.isFinite(r.rmsMoa),
     `and does not report an RMS of Infinity as a goodness of fit (${r.rmsMoa})`);
  ok(/could not be integrated|muzzle velocity/.test(r.reason || ''),
     `...saying so (${r.reason})`);
}

/* ═══════════════════════════════ a bad BC must not freeze the app */
/* 400,000 steps of step guard × up to 30 secant passes × ~300 evaluations.
 * Measured before the bound existed: bc 0.243 took 280 ms, bc 0.01 took 25.2
 * seconds and bc 0.005 took 33.3 seconds. On a phone between strings that is a
 * frozen app, and the thing it is grinding towards is a refusal. */
section('a pathological BC comes back quickly');
{
  const base = { mv: 2700, sightHeightIn: 1.9, zeroYd: 100, densityRatio: 1, tempF: 59 };
  const anchors = [{ yd: 200, moa: 2 }, { yd: 400, moa: 7 }, { yd: 600, moa: 15 }];
  for (const bc of [0.01, 0.005]) {
    const t0 = Date.now();
    const r = S.trueToDope(anchors, { ...base, bc, horizonYd: 1200 });
    const ms = Date.now() - t0;
    ok(ms < 2000, `a BC of ${bc} is answered in ${ms} ms, not the 25–33 seconds it used to take`);
    ok(r.trued === false, `...with a refusal (${(r.reason || '').slice(0, 60)}…)`);
  }
  /* And a real one is still fast enough to run between strings. */
  const t0 = Date.now();
  S.trueToDope(anchors.map(a => ({ ...a, moa: a.moa })), { ...base, bc: 0.243, horizonYd: 1200 });
  ok(Date.now() - t0 < 2000, `a real BC still trues in ${Date.now() - t0} ms`);
}

/* ═══════════════════════════ garbage in, nothing out — not garbage out */
/* An out-of-range zero distance meant the launch-angle search never found its
 * target, fell back on multiplying the angle by 1.5 until it hit the clamp,
 * and returned an 11.5° launch as a solution. A zeroYd of 0, of 1200 against a
 * 1100 yd table, and of −100 all produced a full table of numbers reporting
 * −642.792 MOA at 1000. A negative BC was worse: the bullet accelerated under
 * negative drag and the table looked entirely plausible at 13.015 MOA. */
section('invalid inputs return nothing rather than a plausible table');
{
  const good = { mv: 2700, bc: 0.243, sightHeightIn: 1.9, zeroYd: 100,
                 densityRatio: 1, tempF: 59, maxYd: 1100 };
  ok(S.integrate(good).length > 1000, 'the control case integrates');

  const bad = [
    ['a zero distance of 0', { zeroYd: 0 }],
    ['a zero distance past the end of the table', { zeroYd: 1200 }],
    ['a negative zero distance', { zeroYd: -100 }],
    ['a NaN zero distance', { zeroYd: NaN }],
    ['a negative BC', { bc: -0.243 }],
    ['a BC of zero', { bc: 0 }],
    ['a BC below anything that is a bullet', { bc: 0.001 }],
    ['a NaN BC', { bc: NaN }],
    ['a muzzle velocity of zero', { mv: 0 }],
    ['a negative muzzle velocity', { mv: -2700 }],
    ['a density ratio of zero', { densityRatio: 0 }],
    ['a negative density ratio', { densityRatio: -1 }],
    ['a NaN density ratio', { densityRatio: NaN }],
    ['a negative maximum distance', { maxYd: -100 }],
  ];
  for (const [label, override] of bad) {
    const t = S.integrate({ ...good, ...override });
    ok(t.length === 0 || !t.some(Boolean), `${label} returns an empty table`);
  }

  /* Which means the solver above it declines rather than reporting a number. */
  const r = S.trueToDope([{ yd: 200, moa: 2 }, { yd: 600, moa: 14.15 }],
    { mv: 2700, bc: 0.243, sightHeightIn: 1.9, zeroYd: 0, densityRatio: 1, tempF: 59 });
  ok(r.trued === false, 'and truing on top of an invalid zero distance refuses');
  ok(S.predict(r, 1000) === null, '...with nothing to predict from');
}

/* ══════════════════════════════════════ the confidence interval says what it should say */
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

  /* One yardage, used for both the row lookup and the arc-minute conversion.
   * predict(t, 1000.4) used to read row 1000 and divide by 1000.4 yards,
   * returning 33.898 where predict(t, 1000) returned 33.987 off the same row —
   * an answer about a shot nobody took. */
  ok(S.predict(trued, 1000.4).moa === S.predict(trued, 1000).moa,
     'a fractional yardage is answered from the row it rounds to, consistently');
  ok(S.predict(trued, 1000.6).moa === S.predict(trued, 1001).moa,
     '...rounding up as readily as down');
  ok(S.predict(trued, 1000.4).yd === 1000 && S.predict(trued, 1000.6).yd === 1001,
     '...and says which distance it actually answered');

  /* Hostile yardages. */
  ok(S.predict(trued, -500) === null && S.predict(trued, 0) === null &&
     S.predict(trued, 1e6) === null && S.predict(trued, NaN) === null,
     'and a nonsense distance returns nothing');
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

  /* The 600 yd prone cell has no partner, and must not invent one. The old
   * assertion here was `!offs.some(o => o.n > 2)`, which is satisfied by
   * everything that goes wrong below as well as by everything going right. */
  ok(offs.length === 2 && offs.every(o => o.n === 2),
     'a position with no partner at a distance contributes nothing — two pairings, two observations each');

  const single = S.positionOffsets([cells[0], cells[1]]);
  ok(single[0].n === 1 && single[0].elevSd === null,
     'a single observation reports no spread rather than a spread of zero');

  /* ── the same observation twice is one observation ──────────────────────
   * n counted ordered pairings, so a duplicated entry did not just inflate n,
   * it collapsed the spread: two identical Prone rows and one Standing at the
   * same distance reported {n: 2, elevMoa: 0.5, elevSd: 0} — two independent
   * observations in perfect agreement, which is the most confidence-inspiring
   * thing this function can produce, out of one string logged twice. */
  const dup = S.positionOffsets([
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.0, wind: 0.0 },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.0, wind: 0.0 },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Standing', elev: 2.5, wind: 0.0 },
  ]);
  const d = dup.find(o => o.from === 'Prone' && o.to === 'Standing');
  ok(d.n === 1, `the same observation logged twice is one observation, not two (n = ${d.n})`);
  ok(d.elevSd === null,
     'and reports no spread at all rather than a spread of zero, which would read as perfect agreement');

  /* Two genuinely different Prone strings against one Standing string are two
   * observations, and must survive the deduplication. */
  const twice = S.positionOffsets([
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.0, wind: 0.0, date: '2026-05-01' },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.2, wind: 0.0, date: '2026-06-01' },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Standing', elev: 2.5, wind: 0.0, date: '2026-06-02' },
  ]).find(o => o.from === 'Prone' && o.to === 'Standing');
  ok(twice.n === 2 && twice.elevSd > 0,
     `but two different Prone strings against one Standing really are two observations (n = ${twice.n}, sd ${twice.elevSd.toFixed(2)})`);

  /* ── a missing number is not a zero ─────────────────────────────────────
   * `(b.elev || 0) - (a.elev || 0)` turned an absent elevation into a
   * fabricated 14 MOA position offset, reported as an observation. NaN was
   * worse: NaN || 0 is 0, so it fabricated with no NaN left to show for it. */
  for (const [label, sitting] of [
    ['missing', { rifleId: 'r1', location: 'home', yards: 200, position: 'Sitting', wind: 0.5 }],
    ['NaN',     { rifleId: 'r1', location: 'home', yards: 200, position: 'Sitting', elev: NaN, wind: 0.5 }],
  ]) {
    const o = S.positionOffsets([
      { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone', elev: 14.0, wind: 0.0 },
      sitting,
    ]);
    ok(o.length === 0,
       `a cell with a ${label} elevation contributes no offset, rather than a fabricated 14 MOA one`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
