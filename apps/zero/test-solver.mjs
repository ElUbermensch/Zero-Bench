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

/* Federal Gold Medal 175gr Sierra MatchKing, G7 BC 0.243, 2600 fps, 1.5" sight
 * height, 100 yd zero, standard atmosphere. Elevation come-ups and retained
 * velocities from longrangescience.com's published table for that exact load.
 * Used by two sections below, and used carefully in both: see the note on what
 * a table of somebody else's numbers can and cannot evidence. */
const PUB_TABLE = {
  200: [1.98, 2251], 300: [4.82, 2087], 400: [8.16, 1928], 500: [11.95, 1777],
  600: [16.24, 1632], 700: [21.09, 1493], 800: [26.60, 1360], 900: [32.89, 1232],
  1000: [40.11, 1121],
};

/* ═══════════════════════════════════ the drag constant, derived not fitted */
/* K_DRAG shipped for a while as 2.010e-4, which is 3.6% below the analytic
 * value, because it had been FITTED to the published table used below rather
 * than derived.
 *
 * BE CLEAR ABOUT WHAT EACH ASSERTION HERE IS WORTH, because the previous
 * version of this section was written as evidence and was not evidence. The
 * published table is REVERTED-K-BLIND: put 2.010e-4 back and the section below
 * goes 98 passed, 1 failed, and three of its five numbers get BETTER — worst
 * come-up 0.12 against 0.15 MOA, worst retained velocity 13 against 26 fps,
 * recovered muzzle velocity 2620 against 2637. A test that a bug passes better
 * than the fix is not corroboration of anything.
 *
 * So this section now contains exactly three kinds of statement, labelled:
 *   1. a RESTATEMENT of the derivation, which catches a typo and nothing more;
 *   2. a DISCRIMINATOR — the untrued trajectory against one computed here from
 *      the bullet's mass and diameter, which is where K actually shows;
 *   3. a MEASUREMENT of why the reference table cannot evidence K at all. */
section('the drag constant');
{
  /* 1. THE RESTATEMENT. This recomputes the constant from the same three
   * factors the source multiplies together, so it can only ever catch a typo
   * in one of them or in the product. It is worth its line for that and it is
   * worth nothing beyond it — in particular it is not evidence that the
   * constant is the right one for a real bullet. That is assertion 2. */
  const RHO_STD_SLUG_FT3 = 0.00237689;   // standard sea-level air density
  const PI_OVER_8 = Math.PI / 8;         // from a = ρv²Cd·πd²/(8m)
  const BC_LB_IN2_TO_SLUG_FT2 = 32.174 / 144;  // lb→slug, in²→ft², from BC = m/(d²i)
  const analytic = RHO_STD_SLUG_FT3 * PI_OVER_8 * BC_LB_IN2_TO_SLUG_FT2;
  ok(Math.abs(S.K_DRAG - analytic) / analytic < 1e-4,
     `the drag constant is the derived one, ${S.K_DRAG.toExponential(4)} against an analytic ${analytic.toExponential(4)} (a restatement, not evidence)`);

  /* 2. THE DISCRIMINATOR.
   *
   * A trajectory computed here from things a bullet HAS — 175 grains, .308
   * inches across, a G7 BC of 0.243 — and Newton, with no K anywhere in it:
   *
   *   form factor  i = m[lb] / (d[in]² · BC)
   *   drag force   F = ½ ρ v² · (i · Cd_G7) · πd[ft]²/4
   *   deceleration a = F / m[slug],  m[slug] = m[lb] / 32.174
   *
   * That is the same physics the solver's K is a factorisation of — it has to
   * be, or one of them is wrong — but it arrives through the bullet's mass and
   * diameter, which cancel, rather than through a single number nobody can
   * eyeball. If K is 3.6% low the two disagree by 1.26 MOA and 36 fps at 1000
   * yards, which is far outside the tolerance below.
   *
   * And note WHICH path this tests: the UNTRUED one. That is deliberate. On
   * the trued path K, ρ and 1/BC are exactly degenerate (assertion 4 below), so
   * bcScale absorbs any error in K and nothing moves — which is why the wrong
   * constant hid for so long, and why the shooter it hurt was the one who had
   * not confirmed a zero yet and was looking at box numbers. Before this,
   * nothing in this file asserted anything about that path at all. */
  const GR_PER_LB = 7000, LBM_PER_SLUG = 32.174;
  const newtonian = ({ grains, diamIn, bcG7, mv, sightHeightIn, zeroYd, maxYd, dt = 0.0005 }) => {
    const mLb = grains / GR_PER_LB, mSlug = mLb / LBM_PER_SLUG;
    const formFactor = mLb / (diamIn * diamIn * bcG7);
    const area = Math.PI * Math.pow(diamIn / 12, 2) / 4;
    const cs = S.speedOfSound(59);
    const fly = (ang) => {
      let x = 0, y = -sightHeightIn / 12, vx = mv * Math.cos(ang), vy = mv * Math.sin(ang), t = 0;
      const out = []; let nx = 1;
      while (x < maxYd * 3 && t < 20) {
        const v = Math.hypot(vx, vy);
        const dec = 0.5 * RHO_STD_SLUG_FT3 * v * v * formFactor * S.cdG7(v / cs) * area / mSlug;
        const px = x, py = y, pvx = vx, pvy = vy;
        x += vx * dt; y += vy * dt;
        vx -= dec * (pvx / v) * dt; vy -= (dec * (pvy / v) + 32.174) * dt; t += dt;
        while (nx <= maxYd && x >= nx * 3) {
          const f = (nx * 3 - px) / (x - px || 1);
          out[nx] = { dropFt: py + (y - py) * f,
                      v: Math.hypot(pvx, pvy) + (Math.hypot(vx, vy) - Math.hypot(pvx, pvy)) * f };
          nx++;
        }
        if (vx <= 0) break;
      }
      return out;
    };
    let a0 = 0, a1 = 0.002, f0 = fly(a0)[zeroYd].dropFt, best = null, be = Infinity;
    for (let k = 0; k < 30; k++) {
      const o = fly(a1); if (!o[zeroYd]) break;
      const f1 = o[zeroYd].dropFt;
      if (Math.abs(f1) < be) { be = Math.abs(f1); best = o; }
      if (Math.abs(f1) < 1e-5) break;
      const d = f1 - f0; if (Math.abs(d) < 1e-12) break;
      const a2 = a1 - f1 * (a1 - a0) / d; a0 = a1; f0 = f1; a1 = a2;
    }
    return best;
  };

  const BULLET = { grains: 175, diamIn: 0.308, bcG7: 0.243, mv: 2600,
                   sightHeightIn: 1.5, zeroYd: 100, maxYd: 1000 };
  const ind = newtonian(BULLET);
  const sol = S.integrate({ mv: 2600, bc: 0.243, sightHeightIn: 1.5, zeroYd: 100,
                            densityRatio: 1, tempF: 59, maxYd: 1000 });
  let wMoa = 0, wV = 0, wAt = 0;
  for (const yd of [200, 300, 400, 500, 600, 700, 800, 900, 1000]) {
    const dm = Math.abs(S.dropToMoa(sol[yd].dropFt, yd) - S.dropToMoa(ind[yd].dropFt, yd));
    if (dm > wMoa) { wMoa = dm; wAt = yd; }
    wV = Math.max(wV, Math.abs(sol[yd].v - ind[yd].v));
  }
  ok(wMoa < 0.01,
     `the untrued trajectory matches one computed from 175 gr of .308 and Newton to ${wMoa.toFixed(4)} MOA (worst at ${wAt}) — with K at 2.010e-4 this is 1.26`);
  ok(wV < 2,
     `and its retained velocity to ${wV.toFixed(1)} fps — with K at 2.010e-4 this is 36`);

  /* 3. THE MEASUREMENT that says the reference table cannot settle this.
   *
   * Fit K to that table's drop column and you get one number; fit it to the
   * retained-velocity column of the SAME nine rows and you get another, 0.87%
   * away. One well-posed physical constant cannot be two numbers depending on
   * which column of one table you fit it to. What the spread means is that the
   * table's stated BC of 0.243 is not the BC the table was computed with, and
   * a K fitted to it is absorbing somebody else's error under a name that says
   * "physics". This is the fact that disqualifies the table as evidence, so it
   * is the fact that gets asserted. */
  const fitK = (column) => {
    const cost = (K) => {
      /* Same integration, K as a parameter. A 2 ms step is used because this
       * runs a hundred flights and the optimum moves by under a tenth of a
       * percent between 2 ms and 0.5 ms. */
      const t = newtonian({ ...BULLET, dt: 0.002,
                            bcG7: BULLET.bcG7 * (S.K_DRAG / K) });
      if (!t) return Infinity;
      let sse = 0, n = 0;
      for (const yd of Object.keys(PUB_TABLE).map(Number)) {
        if (!t[yd]) return Infinity;
        const d = column === 'drop'
          ? S.dropToMoa(t[yd].dropFt, yd) - PUB_TABLE[yd][0]
          : (t[yd].v - PUB_TABLE[yd][1]) / 100;
        sse += d * d; n++;
      }
      return Math.sqrt(sse / n);
    };
    let lo = 1.90e-4, hi = 2.30e-4;
    for (let i = 0; i < 24; i++) {
      const m1 = lo + (hi - lo) * 0.382, m2 = lo + (hi - lo) * 0.618;
      if (cost(m1) < cost(m2)) hi = m2; else lo = m1;
    }
    return (lo + hi) / 2;
  };
  const kDrop = fitK('drop'), kVel = fitK('vel');
  const apart = Math.abs(kVel - kDrop) / kDrop;
  ok(apart > 0.004 && apart < 0.02,
     `the published table's own drop-optimal K (${kDrop.toExponential(4)}) and velocity-optimal K ` +
     `(${kVel.toExponential(4)}) are ${(apart * 100).toFixed(2)}% apart — one constant cannot be both, ` +
     `so the table cannot evidence one`);
  ok(kDrop < S.K_DRAG * 0.99 && kVel < S.K_DRAG * 0.99,
     `and both of them sit below the derived value (${(100 * (kDrop / S.K_DRAG - 1)).toFixed(1)}% and ` +
     `${(100 * (kVel / S.K_DRAG - 1)).toFixed(1)}%), which is what fitting to it did and why it was wrong`);

  /* 4. And here is why the error hid, asserted for what it is. This holds for
   * ANY value of K — it is a statement about the SHAPE of ρ·Cd·v²/BC, not
   * about the constant in front of it, and it passes unchanged at 2.010e-4.
   * It is here because the degeneracy is the reason the trued path is immune
   * and the untrued path is not, and NOT as corroboration of K. */
  const a = S.integrate({ mv: 2600, bc: 0.243, sightHeightIn: 1.5, zeroYd: 100,
                          densityRatio: 1.0, tempF: 59, maxYd: 1000 });
  const b = S.integrate({ mv: 2600, bc: 0.243 * 1.25, sightHeightIn: 1.5, zeroYd: 100,
                          densityRatio: 1.25, tempF: 59, maxYd: 1000 });
  ok(a[1000].dropFt === b[1000].dropFt,
     'density and 1/BC are one product — a 25% denser atmosphere with a 25% higher BC is bit-identical (true of any K, which is the point)');
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
 * the right SHAPE across 200 to 1000 yards, which the table can evidence.
 *
 * AND NOTHING IN THIS SECTION DISCRIMINATES K_DRAG, which is worth saying
 * outright because the wording here used to imply otherwise. Put 2.010e-4 back
 * and every assertion below still passes, and three of the five get closer:
 * worst come-up 0.12 against 0.15 MOA, worst retained velocity 13 against 26
 * fps, recovered muzzle velocity 2620 against 2637. That is not a flaw in the
 * assertions, it is the definition of truing — bcScale is free, K and 1/BC are
 * exactly degenerate, and so the fit absorbs any error in K and lands on the
 * table wherever the table happens to be. A section that trues to something
 * CANNOT evidence the constant it trues with. The assertion that does is in
 * the section above, and it is on the untrued path, because that is the only
 * path where K is visible at all. */
section('the trajectory, trued to a published table');
{
  const PUB = PUB_TABLE;
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

  /* The recovered BC lands near the table's stated one, which says the drag
   * model's shape is close to whatever model the table came from. It is NOT
   * evidence about K_DRAG: it lands near 0.243 at 2.010e-4 as well. */
  const bcOff = Math.abs(fit.bc / 0.243 - 1);
  ok(bcOff < 0.08,
     `recovering a BC of ${fit.bc.toFixed(4)} against the table's stated 0.243 — ${(bcOff * 100).toFixed(1)}% away, which is a statement about the drag curve's shape and not about K`);
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

  /* Anchors with no recorded conditions are assumed standard when the caller
   * has told the solver nothing better, and the flag says so, so the UI can
   * distinguish a grounded correction from an assumed one. */
  const untagged = S.trueToDope(anchors.map(({ yd, moa }) => ({ yd, moa })),
    { ...base, mv: 2800, bc: 0.243, densityRatio: DR_5K, tempF: 59, horizonYd: 1200 });
  ok(untagged.anchorsHaveAtmosphere === false,
     'anchors with no recorded conditions are flagged as an assumption rather than a measurement');
  ok(Math.abs(S.predict(untagged, 1000).moa - predAlt) < 0.01,
     '...and with nothing else to go on are treated as standard air');
  ok(untagged.assumedAnchorAtmosphere.densityRatio === 1 &&
     untagged.assumedAnchorAtmosphere.tempF === 59,
     '...and say so, rather than leaving the screen to guess what was assumed');
  /* And the interval is widened for it, because a fit whose air was assumed is
   * not in the population the interval was measured over otherwise. */
  ok(S.predict(untagged, 1000).ci > S.predict(alt, 1000).ci,
     `an assumed atmosphere widens the interval (±${S.predict(untagged, 1000).ci.toFixed(2)} against ±${S.predict(alt, 1000).ci.toFixed(2)})`);
}

/* ══════ an untagged anchor is at the shooter's stated pressure, not the sea */
/* Only the TEMPERATURE is recorded per session; the station pressure the zeros
 * were confirmed at is a field on the solver screen and it applies to all of
 * them alike. An anchor with no temperature used to be dropped back to
 * standard SEA LEVEL — which threw away a number the shooter had typed, and
 * threw it away for exactly one of their three zeros.
 *
 * A shooter at five thousand feet who correctly enters 24.9 inHg: two anchors
 * honoured it, the third was fitted as if it had been shot at sea level, and
 * the prediction came back 1.43 MOA out at 1000 with an RMS of 0.056 that
 * reads as an excellent fit and a green banner over it.
 *
 * THE CONTRACT the caller writes against: base.zeroDensityRatio if it has the
 * density, or base.zeroPressureInHg (with base.zeroTempF, defaulting to the
 * standard 59°F because nothing was recorded) to derive it from. Neither means
 * standard sea level, which is what it always was. */
section('an anchor with no atmosphere of its own');
{
  const base = { sightHeightIn: 1.9, zeroYd: 100 };
  const TRUE_MV = 2750, TRUE_BC = 0.255, ZERO_INHG = 24.9;
  const TEMPS = { 200: 59, 300: 44, 600: 86 };
  const dr = (t) => S.airDensityRatio({ tempF: t, pressureInHg: ZERO_INHG });
  const anchorAt = (yd) => S.dropToMoa(
    S.integrate({ ...base, mv: TRUE_MV, bc: TRUE_BC, densityRatio: dr(TEMPS[yd]),
                  tempF: TEMPS[yd], maxYd: 700 })[yd].dropFt, yd);

  const todayDR = S.airDensityRatio({ tempF: 70, pressureInHg: ZERO_INHG });
  const truth = S.dropToMoa(S.integrate({ ...base, mv: TRUE_MV, bc: TRUE_BC,
    densityRatio: todayDR, tempF: 70, maxYd: 1200 })[1000].dropFt, 1000);
  const boxBase = { ...base, mv: 2800, bc: 0.243, densityRatio: todayDR, tempF: 70, horizonYd: 1200 };

  const tagged = [200, 300, 600].map(yd => ({ yd, moa: anchorAt(yd), densityRatio: dr(TEMPS[yd]), tempF: TEMPS[yd] }));
  const untagged300 = tagged.map(a => a.yd === 300 ? { yd: 300, moa: a.moa } : a);

  const all = S.trueToDope(tagged, boxBase);
  ok(Math.abs(S.predict(all, 1000).moa - truth) < 0.4,
     `with all three tagged it predicts ${S.predict(all, 1000).moa.toFixed(2)} against a truth of ${truth.toFixed(2)}`);

  const sea = S.trueToDope(untagged300, boxBase);
  ok(Math.abs(S.predict(sea, 1000).moa - truth) > 1.0,
     `dropping the untagged 300 to sea level costs ${Math.abs(S.predict(sea, 1000).moa - truth).toFixed(2)} MOA — which is what happens when nothing says otherwise`);

  const stated = S.trueToDope(untagged300, { ...boxBase, zeroPressureInHg: ZERO_INHG });
  ok(Math.abs(S.predict(stated, 1000).moa - truth) < 0.4,
     `and the station pressure the shooter typed brings it back to ${Math.abs(S.predict(stated, 1000).moa - truth).toFixed(2)} MOA`);
  ok(Math.abs(stated.assumedAnchorAtmosphere.densityRatio -
              S.airDensityRatio({ tempF: 59, pressureInHg: ZERO_INHG })) < 1e-12 &&
     stated.assumedAnchorAtmosphere.pressureInHg === ZERO_INHG,
     `naming what it assumed — ${ZERO_INHG} inHg at the standard 59°F, density ${stated.assumedAnchorAtmosphere.densityRatio.toFixed(4)} — rather than leaving it implicit`);
  ok(stated.rmsMoa < sea.rmsMoa,
     `and the anchors agree with each other better for it (${stated.rmsMoa.toFixed(4)} against ${sea.rmsMoa.toFixed(4)} MOA RMS)`);

  /* The density may be handed over directly, for a caller that has it. */
  const direct = S.trueToDope(untagged300,
    { ...boxBase, zeroDensityRatio: S.airDensityRatio({ tempF: 59, pressureInHg: ZERO_INHG }) });
  ok(direct.mvScale === stated.mvScale && direct.bcScale === stated.bcScale,
     'a density handed over directly and one derived from the pressure are the same assumption');

  /* An anchor that carries its OWN conditions is untouched by any of it. */
  const withAssumption = S.trueToDope(tagged, { ...boxBase, zeroPressureInHg: 20.0 });
  ok(withAssumption.mvScale === all.mvScale && withAssumption.bcScale === all.bcScale &&
     withAssumption.anchorsHaveAtmosphere === true,
     'and an anchor that recorded its own air is unaffected by the assumption, however wrong the assumption is');

  /* The flag keeps its meaning: it is about whether the anchors RECORDED their
   * conditions, not about whether a sensible assumption was available. */
  ok(stated.anchorsHaveAtmosphere === false,
     'a good assumption is still an assumption, and the flag still says so');
  ok(S.predict(stated, 1000).ci > S.predict(all, 1000).ci,
     `so the interval is still wider for it (±${S.predict(stated, 1000).ci.toFixed(2)} against ±${S.predict(all, 1000).ci.toFixed(2)})`);
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

/* ═════════════════════ the coarse grid has to resolve the basin it is in */
/* The search box was widened from 0.92–1.08 × 0.75–1.25 to 0.80–1.15 ×
 * 0.60–1.60, which was right, and the coarse sweep stayed at ten steps, which
 * was not: the resolution fell from 0.016/0.05 to 0.035/0.10. The refinement
 * grids each spanned ONE step of the sweep before them, so they were a fence
 * around the coarse winner — guaranteed to contain its neighbourhood and, if
 * the coarse winner was in the wrong place, guaranteed not to contain the
 * answer.
 *
 * And the misses reported as good fits. Measured over 240 noiseless rifles
 * lying strictly inside the box: 51 of 240 predictions at 1000 yd fell outside
 * their own interval, the worst by 3.55 MOA, every one at an RMS that passes
 * the half-minute gate. The exact case below entered the box at 2917 fps and
 * 0.229 against a rifle truly doing 2800 and 0.200, with three noiseless
 * anchors, and came back 1.21 MOA wrong at 1000 with an interval of 0.50.
 *
 * Two things fixed it and both are asserted: the coarse step is now declared
 * and the COUNT derives from the box (COARSE_STEP), and the fenced refinement
 * grids were replaced by a compass search that walks along the valley for as
 * far as the valley goes. Sparsify the coarse grid or put the fence back and
 * these fail. */
section('the coarse grid, and the basin it has to land in');
{
  const base = { sightHeightIn: 1.9, zeroYd: 100, densityRatio: 1, tempF: 59 };
  /* Rifle, box, anchors — every one of them a rifle whose true scales sit
   * strictly inside the declared box, so there is a right answer to find. */
  const CASES = [
    [2800, 0.200, 2917, 0.229, [200, 400, 800]],   // the reported case
    [2712, 0.259, 2800, 0.243, [200, 300, 600]],
    [2450, 0.243, 2800, 0.243, [200, 300, 600]],
    [3100, 0.310, 2980, 0.270, [100, 300, 600]],
    [2300, 0.190, 2400, 0.220, [200, 400, 800]],
    [3300, 0.400, 3150, 0.350, [200, 300, 600]],
    /* And four found by sweeping for the widest gap between a coarse grid of
     * ten steps and one of the declared step, because the six above are not
     * enough on their own: a compass search rescues most of what a sparse
     * coarse pass gets wrong, so the cases where it CANNOT are the ones that
     * hold the coarse density in place. On ten steps these come back at an RMS
     * of 0.10 to 0.13 — or, for the last one, not at all. */
    [2200, 0.400, 2112, 0.460, [200, 300, 600]],
    [2200, 0.350, 2112, 0.2975, [200, 400, 800]],
    [2400, 0.400, 2304, 0.340, [200, 400, 800]],
    [3400, 0.350, 3536, 0.2975, [100, 300, 600]],
  ];
  let worstRms = 0, worstErr = 0, worstRatio = 0, worstAt = '';
  for (const [mv, bc, boxMv, boxBc, set] of CASES) {
    const truth = S.integrate({ ...base, mv, bc, maxYd: 1300 });
    const anchors = set.map(yd => ({ yd, moa: S.dropToMoa(truth[yd].dropFt, yd) }));
    const fit = S.trueToDope(anchors, { ...base, mv: boxMv, bc: boxBc, horizonYd: 1200 });
    ok(fit && fit.trued === true,
       `${mv} fps / ${bc} BC against a ${boxMv} / ${boxBc} box trues (${fit.trued ? fit.rmsMoa.toFixed(4) + ' MOA RMS' : fit.reason})`);
    if (!fit.trued) continue;
    worstRms = Math.max(worstRms, fit.rmsMoa);
    const p = S.predict(fit, 1000);
    const actual = S.dropToMoa(truth[1000].dropFt, 1000);
    const e = Math.abs(p.moa - actual);
    if (e > worstErr) { worstErr = e; worstAt = `${mv}/${bc}`; }
    worstRatio = Math.max(worstRatio, e / p.ci);
  }
  /* Noiseless anchors from a rifle inside the box have an exact answer with an
   * RMS of zero, so anything much above zero means the search stopped
   * somewhere that is not it. The reported miss sat at 0.197. */
  ok(worstRms < 0.03,
     `and every one of them to ${worstRms.toFixed(4)} MOA RMS on noiseless anchors — a miss reads as 0.20`);
  ok(worstErr < 0.3,
     `never more than ${worstErr.toFixed(3)} MOA out at 1000 (worst ${worstAt}), against the 1.21 a fenced refinement gave`);
  ok(worstRatio < 0.5,
     `and at most ${worstRatio.toFixed(2)} of its own interval, not the 2.4× it was`);

  /* The mechanism, stated so it cannot be quietly undone: the coarse step is
   * the declared quantity, and the number of steps follows the box. Halve the
   * box and the count halves; widen it and the count grows. */
  const B = S.SEARCH_BOX;
  ok(S.COARSE_STEP.mv <= 0.016 + 1e-9 && S.COARSE_STEP.bc <= 0.05 + 1e-9,
     `the coarse step is at least as fine as it was before the box was widened (${S.COARSE_STEP.mv} × ${S.COARSE_STEP.bc})`);
  const mSteps = Math.ceil((B.mvHi - B.mvLo) / S.COARSE_STEP.mv);
  const bSteps = Math.ceil((B.bcHi - B.bcLo) / S.COARSE_STEP.bc);
  ok(mSteps >= 21 && bSteps >= 20,
     `which across this box is ${mSteps} × ${bSteps} coarse points, not the 10 × 10 that let it miss`);
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
       '...and the local search stayed inside the declared box rather than walking out of it');
  }
}

/* ══════════════ zeros that cannot separate velocity from drag ═══════════ */
/* canTrue asked for a hundred yards of spread, which is a yardage chosen for
 * being round, and it admits 100/200/300 — where the two things being fitted
 * are 0.9999 collinear. Raise the velocity, lower the BC, and the curve passes
 * through all three points again. The fit then slid along that ridge until it
 * hit a bound and the PIN check refused it, telling the shooter that "the
 * muzzle velocity or the BC this was started from is probably for a different
 * load" — about a rifle that was nothing of the sort, at an RMS of 0.030.
 * Measured: 7.8% of honest short-spread sets refused that way, against 0.12%
 * of well-spread ones. And the 92% that were accepted were worse off: 29% of
 * them missed their own 600 yd interval.
 *
 * Both halves are now the same quantity. The fit reports σ on bcScale — how
 * well these particular anchors pin the drag — which the interval is built
 * from and which the refusal is drawn on, at 0.8 (see DEGENERATE_BC_SIGMA for
 * the measurement that put it there). So the ones that are refused are refused
 * for the real reason and told what fixes it, and the ones that are accepted
 * carry the width their own geometry earns. */
section('zeros too close together to separate velocity from drag');
{
  const base = { sightHeightIn: 1.9, zeroYd: 100, densityRatio: 1, tempF: 59 };
  const truth = S.integrate({ ...base, mv: 3000, bc: 0.300, maxYd: 1200 });
  /* Rounded to the hundredth, the way the app stores a confirmed zero. */
  const dope = (yd) => ({ yd, moa: Math.round(S.dropToMoa(truth[yd].dropFt, yd) * 100) / 100 });
  const box = { ...base, mv: 3000, bc: 0.276, horizonYd: 1200 };   // BC 8% off, as a box is

  const short = S.trueToDope([100, 200, 300].map(dope), box);
  ok(short.trued === false,
     `zeros at 100/200/300 cannot separate the two and are refused (σ on bcScale ${short.sigmaBcScale.toFixed(2)})`);
  ok(short.pinned === false && /separate the muzzle velocity from the drag/.test(short.reason || ''),
     '...for that reason, and not by blaming the BC the shooter entered');
  ok(/further out/.test(short.reason || ''),
     `...naming the thing that would fix it ("${(short.reason || '').slice(-70)}")`);
  ok(short.fitRmsMoa < 0.1,
     `...while admitting the fit itself was fine (${num(short.fitRmsMoa, 4)} MOA RMS) — this is not a data error`);

  /* The same rifle, the same box, one zero further out: answerable. */
  const long = S.trueToDope([200, 300, 600].map(dope), box);
  ok(long.trued === true,
     `the same rifle with a 600 yd zero instead of the 300 trues (σ on bcScale ${long.sigmaBcScale.toFixed(2)})`);
  ok(long.sigmaBcScale < short.sigmaBcScale / 3,
     'and the drag is pinned several times better for it, which is what the refusal was about');

  /* σ falls monotonically as the shooter adds reach — the quantity the
   * refusal is drawn on behaves the way the advice says it does. */
  const sigmas = [[200, 300, 400], [200, 300, 600], [200, 400, 600, 800], [300, 600, 900]]
    .map(set => { const f = S.trueToDope(set.map(dope), box); return { set, s: f.sigmaBcScale }; });
  ok(sigmas.every((r, i) => i === 0 || r.s < sigmas[i - 1].s),
     `and it falls with every yard of reach added (${sigmas.map(r => r.s.toFixed(2)).join(' → ')})`);

  /* Two anchors, a hundred yards apart, is the case the old threshold was
   * written to allow. It is exactly determined — the curve goes through both
   * points whatever they say, the residual is zero, and nothing about the fit
   * is checkable from the fit. */
  const two = S.trueToDope([200, 300].map(dope), box);
  ok(two.trued === false,
     `two zeros a hundred yards apart are refused rather than fitted exactly and reported as trued (σ ${two.sigmaBcScale.toFixed(1)})`);
  const twoLong = S.trueToDope([200, 800].map(dope), box);
  ok(twoLong.trued === true,
     `but two zeros six hundred apart do separate them (σ ${twoLong.sigmaBcScale.toFixed(2)})`);
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
   * about the muzzle velocity, which is not where the problem is. THIS is the
   * case that isolates the residual gate: five anchors with the 500 two
   * minutes out, a fit that stays inside the box on every bound, and a
   * disagreement that exists only between the anchors themselves. Nothing but
   * the residual can see it, and `pinned === false` is the assertion that says
   * so — without the gate this fit is returned as trued.
   *
   * It used to be four anchors with the 450 three minutes out, and that case
   * stopped isolating anything once the fenced refinement grids were replaced
   * by a local search that can walk: the fit now slides to a bound on it and
   * the pin check fires too, so it no longer proves the gate is load-bearing.
   * The set below was chosen by sweeping anchor sets and error sizes for one
   * that trips the residual and no other gate. */
  const five = [200, 300, 400, 500, 600].map(yd => ({ yd, moa: S.dropToMoa(truth[yd].dropFt, yd) }));
  const one = five.map(a => a.yd === 500 ? { yd: 500, moa: a.moa + 2 } : a);
  const r1 = S.trueToDope(one, { ...base, mv: 2800, bc: 0.243, horizonYd: 1200 });
  ok(r1.trued === false && r1.pinned === false,
     'an anchor that disagrees without running the fit out of search space is still refused');
  ok(r1.worstAnchor && r1.worstAnchor.yd === 500,
     `...on the residual alone, and it is the 500 that is named (${num(r1.fitRmsMoa)} MOA RMS)`);

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
  /* `!(r.rmsMoa > 0) || Number.isFinite(r.rmsMoa)` used to stand here, and it
   * is satisfied by null, by 0, by −1 and by anything else that is not
   * Infinity — it discriminated against exactly one value. What the refusal
   * path actually promises is that when there is no fit there is no number:
   * rmsMoa is null, not Infinity, not zero (which would read as a perfect
   * fit), and not a plausible-looking small number. */
  ok(r.rmsMoa === null,
     `and reports no RMS at all rather than Infinity, or a zero that would read as a perfect fit (${r.rmsMoa})`);
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
  /* ── and a real one, in the shape the app actually produces ─────────────
   * The bound above used to be the only timing assertion, and it measured
   * three anchors with NO recorded temperature — the one shape SolverTab never
   * emits, because a session records its own temperature and the solver
   * integrates once per distinct set of conditions. Three anchors from three
   * sessions on three different days is three integrations per evaluation, not
   * one, and six anchors is six; at the time that assertion was written the
   * six-anchor case took 2.5 seconds and would have failed the 2000 ms bound
   * it was standing next to.
   *
   * So the shape measured here is the expensive one the app really makes: six
   * confirmed zeros, each from its own session, each with its own temperature.
   * Measured at 0.6 s on the machine this was written on, against 2.7 s for
   * the same case before `atYds` and the two-step grid; the bound is set where
   * a real regression trips it and ordinary machine-to-machine variation does
   * not. */
  const sixTemps = [100, 200, 300, 450, 600, 800].map((yd, i) => ({
    yd, moa: S.dropToMoa(S.integrate({ ...base, bc: 0.243, maxYd: 900 })[yd].dropFt, yd),
    tempF: [59, 44, 86, 71, 38, 95][i],
    densityRatio: S.airDensityRatio({ tempF: [59, 44, 86, 71, 38, 95][i], pressureInHg: 29.92 }),
  }));
  const groups = new Set(sixTemps.map(a => `${a.densityRatio}|${a.tempF}`)).size;
  ok(groups === 6, `six sessions at six temperatures really are ${groups} separate atmospheres to integrate`);
  const t1 = Date.now();
  const six = S.trueToDope(sixTemps, { ...base, bc: 0.243, horizonYd: 1200 });
  const sixMs = Date.now() - t1;
  ok(sixMs < 2000,
     `six anchors at six temperatures — the app's own worst shape — true in ${sixMs} ms, not the 2.7 s they took`);
  ok(six.trued === true, `...and true (${six.rmsMoa.toFixed(3)} MOA RMS)`);

  /* And the cheap shape, which is what the old assertion measured, kept so a
   * regression that only shows up there is still caught. */
  const t0 = Date.now();
  S.trueToDope(anchors.map(a => ({ ...a, moa: a.moa })), { ...base, bc: 0.243, horizonYd: 1200 });
  ok(Date.now() - t0 < 2000, `and three anchors sharing one atmosphere in ${Date.now() - t0} ms`);
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

  /* ── the same rounding, one step earlier ────────────────────────────────
   * predict() is the second half of this. The first is trueToDope, which
   * rounds the ANCHOR yardages once, on the way in, for the same reason: the
   * trajectory table is indexed per whole yard, so an anchor at 200.4 yd looks
   * up table[200.4], finds nothing, and every candidate in the search comes
   * back with an SSE of Infinity. The fit then refuses — and refuses by
   * naming the muzzle velocity, the BC and the zero distance, none of which is
   * the problem. A fractional rangeYards is not exotic: it is what a metric
   * range entered in yards produces.
   *
   * That half had three assertions covering predict and none covering
   * trueToDope. These are the ones that fail without the rounding. */
  const fracAnchors = [{ yd: 200.4, moa: at(200).moa }, { yd: 299.6, moa: at(300).moa },
                       { yd: 600.35, moa: at(600).moa }];
  const fracFit = S.trueToDope(fracAnchors, base);
  ok(fracFit && fracFit.trued === true,
     `anchors at fractional yardages still true (${fracFit.trued ? fracFit.rmsMoa.toFixed(4) + ' MOA RMS' : fracFit.reason})`);
  ok(fracFit.trued && fracFit.mvScale === trued.mvScale && fracFit.bcScale === trued.bcScale,
     'to the same velocity and drag as the whole-yard anchors, because they are the same anchors');
  ok(fracFit.anchors.every(a => Number.isInteger(a.yd)),
     `and it says which whole yards it read them at (${fracFit.anchors.map(a => a.yd).join(', ')})`);
  ok(fracFit.trued && S.predict(fracFit, 1000).moa === S.predict(trued, 1000).moa,
     '...so the prediction is identical rather than a refusal blaming the muzzle velocity');

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

/* ═══════════════ the interval, measured rather than remembered ══════════ */
/* The comment on predict() used to claim 97.5% coverage over 200 synthetic
 * rifles, and that measurement predated the widening of the search box, the
 * replacement of the search, and the interval's own rewrite. A coverage figure
 * stated in a comment and measured nowhere goes stale silently, and this one
 * had: on the code it was quoted against, five predictions in seventy-two fell
 * outside their own interval, the worst by 1.48 MOA.
 *
 * So it is measured here. This is a small standing coverage run — small enough
 * to live in a test suite, big enough to move if the interval is broken — over
 * rifles the solver has not seen, with reading error of exactly the size
 * READ_MOA claims a confirmed zero carries. The full run behind the numbers in
 * the source comment is the same shape with sixty times as many rifles.
 *
 * What it is really guarding is the FORM of the interval, not its constants.
 * Before it was built on the anchors' leverage it was built on rmsMoa, which
 * for a two-anchor fit is zero by construction — the curve goes through both
 * points whatever they say — so the interval collapsed to its floor exactly
 * where the answer was least determined. */
section('the interval covers what it says it covers');
{
  const base = { sightHeightIn: 1.9, zeroYd: 100, densityRatio: 1, tempF: 59 };
  /* A deterministic gaussian, so this run is the same run every time. */
  let st = 20260902;
  const rnd = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = rnd();
    while (!v) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  let fits = 0, refused = 0, rows = 0, outside = 0, worstRatio = 0, worstErr = 0;
  for (const [mv, bc] of [[2450, 0.21], [2750, 0.26], [3050, 0.33]]) {
    const truth = S.integrate({ ...base, mv, bc, maxYd: 1250 });
    /* The sets have to include the shapes where the interval is HARD, or the
     * coverage number is a measurement of the easy ones. Two anchors is the
     * hardest: exactly determined, no residual, nothing about the fit
     * checkable from the fit. Short three-anchor sets that survive the
     * degeneracy gate are next. Both are in here. */
    for (const set of [[200, 300, 600], [100, 300, 600], [200, 400, 800], [300, 600, 900],
                       [200, 300, 450], [200, 700], [200, 800], [300, 900], [100, 600]]) {
      for (const [me, be] of [[-0.05, -0.13], [0.05, 0.13]]) {
        const anchors = set.map(yd => ({
          yd, moa: Math.round((S.dropToMoa(truth[yd].dropFt, yd) + gauss() * S.READ_MOA) * 100) / 100,
        }));
        const fit = S.trueToDope(anchors,
          { ...base, mv: mv * (1 + me), bc: bc * (1 + be), horizonYd: 1200 });
        fits++;
        if (!fit.trued) { refused++; continue; }
        for (const T of [500, 800, 1000, 1200]) {
          const p = S.predict(fit, T);
          if (!p || !truth[T]) continue;
          const e = Math.abs(p.moa - S.dropToMoa(truth[T].dropFt, T));
          rows++;
          worstErr = Math.max(worstErr, e);
          worstRatio = Math.max(worstRatio, e / p.ci);
          if (e > p.ci) outside++;
        }
      }
    }
  }
  const coverage = 100 * (1 - outside / rows);
  ok(rows > 80, `${fits} fits, ${refused} refused, ${rows} predictions checked against their own truth`);
  ok(coverage >= 95,
     `${coverage.toFixed(1)}% of them landed inside their own interval (${outside} of ${rows} outside)`);
  ok(worstRatio < 2.5,
     `and the worst was ${worstRatio.toFixed(2)}× its interval (${worstErr.toFixed(2)} MOA), which is what "roughly 2σ" has to mean`);
  /* The intervals must not be passing by being useless. A come-up at 1000 is
   * thirty-odd minutes; an interval of a hundred covers everything and says
   * nothing. */
  let widest = 0, typical = [];
  for (const [mv, bc] of [[2750, 0.26]]) {
    const truth = S.integrate({ ...base, mv, bc, maxYd: 1250 });
    for (const set of [[200, 300, 600], [200, 400, 800], [300, 600, 900]]) {
      const fit = S.trueToDope(set.map(yd => ({ yd, moa: S.dropToMoa(truth[yd].dropFt, yd) })),
        { ...base, mv: mv * 1.03, bc: bc * 0.92, horizonYd: 1200 });
      const p = S.predict(fit, 1000);
      widest = Math.max(widest, p.ci); typical.push(p.ci);
    }
  }
  ok(widest < 8,
     `and a three-anchor fit's interval at 1000 stays a usable number (±${typical.map(c => c.toFixed(1)).join(', ±')} MOA)`);

  /* The mechanism, asserted directly: reach narrows the interval and a second
   * anchor at the same reach narrows it further. Under the old rmsMoa
   * interval, none of this was true — a two-anchor fit had the SMALLEST
   * interval of the three, because it was the one with no residual. */
  const truth = S.integrate({ ...base, mv: 2750, bc: 0.26, maxYd: 1250 });
  const box = { ...base, mv: 2830, bc: 0.24, horizonYd: 1200 };
  const dope = (yd) => ({ yd, moa: S.dropToMoa(truth[yd].dropFt, yd) });
  const twoWide = S.trueToDope([200, 800].map(dope), box);
  const threeWide = S.trueToDope([200, 500, 800].map(dope), box);
  const threeNear = S.trueToDope([200, 300, 400].map(dope), box);
  ok(S.predict(threeWide, 1000).ci < S.predict(twoWide, 1000).ci,
     `a third anchor narrows the interval (±${S.predict(threeWide, 1000).ci.toFixed(2)} against ±${S.predict(twoWide, 1000).ci.toFixed(2)}) — under the residual interval it did the opposite`);
  ok(!threeNear.trued || S.predict(threeNear, 1000).ci > S.predict(threeWide, 1000).ci,
     'and three anchors bunched at short range are never worth more than three spread out');
}

/* ══════════════════════════ position offsets, learned rather than assumed */
/* A confirmed zero is per position because it is not the same zero: the cant
 * differs, the cheek weld moves, and it shows up as a couple of minutes. Every
 * shooter's are their own, so they are measured from their own DOPE. */
section('position offsets');
{
  /* Every fixture in this section carries a sessionId and a date, because the
   * caller — SolverTab — builds exactly one cell per session and always sets
   * both. A fixture that omits them is testing a shape the app never produces,
   * which is how the deduplication assertion below came to pass while the
   * deduplication itself never once fired. */
  const cells = [
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.0, wind: 0.0,  sessionId: 'a1', date: '2026-04-01' },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Standing', elev: 2.5, wind: -0.75, sessionId: 'a2', date: '2026-04-02' },
    { rifleId: 'r1', location: 'home', yards: 300, position: 'Prone',    elev: 4.5, wind: 0.25, sessionId: 'a3', date: '2026-04-03' },
    { rifleId: 'r1', location: 'home', yards: 300, position: 'Standing', elev: 5.1, wind: -0.5, sessionId: 'a4', date: '2026-04-04' },
    { rifleId: 'r1', location: 'home', yards: 600, position: 'Prone',    elev: 14.0, wind: 0.0, sessionId: 'a5', date: '2026-04-05' },
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

  /* ── the same shooting twice is one observation ─────────────────────────
   * n counted ordered pairings, so a duplicated entry did not just inflate n,
   * it collapsed the spread: two identical Prone rows and one Standing at the
   * same distance reported {n: 2, elevMoa: 0.5, elevSd: 0} — two independent
   * observations in perfect agreement, which is the most confidence-inspiring
   * thing this function can produce, out of one string logged twice.
   *
   * THE FIXTURE IS THE POINT. The dedupe keyed on the session id where a cell
   * had one, and SolverTab always sets one — so every cell was unique by
   * construction and the dedupe never fired at all. It passed only because
   * this fixture left sessionId off, which is a shape the app does not
   * produce. The duplicate that actually happens is one string reaching here
   * as TWO SESSIONS, with two different ids, from a double-logged range trip
   * or a restore run twice; so that is what is written here now, and the
   * assertion fails without the fix rather than being unable to. */
  const dup = S.positionOffsets([
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.0, wind: 0.0, sessionId: 's1', date: '2026-05-01' },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.0, wind: 0.0, sessionId: 's2', date: '2026-05-01' },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Standing', elev: 2.5, wind: 0.0, sessionId: 's3', date: '2026-05-01' },
  ]);
  const d = dup.find(o => o.from === 'Prone' && o.to === 'Standing');
  ok(d.n === 1, `one string logged as two sessions is one observation, not two (n = ${d.n})`);
  ok(d.elevSd === null,
     'and reports no spread at all rather than a spread of zero, which would read as perfect agreement');

  /* Two genuinely different Prone strings against one Standing string are two
   * observations, and must survive the deduplication — different sessions AND
   * different days, which is where the independent evidence actually is. */
  const twice = S.positionOffsets([
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.0, wind: 0.0, sessionId: 's1', date: '2026-05-01' },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.2, wind: 0.0, sessionId: 's2', date: '2026-06-01' },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Standing', elev: 2.5, wind: 0.0, sessionId: 's3', date: '2026-06-02' },
  ]).find(o => o.from === 'Prone' && o.to === 'Standing');
  ok(twice.n === 2 && twice.elevSd > 0,
     `but two different Prone strings against one Standing really are two observations (n = ${twice.n}, sd ${twice.elevSd.toFixed(2)})`);

  /* Same day, same session id absent entirely, same everything: still one
   * shooting. The identity has to work on the rows the app produces AND on the
   * rows an import or an older backup produces. */
  const noIds = S.positionOffsets([
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.0, wind: 0.0, date: '2026-05-01' },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Prone',    elev: 2.0, wind: 0.0, date: '2026-05-01' },
    { rifleId: 'r1', location: 'home', yards: 200, position: 'Standing', elev: 2.5, wind: 0.0, date: '2026-05-01' },
  ]).find(o => o.from === 'Prone' && o.to === 'Standing');
  ok(noIds.n === 1 && noIds.elevSd === null,
     `and the same with no session ids at all (n = ${noIds.n})`);

  /* The same string under two session ids, at BOTH distances, is what the
   * commit's own example looked like — and it must not turn one pairing per
   * distance into two per distance. */
  const dupBoth = S.positionOffsets([
    ...cells,
    { ...cells[0], sessionId: 'dup-a' },
    { ...cells[2], sessionId: 'dup-b' },
  ]).find(o => o.from === 'Prone' && o.to === 'Standing');
  ok(dupBoth.n === 2 && Math.abs(dupBoth.elevMoa - 0.55) < 0.01,
     `duplicating both Prone strings under new session ids leaves two observations, not four (n = ${dupBoth.n})`);

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
