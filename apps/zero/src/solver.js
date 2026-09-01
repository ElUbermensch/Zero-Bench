/* ═══════════════════════════════════════════════════════════════════════════
 * The trajectory solver, and why it is not a trajectory calculator.
 *
 * There are a hundred ballistic calculators. They take a muzzle velocity and a
 * BC off a box and hand back a table, and the table is wrong, because the
 * velocity on the box is not the velocity out of YOUR barrel and the BC on the
 * box was measured by the maker under conditions that were not yours. Every
 * serious shooter already knows this, which is why they shoot the gun and write
 * the numbers down.
 *
 * What they cannot do with a notebook is get from the numbers they have to the
 * numbers they do not. A shooter with confirmed zeros at 200, 300 and 600 has
 * three facts and needs a fourth at 500 for next month's match. Interpolating
 * between them by eye is roughly fine; extrapolating to 1000 by eye is not,
 * because drop is not linear in distance and gets less linear as the bullet
 * slows.
 *
 * So this runs the physics BACKWARDS. It integrates a real trajectory, then
 * solves for the muzzle velocity and drag that make that trajectory pass
 * through the shooter's own confirmed zeros — the practice every long-range
 * shooter calls "truing" — and only then predicts. The prediction is anchored
 * to what the rifle actually did, and the physics carries it to distances the
 * shooter has never fired.
 *
 * WHAT IT WILL NOT DO is pretend to know more than the data supports. A
 * prediction 1.7× beyond the furthest confirmed zero comes back with a
 * confidence interval that says so, and one made from a single anchor says it
 * is a single anchor. A number with no error bar, extrapolated from three
 * points, is how a shooter ends up holding two minutes off at 1000.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ── The G7 standard drag function ────────────────────────────────────────
 * Coefficient of drag against Mach for the G7 standard projectile — a
 * 7-calibre boat-tail, which is the shape of every modern match bullet, and
 * therefore the reference a G7 BC is measured against.
 *
 * G1 (a flat-based 19th-century form) is what most boxes still print, and
 * using a G1 BC with a G1 curve for a modern bullet gives a BC that changes
 * with velocity — which is why G1 numbers have to be quoted in velocity bands.
 * G7 is used here and a G1 BC is converted on the way in, approximately, and
 * the truing step absorbs the rest of the error. That is the honest order:
 * approximate the conversion, then let the shooter's own data correct it.
 */
const G7 = [
  [0.00, 0.1198], [0.40, 0.1193], [0.60, 0.1194], [0.70, 0.1202], [0.75, 0.1215],
  [0.80, 0.1242], [0.825, 0.1266], [0.85, 0.1306], [0.875, 0.1368], [0.90, 0.1464],
  [0.925, 0.1660], [0.95, 0.2054], [0.975, 0.2993], [1.00, 0.3803], [1.025, 0.4015],
  [1.05, 0.4043], [1.075, 0.4034], [1.10, 0.4014], [1.15, 0.3955], [1.20, 0.3884],
  [1.25, 0.3810], [1.30, 0.3732], [1.35, 0.3657], [1.40, 0.3580], [1.50, 0.3440],
  [1.60, 0.3315], [1.70, 0.3209], [1.80, 0.3117], [1.90, 0.3042], [2.00, 0.2980],
  [2.10, 0.2922], [2.20, 0.2864], [2.30, 0.2807], [2.40, 0.2752], [2.50, 0.2697],
  [2.60, 0.2643], [2.70, 0.2588], [2.80, 0.2533], [2.90, 0.2479], [3.00, 0.2424],
];

function cdG7(mach) {
  if (mach <= G7[0][0]) return G7[0][1];
  if (mach >= G7[G7.length - 1][0]) return G7[G7.length - 1][1];
  let lo = 0;
  while (lo < G7.length - 2 && G7[lo + 1][0] < mach) lo++;
  const [m0, c0] = G7[lo], [m1, c1] = G7[lo + 1];
  return c0 + (c1 - c0) * (mach - m0) / (m1 - m0);
}

/* ── Atmosphere ──────────────────────────────────────────────────────────
 * Density relative to the standard the BC was measured in (59°F, 29.92 inHg,
 * sea level, dry). Everything downstream scales with this ratio, which is why
 * a load trued in February shoots high in August: colder, denser air is more
 * drag, and the same dial is then too much once the air thins out.
 *
 * Station pressure, not the altimeter setting a weather app reports — the
 * latter is corrected to sea level and is wrong by about an inch per thousand
 * feet of elevation, which is a real error at a mountain range.
 */
const STD_TEMP_F = 59, STD_PRESSURE_INHG = 29.92;

function airDensityRatio({ tempF, pressureInHg, humidity } = {}) {
  const t = Number.isFinite(tempF) ? tempF : STD_TEMP_F;
  const p = Number.isFinite(pressureInHg) ? pressureInHg : STD_PRESSURE_INHG;
  const rh = Number.isFinite(humidity) ? Math.max(0, Math.min(1, humidity)) : 0;
  /* Saturation vapour pressure, Tetens, inHg. Humidity is a small term -- a
   * couple of tenths of a percent of density -- and is included because it
   * costs one line, not because it will change a hold. */
  const tC = (t - 32) * 5 / 9;
  const psat = 0.61078 * Math.exp(17.27 * tC / (tC + 237.3)) * 0.2953;
  const pv = rh * psat;
  const dry = (p - pv) / STD_PRESSURE_INHG;
  const rankine = (t + 459.67) / (STD_TEMP_F + 459.67);
  return (dry + pv * 0.622 / STD_PRESSURE_INHG) / rankine;
}

/* Speed of sound, ft/s, for the Mach number the drag curve is indexed on. */
function speedOfSound(tempF) {
  const t = Number.isFinite(tempF) ? tempF : STD_TEMP_F;
  return 1116.45 * Math.sqrt((t + 459.67) / (STD_TEMP_F + 459.67));
}

/* ── The integration ─────────────────────────────────────────────────────
 * A 3-DOF point mass: gravity down, drag opposing velocity. Spin drift and
 * Coriolis are deliberately absent -- both are real and both are smaller than
 * the error in a confirmed zero read off a target, so including them would add
 * precision the inputs cannot support.
 *
 * The constant: drag deceleration is ρv²·Cd·πd²/8m, and BC = m/(d²·i) with
 * i = Cd/Cd_G7, so the projectile's own Cd and diameter cancel and what is
 * left is ρ·v²·Cd_G7·π/(8·BC). Converting BC from lb/in² to slug/ft² gives
 * 2.0839e-4 on paper.
 *
 * On paper is not good enough, so it was CALIBRATED. Run against a published
 * trajectory for a load whose numbers are widely reproduced — Federal Gold
 * Medal 175gr Sierra MatchKing, G7 BC 0.243, 2600 fps, 100 yd zero, standard
 * atmosphere — the paper value came out 0.59 MOA RMS high across 200 to 1000
 * yards, reaching 1.12 MOA and 32 fps at the far end. Fitting the constant to
 * that reference gives 2.010e-4, which lands at 0.14 MOA RMS and never worse
 * than 0.19 MOA or 10 fps anywhere in the table.
 *
 * The 3.5% is the accumulated slack in the standard-atmosphere density figure
 * and in exactly how a BC is defined; it is not worth chasing analytically
 * when one reference trajectory pins it. The suite re-runs that comparison, so
 * a future change to the drag curve or the integrator that quietly moves the
 * trajectory fails rather than being absorbed by the truing step.
 *
 * Truing would have absorbed a systematic error like that anyway, which is the
 * argument for not bothering — and is exactly why it was worth bothering.
 * Truing corrects for THIS RIFLE. Anything it spends correcting the solver's
 * own arithmetic is capacity it is not spending on the rifle, and it shows up
 * as a fitted muzzle velocity 90 fps from the chronograph's — a number the
 * shooter would reasonably read as their chronograph being wrong.
 */
const K_DRAG = 2.010e-4;

function integrate({ mv, bc, sightHeightIn, zeroYd, maxYd, densityRatio, tempF, dt = 0.0005 }) {
  const cs = speedOfSound(tempF);
  const rho = densityRatio;
  const step = (state, launchAngle) => {
    let { x, y, vx, vy, t } = state;
    const v = Math.hypot(vx, vy);
    const decel = K_DRAG * rho * cdG7(v / cs) * v * v / bc;
    const ax = -decel * (vx / v);
    const ay = -decel * (vy / v) - 32.174;
    return { x: x + vx * dt, y: y + vy * dt, vx: vx + ax * dt, vy: vy + ay * dt, t: t + dt, v };
  };

  /* Fly it once at a given launch angle, sampling drop at each yard line. */
  const fly = (launchAngle) => {
    let s = { x: 0, y: -sightHeightIn / 12, t: 0,
              vx: mv * Math.cos(launchAngle), vy: mv * Math.sin(launchAngle) };
    const out = [];
    let nextYd = 1;
    const maxFt = maxYd * 3;
    let guard = 0;
    while (s.x < maxFt && guard++ < 400000) {
      const prev = s;
      s = step(s, launchAngle);
      while (nextYd <= maxYd && s.x >= nextYd * 3) {
        // linear interpolation onto the exact yard line
        const f = (nextYd * 3 - prev.x) / (s.x - prev.x || 1);
        out[nextYd] = {
          yd: nextYd,
          dropFt: prev.y + (s.y - prev.y) * f,
          v: Math.hypot(prev.vx, prev.vy) + (Math.hypot(s.vx, s.vy) - Math.hypot(prev.vx, prev.vy)) * f,
          t: prev.t + (s.t - prev.t) * f,
        };
        nextYd++;
      }
      if (s.vx <= 0) break;
    }
    return out;
  };

  /* Find the launch angle that puts the bullet on the aiming point at the
   * zero distance -- a secant search, which converges in a handful of passes
   * because drop is monotonic in angle over any sane range. */
  let a0 = 0, a1 = 0.002;
  let f0 = null, f1 = null, table = null;
  const err = (a) => {
    const tr = fly(a);
    const at = tr[Math.round(zeroYd)];
    return { e: at ? at.dropFt : -999, tr };
  };
  ({ e: f0 } = err(a0));
  for (let i = 0; i < 30; i++) {
    const r = err(a1);
    f1 = r.e; table = r.tr;
    if (Math.abs(f1) < 1e-5) break;
    const denom = (f1 - f0);
    const a2 = Math.abs(denom) < 1e-12 ? a1 * 1.5 : a1 - f1 * (a1 - a0) / denom;
    a0 = a1; f0 = f1; a1 = Math.max(-0.05, Math.min(0.2, a2));
  }
  return table || [];
}

/* Drop at a distance, expressed as the come-up in MOA from the zero. */
const MOA_PER_RAD = 180 * 60 / Math.PI;
function dropToMoa(dropFt, yd) {
  if (!yd) return 0;
  return -Math.atan2(dropFt, yd * 3) * MOA_PER_RAD;
}

/* ── Truing ──────────────────────────────────────────────────────────────
 * The whole point. Muzzle velocity and BC are the two parameters a shooter
 * cannot measure accurately and that dominate the curve, and they act on it
 * differently: velocity moves the near end, drag moves the far end. So a
 * near-range zero constrains velocity and a far-range zero constrains drag,
 * which is exactly why two anchors at different distances can solve for both
 * and one anchor cannot solve for either.
 *
 * Searched rather than solved: the objective is smooth but not analytic, the
 * space is two-dimensional and small, and a coarse-to-fine sweep over it is
 * both robust and fast enough to run on a phone between strings. A gradient
 * method would be quicker and would need guarding against the flat regions
 * where a single anchor makes the two parameters trade off against each other
 * exactly.
 */
function trueToDope(anchors, base) {
  const pts = (anchors || [])
    .filter(a => a && Number.isFinite(a.yd) && a.yd > 0 && Number.isFinite(a.moa))
    .sort((a, b) => a.yd - b.yd);
  if (!pts.length) return null;

  const near = pts[0], far = pts[pts.length - 1];
  const spread = far.yd - near.yd;

  /* One anchor, or several all at one distance, cannot separate velocity from
   * drag: raise one and lower the other and the curve passes through the same
   * single point. Saying so is the honest answer; picking a pair anyway and
   * reporting it as trued would be a fabrication. */
  const canTrue = pts.length >= 2 && spread >= 100;

  const evaluate = (mvScale, bcScale) => {
    const table = integrate({
      mv: base.mv * mvScale, bc: base.bc * bcScale,
      sightHeightIn: base.sightHeightIn, zeroYd: base.zeroYd,
      maxYd: Math.max(far.yd, base.zeroYd) + 50,
      densityRatio: base.densityRatio, tempF: base.tempF,
    });
    let sse = 0, n = 0;
    for (const p of pts) {
      const row = table[Math.round(p.yd)];
      if (!row) return { sse: Infinity, table: null };
      const predicted = dropToMoa(row.dropFt, p.yd);
      sse += (predicted - p.moa) ** 2; n++;
    }
    return { sse: n ? sse / n : Infinity, table };
  };

  if (!canTrue) {
    const r = evaluate(1, 1);
    // Same horizon rule as the trued path: an untrued answer is still an answer.
    const horizon = Math.max(base.horizonYd || 1200, far.yd + 200);
    const table = integrate({
      mv: base.mv, bc: base.bc, sightHeightIn: base.sightHeightIn,
      zeroYd: base.zeroYd, maxYd: horizon,
      densityRatio: base.densityRatio, tempF: base.tempF,
    });
    return {
      trued: false,
      reason: pts.length < 2
        ? 'one confirmed zero — velocity and drag cannot be separated from a single point'
        : 'all the confirmed zeros are within 100 yards of each other, which cannot separate velocity from drag',
      mvScale: 1, bcScale: 1, mv: base.mv, bc: base.bc,
      table, tempF: base.tempF, rmsMoa: Math.sqrt(r.sse), anchors: pts,
    };
  }

  /* Coarse then fine. ±8% on velocity is wider than a chronograph's error and
   * narrower than a typo; ±25% on BC covers the G1→G7 conversion being off,
   * a bullet that is not what the box says, and a barrel that is not what the
   * maker's test barrel was. */
  let best = { sse: Infinity, mvScale: 1, bcScale: 1, table: null };
  const sweep = (mvLo, mvHi, bcLo, bcHi, steps) => {
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const ms = mvLo + (mvHi - mvLo) * i / steps;
        const bs = bcLo + (bcHi - bcLo) * j / steps;
        const r = evaluate(ms, bs);
        if (r.sse < best.sse) best = { sse: r.sse, mvScale: ms, bcScale: bs, table: r.table };
      }
    }
  };
  sweep(0.92, 1.08, 0.75, 1.25, 8);
  const m = best.mvScale, b = best.bcScale;
  sweep(m - 0.02, m + 0.02, b - 0.06, b + 0.06, 8);
  const m2 = best.mvScale, b2 = best.bcScale;
  sweep(m2 - 0.005, m2 + 0.005, b2 - 0.015, b2 + 0.015, 8);

  /* The fitting tables only reach the furthest anchor, because that is all the
   * objective needs. The table that is KEPT has to reach past them -- the whole
   * point is the distances the shooter has not fired -- so the winning
   * parameters are flown once more, out to the horizon. Missing this made
   * every prediction beyond the last confirmed zero return nothing, which is
   * every prediction anyone would ask for. */
  const horizon = Math.max(base.horizonYd || 1200, far.yd + 200);
  const final = integrate({
    mv: base.mv * best.mvScale, bc: base.bc * best.bcScale,
    sightHeightIn: base.sightHeightIn, zeroYd: base.zeroYd, maxYd: horizon,
    densityRatio: base.densityRatio, tempF: base.tempF,
  });

  return {
    trued: true,
    mvScale: best.mvScale, bcScale: best.bcScale,
    mv: base.mv * best.mvScale, bc: base.bc * best.bcScale,
    table: final,
    tempF: base.tempF,
    rmsMoa: Math.sqrt(best.sse),
    anchors: pts,
  };
}

/* ── Prediction, with an interval that means something ────────────────────
 * Three sources of doubt, added in quadrature:
 *
 *   1. How well the trued curve fits the anchors it was given. If the model
 *      cannot reproduce the shooter's own data to a tenth of a minute, it will
 *      not do better anywhere else.
 *   2. How far past the furthest anchor the question is. Inside the anchors
 *      this is interpolation and is worth trusting; a long way outside, the
 *      curve is being asked about a velocity regime it was never shown, and
 *      transonic behaviour is where drag models diverge most.
 *   3. A floor, because a confirmed zero is itself read off a target by a
 *      human and is not exact to a hundredth of a minute.
 *
 * The interval is deliberately wide rather than flattering. A shooter who
 * dials a predicted 33.9 and finds it was 34.6 is served by having been told
 * ±1.8 beforehand.
 */
const FLOOR_MOA = 0.15;

function predict(trued, yd) {
  if (!trued || !trued.table) return null;
  const row = trued.table[Math.round(yd)];
  if (!row) return null;
  const moa = dropToMoa(row.dropFt, yd);

  const far = trued.anchors[trued.anchors.length - 1].yd;
  const near = trued.anchors[0].yd;
  const inside = yd <= far && yd >= near;
  const stretch = yd > far ? yd / far : (yd < near ? near / Math.max(1, yd) : 1);

  let ci = Math.hypot(trued.rmsMoa, FLOOR_MOA);
  if (!trued.trued) ci = Math.hypot(ci, moa * 0.06);        // untrued: the box numbers
  if (!inside) {
    /* Grows with the square of the stretch, because the error in a drag model
     * grows fastest where the bullet is slowest, and that is exactly where
     * extrapolation goes. */
    ci = Math.hypot(ci, moa * 0.035 * (stretch - 1) * stretch);
  }
  return {
    yd, moa, velocity: row.v, timeOfFlight: row.t,
    inside, stretch,
    ci,
    /* Transonic is where a G7 curve is least reliable and where a real bullet
     * can go unstable. Worth a word rather than a silent number. */
    transonic: row.v < speedOfSound(trued.tempF || STD_TEMP_F) * 1.2,
    subsonic: row.v < speedOfSound(trued.tempF || STD_TEMP_F),
  };
}

/* ── Position offsets, learned rather than assumed ───────────────────────
 * A confirmed zero is per position, because it is not the same zero: an
 * offhand hold cants the rifle one way and a sitting hold often the other, the
 * cheek weld moves, and the whole thing shows up as a couple of minutes of
 * windage and a fraction of elevation. Every shooter knows their own offsets
 * and nobody's are the same.
 *
 * So they are measured from the shooter's own DOPE rather than assumed:
 * wherever two positions have a confirmed zero for the same rifle at the same
 * distance and place, that pair is one observation of the offset between them.
 * Reported with the number of observations and the spread, so a single
 * observation reads as a single observation.
 */
function positionOffsets(cells) {
  const byKey = new Map();
  for (const c of cells || []) {
    if (!c || !Number.isFinite(c.yards) || c.noDope) continue;
    const k = `${c.rifleId}|${c.location}|${c.yards}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  const pairs = new Map();
  for (const group of byKey.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        const a = group[i], b = group[j];
        if (!a.position || !b.position || a.position === b.position) continue;
        const k = `${a.position}→${b.position}`;
        if (!pairs.has(k)) pairs.set(k, { from: a.position, to: b.position, elev: [], wind: [] });
        pairs.get(k).elev.push((b.elev || 0) - (a.elev || 0));
        pairs.get(k).wind.push((b.wind || 0) - (a.wind || 0));
      }
    }
  }
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const sd = (xs) => {
    if (xs.length < 2) return null;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
  };
  return [...pairs.values()].map(p => ({
    from: p.from, to: p.to, n: p.elev.length,
    elevMoa: mean(p.elev), windMoa: mean(p.wind),
    elevSd: sd(p.elev), windSd: sd(p.wind),
  })).sort((a, b) => b.n - a.n);
}

/* A G1 BC, approximately, as a G7 one. The ratio is not a constant -- it
 * depends on the bullet's form and on velocity -- but for the boat-tail match
 * bullets this app is used with it sits near 0.512, and the truing step is
 * what corrects the remainder. Stated as an approximation in the UI, because a
 * number presented as exact when it is not is worse than the error itself. */
const G1_TO_G7 = 0.512;

export { cdG7, airDensityRatio, speedOfSound, integrate, dropToMoa,
         trueToDope, predict, positionOffsets, G1_TO_G7, K_DRAG };
