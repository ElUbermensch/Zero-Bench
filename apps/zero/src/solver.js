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
 * The constant, derived rather than fitted:
 *
 *   drag deceleration  a = ρ·v²·Cd·πd²/(8m)
 *   ballistic coeff.  BC = m/(d²·i),  i = Cd/Cd_G7
 *
 * so the projectile's own Cd and diameter cancel and what is left is
 *
 *   a = (ρ · π/8) · Cd_G7 · v² / BC
 *
 * with BC in the units it is universally quoted in, lb/in². Converting that to
 * the slug/ft² the rest of the expression is in needs lb→slug (divide by
 * g = 32.174 lbm/slug) and in²→ft² (divide by 144), i.e. BC[slug/ft²] =
 * BC[lb/in²] · 144/32.174 — so the reciprocal, 32.174/144, multiplies through.
 * g appears only as that units conversion and cancels no further:
 *
 *   K = ρ_std · (π/8) · (32.174/144)
 *     = 0.00237689 slug/ft³ × 0.3926991 × 0.2234306
 *     = 2.0855e-4
 *
 * This shipped for a while as 2.010e-4 — 3.6% low — because it had been FITTED
 * to a published trajectory table (Federal Gold Medal 175gr SMK, G7 BC 0.243,
 * 2600 fps) rather than derived. That was a mistake, and the tell was that
 * fitting K to the same reference against drop gave 2.010e-4 while fitting it
 * against retained velocity gave 2.027e-4. A single well-posed physical
 * constant cannot be 0.85% apart depending on which column of one table you
 * fit it to; the spread means the table's stated BC of 0.243 is not the BC the
 * table was computed with, and the fit was absorbing the table's error into a
 * constant named as if it were physics.
 *
 * It matters less than it looks: K, ρ and 1/BC are exactly degenerate in the
 * expression above — integrate(bc=0.243, ρ=1.0) and integrate(bc=0.30375,
 * ρ=1.25) return bit-identical drop — so on the TRUED path the bcScale simply
 * absorbs it and nothing moves. It is the UNTRUED path, the shooter who has
 * not yet confirmed a zero and is looking at box numbers, that was 1.26 MOA
 * out at 1000. That shooter is the one least able to catch it.
 *
 * The reference table is still in the suite, but it is now used the only way a
 * table of someone else's numbers legitimately can be: the solver is trued TO
 * it, and the test asserts the recovered BC is close to the table's stated one.
 * That checks the drag model has the right SHAPE, which is what the table can
 * evidence, rather than asserting agreement with a number the table may itself
 * have got wrong.
 */
const K_DRAG = 2.0855e-4;

/* ── Bounds on what will be integrated at all ─────────────────────────────
 * A G7 BC below about 0.02 is not a bullet, it is a typo or a unit mix-up, and
 * it is also where the integrator becomes pathological: the drag is so high
 * the projectile never reaches the far end, the step guard runs to its limit
 * on every one of the ~300 evaluations a fit makes, and the app freezes for
 * half a minute on a phone. Measured before this bound existed: bc 0.01 took
 * 25.2 s to true and bc 0.005 took 33.6 s. Both now return nothing, instantly.
 *
 * The flight-time cap is the other half of that. Any real trajectory inside
 * this app's horizon is under three seconds; twenty is ten times the slack
 * anything sane needs, and a fly that exceeds it is not converging on an
 * answer, it is a bullet falling at terminal velocity while x barely moves. */
const BC_MIN = 0.02, BC_MAX = 2.0;
const MAX_FLIGHT_S = 20;

/* Every guard below returns an EMPTY table rather than a plausible one. The
 * failure this replaces was worse than a crash: an out-of-range zero distance
 * meant the launch-angle search never found its target, fell back on
 * multiplying the angle by 1.5 until it clamped, and returned an 11.5° launch
 * as a solution — a full table of numbers, all of them nonsense, none of them
 * flagged. A negative BC did the same by a different route, the bullet
 * accelerating under negative drag to a perfectly plausible-looking 13 MOA. */
function integrate({ mv, bc, sightHeightIn, zeroYd, maxYd, densityRatio, tempF, dt = 0.0005,
                    atYds = null }) {
  const rho = (densityRatio === undefined || densityRatio === null) ? 1 : densityRatio;
  if (!Number.isFinite(mv) || mv <= 0 || mv > 20000) return [];
  if (!Number.isFinite(bc) || bc < BC_MIN || bc > BC_MAX) return [];
  if (!Number.isFinite(rho) || rho <= 0 || rho > 3) return [];
  if (!Number.isFinite(maxYd) || maxYd <= 0 || maxYd > 5000) return [];
  if (!Number.isFinite(zeroYd) || zeroYd <= 0 || zeroYd > maxYd) return [];
  if (!Number.isFinite(sightHeightIn) || sightHeightIn < 0 || sightHeightIn > 24) return [];
  if (!Number.isFinite(dt) || dt <= 0 || dt > 0.01) return [];

  const cs = speedOfSound(tempF);
  const maxSteps = Math.ceil(MAX_FLIGHT_S / dt);
  const zr = Math.round(zeroYd);

  /* ── Which yard lines to actually build a row for ────────────────────────
   * A row is an object, and building one for every yard out to 650 when the
   * caller is going to read four of them is most of what a fit spends its time
   * on: the truing sweep asks for the drop at the anchors and at the zero and
   * throws the rest away, several hundred times over. `atYds` says which lines
   * the caller wants; omitting it keeps the old behaviour of every one, which
   * is what the table the SHOOTER sees needs.
   *
   * The zero line is always included whether the caller asked for it or not —
   * the launch-angle search below reads it — and the flight stops at the last
   * line wanted rather than at maxYd, because nothing past it is ever read. */
  let wanted = null;
  if (atYds) {
    const set = new Set([zr]);
    for (const y of atYds) {
      const r = Math.round(y);
      if (Number.isFinite(r) && r >= 1 && r <= maxYd) set.add(r);
    }
    wanted = [...set].sort((a, b) => a - b);
  }
  const step = (state, launchAngle) => {
    let { x, y, vx, vy, t } = state;
    const v = Math.hypot(vx, vy);
    const decel = K_DRAG * rho * cdG7(v / cs) * v * v / bc;
    const ax = -decel * (vx / v);
    const ay = -decel * (vy / v) - 32.174;
    return { x: x + vx * dt, y: y + vy * dt, vx: vx + ax * dt, vy: vy + ay * dt, t: t + dt, v };
  };

  /* Fly it once at a given launch angle, sampling drop at each yard line.
   * Bails rather than grinding: if the step guard trips, the trajectory is not
   * one this model can usefully answer about, and spending the remaining
   * hundreds of thousands of steps to say so is what froze the app. */
  const fly = (launchAngle) => {
    let s = { x: 0, y: -sightHeightIn / 12, t: 0,
              vx: mv * Math.cos(launchAngle), vy: mv * Math.sin(launchAngle) };
    const out = [];
    let wi = 0;
    const lastYd = wanted ? wanted[wanted.length - 1] : maxYd;
    const maxFt = lastYd * 3;
    let guard = 0;
    let bailed = false;
    while (s.x < maxFt) {
      if (guard++ >= maxSteps) { bailed = true; break; }
      const prev = s;
      s = step(s, launchAngle);
      for (;;) {
        const yd = wanted ? (wi < wanted.length ? wanted[wi] : 0) : (wi + 1 <= maxYd ? wi + 1 : 0);
        if (!yd || s.x < yd * 3) break;
        // linear interpolation onto the exact yard line
        const f = (yd * 3 - prev.x) / (s.x - prev.x || 1);
        out[yd] = {
          yd,
          dropFt: prev.y + (s.y - prev.y) * f,
          v: Math.hypot(prev.vx, prev.vy) + (Math.hypot(s.vx, s.vy) - Math.hypot(prev.vx, prev.vy)) * f,
          t: prev.t + (s.t - prev.t) * f,
        };
        wi++;
      }
      if (s.vx <= 0) break;
    }
    return { out, bailed };
  };

  /* Find the launch angle that puts the bullet on the aiming point at the
   * zero distance -- a secant search, which converges in a handful of passes
   * because drop is monotonic in angle over any sane range.
   *
   * A fly that bails, or that never reaches the zero distance, returns null
   * rather than a sentinel. The sentinel it replaces (-999 for "no row
   * there") fed the secant search a constant, which made every difference
   * zero, which sent it down the fallback branch and out to the angle clamp. */
  let a0 = 0, a1 = 0.002;
  let f0 = null, f1 = null, table = null, bestErr = Infinity;
  const err = (a) => {
    const { out, bailed } = fly(a);
    const at = out[zr];
    if (bailed || !at) return null;
    return { e: at.dropFt, tr: out };
  };
  const r0 = err(a0);
  if (!r0) return [];
  f0 = r0.e;
  for (let i = 0; i < 30; i++) {
    const r = err(a1);
    if (!r) break;
    f1 = r.e;
    if (Math.abs(f1) < bestErr) { bestErr = Math.abs(f1); table = r.tr; }
    if (Math.abs(f1) < 1e-5) break;
    const denom = (f1 - f0);
    if (Math.abs(denom) < 1e-12) break;
    const a2 = a1 - f1 * (a1 - a0) / denom;
    if (!Number.isFinite(a2)) break;
    a0 = a1; f0 = f1; a1 = Math.max(-0.05, Math.min(0.2, a2));
  }
  /* And the search has to have actually converged. 1e-3 ft at the zero
   * distance is 0.004 MOA at 100 yd -- far below anything a shooter can hold
   * -- and a table that did not get there is not a zeroed rifle, so it is
   * nothing rather than a table of numbers about some other rifle. */
  return (table && bestErr < 1e-3) ? table : [];
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
/* The declared search space, and it is declared because it has to MEAN
 * something. It used to be ±8% on velocity and ±25% on BC, and the refinement
 * sweeps re-centred on the winner without clamping, so the effective box was
 * wider than the stated one by an amount nobody could name — and there was no
 * check on where the winner landed, so a fit that had run out of room reported
 * success like any other.
 *
 * That is not a hypothetical. A rifle truly doing 2450 fps against a box that
 * said 2800 — a 350 fps box error, which is ordinary in a short barrel with
 * factory ammunition — pinned against the old lower bound and predicted 3.45
 * MOA wrong at 1000 yd, shown with a ±1.84 interval and an RMS of 0.150 that
 * reads as an excellent fit. Wrong by 1.9× its own error bar, and nothing in
 * the output said so.
 *
 * So: ±20%/+15% on velocity, which is 2240–3220 fps against a 2800 box and
 * contains every real centrefire rifle mismatched against every plausible box
 * number, and 0.60–1.60 on BC, which covers a G1→G7 conversion being wrong, a
 * bullet that is not what the box says, and a barrel that is not the maker's
 * test barrel. The refinement sweeps are clamped inside it.
 */
const SEARCH_BOX = { mvLo: 0.80, mvHi: 1.15, bcLo: 0.60, bcHi: 1.60 };

/* ── The coarse grid, and why its STEP is what is declared ───────────────
 * The coarse pass finds the BASIN and the local search below finds the bottom
 * of it. A descent method cannot cross a ridge, so whatever basin the coarse
 * pass lands in is the basin the answer comes from, and the coarse pass's
 * resolution is what decides whether that is the right one.
 *
 * That makes the coarse STEP the quantity that has to hold, not the coarse
 * step COUNT — and it shipped as a count. Ten steps across the box, whatever
 * the box was; so when the box was widened from 0.92–1.08 × 0.75–1.25 to
 * 0.80–1.15 × 0.60–1.60 — 2.2× in velocity and 2× in drag, and the widening
 * itself was right — the coarse resolution silently fell from 0.016/0.05 to
 * 0.035/0.10 and the fit began landing in the wrong basin.
 *
 * Measured over 240 noiseless synthetic rifles whose true parameters lie
 * strictly inside the box (mv 2200–3400, G7 BC 0.18–0.40, three anchor sets,
 * box errors of ±4% on velocity and ±15% on BC). With the ten-step count and
 * the fenced refinement grids it shipped with, 51 of those 240 predictions at
 * 1000 yd fell OUTSIDE their own interval, the worst by 3.55 MOA, every one at
 * an RMS that passes the half-minute gate — a silent miss, which is the worst
 * kind. Both halves matter and neither is enough on its own: with the local
 * search in place but the coarse grid left at ten steps, 93 of 240 still fail
 * to reach the true parameters and the worst 1000 yd error is 2.10 MOA. With
 * both, it is 4 of 240 and 0.41 MOA.
 *
 * So the step is declared and the count is derived from whatever the box is.
 * Widen the box again and the grid densifies with it, which is the property
 * that was missing. */
const COARSE_STEP = { mv: 0.016, bc: 0.05 };

/* ── What the denser grid costs, and how it is paid for ──────────────────
 * Deriving the count from the step takes the coarse pass from 11×11 to 23×21,
 * four times the evaluations, and each evaluation integrates once per distinct
 * set of atmospheric conditions among the anchors — which in the app is once
 * per session, because a session records its own temperature. Three anchors at
 * three temperatures was already 1.0 s before the grid was densified.
 *
 * The integration step is what pays for it. The coarse pass only has to RANK
 * candidates well enough to pick the basin, and a 3 ms step ranks them as well
 * as a 0.5 ms one: measured against the 0.5 ms reference over five loads
 * (mv 2200–3400, BC 0.18–0.40) out to 1200 yd, a 3 ms step moves the come-up
 * by at most 0.013 MOA — against a gate of 0.5 MOA and an interval floor of
 * 0.15. The local search, whose winner becomes the answer and whose SSE is
 * reported as rmsMoa, runs at the full 0.5 ms step, and so does the table that
 * is kept. Running the coarse pass at the fine step too costs 3× the whole
 * fit's time and measurably changes nothing.
 *
 * The other half of the cost is `atYds` — see integrate. Between them the
 * fit is five times faster than it was before the grid was densified. */
const FIT_DT = { coarse: 0.003, fine: 0.0005 };

/* The finite-difference steps used to measure how much each anchor's come-up
 * moves per unit of velocity and of drag — the design matrix the interval is
 * built on. Small enough that the curve is straight across them and large
 * enough that the difference is not integration noise: at 0.004 of mvScale
 * (11 fps against a 2800 box) a come-up moves by a few hundredths of a minute,
 * which is hundreds of times the 0.5 ms step's own error. */
const FD_STEP = { mv: 0.004, bc: 0.012 };

/* What a confirmed zero is worth as a reading. A shooter reads a come-up off a
 * target and off a turret, both to about a tenth of a minute, and the app
 * stores it rounded to a hundredth — and a "confirmed zero" is really the
 * centre of a group, which carries the group's own dispersion with it. A tenth
 * and a half is the number the interval is scaled by; it is a prior, it is
 * stated here rather than buried, and the coverage it produces is measured. */
const READ_MOA = 0.15;

/* How badly the anchors may leave the drag unpinned before the fit stops being
 * an answer. In units of bcScale, so 0.8 is "the BC is pinned to within eight
 * tenths of itself". Chosen by measurement — see the note where it is
 * applied. */
const DEGENERATE_BC_SIGMA = 0.8;

/* A fit to a shooter's OWN confirmed zeros cannot physically be much worse
 * than a couple of tenths of a minute: the anchors came off this rifle, and a
 * two-parameter curve through three points from one rifle either passes close
 * to them or the points are not what they claim to be. Half a minute is
 * generous — it is roughly the read error of a confirmed zero off a target
 * plus the model's own slack — and anything past it is data, not physics.
 *
 * What that catches in practice is typing. A 600 yd zero of 14.15 entered as
 * 1.415 fitted silently, reported trued with an RMS of 4.767, and predicted
 * 21.74 ± 4.84 against a true 34.04: a 12.3 MOA under-dial, about 128 inches
 * low at 1000 yards, from one misplaced decimal point.
 *
 * BE CLEAR ABOUT WHAT IT DOES NOT CATCH. Three anchors against two free
 * parameters is not over-determined, so a MODERATE error on one of them is
 * absorbed by the fit rather than left in the residuals: an anchor a single
 * minute out fits to 0.023 MOA RMS and moves the 1000 yd answer 6.7 MOA. No
 * residual threshold can see that, because there is nothing left over to see.
 * A fourth anchor is what defends against it, and the interval is what covers
 * it in the meantime. This gate is for gross errors — decimal points, ×10
 * slips, an anchor pasted from a different rifle — and it is worth having for
 * those alone, because those are the ones that move the answer by ten minutes
 * rather than by one. */
const RMS_GATE_MOA = 0.5;

/* The atmosphere assumed for an anchor that recorded none of its own. See the
 * contract note at the top of trueToDope. */
function anchorAtmosphere(base = {}) {
  const tempF = Number.isFinite(base.zeroTempF) ? base.zeroTempF : STD_TEMP_F;
  if (Number.isFinite(base.zeroDensityRatio) && base.zeroDensityRatio > 0)
    return { densityRatio: base.zeroDensityRatio, tempF, pressureInHg: null };
  if (Number.isFinite(base.zeroPressureInHg) && base.zeroPressureInHg > 0)
    return { densityRatio: airDensityRatio({ tempF, pressureInHg: base.zeroPressureInHg }),
             tempF, pressureInHg: base.zeroPressureInHg };
  return { densityRatio: 1, tempF, pressureInHg: null };
}

function trueToDope(anchors, base) {
  /* ── What an anchor with no atmosphere of its own is assumed to be ───────
   * It used to be standard sea level, flatly — densityRatio 1, 59°F — and that
   * threw away a number the shooter had already typed. Only the temperature is
   * recorded per session; the station pressure the zeros were confirmed at is
   * a field on the solver screen, and it applies to ALL of those zeros, the
   * ones with a temperature and the ones without alike. Discarding it for the
   * ones without meant a shooter at five thousand feet who correctly entered
   * 24.9 inHg had it honoured for two anchors out of three and replaced with
   * sea level for the third.
   *
   * Measured, before this: zeros at 200/300/600 (59/44/86°F) at 24.9 inHg,
   * predicting 1000 yd on a 70°F day. All three tagged: 30.59 against a
   * physical truth of 30.63. The 300 untagged: 32.06 — 1.43 MOA high, outside
   * its own interval, at an RMS of 0.056 that reads as an excellent fit.
   *
   * So the base carries the assumption, and the CONTRACT is:
   *   base.zeroDensityRatio  — the density to assume, if the caller has it;
   *   base.zeroPressureInHg  — or the station pressure to derive it from,
   *                            which is the field the solver screen actually
   *                            has, combined with base.zeroTempF or, failing
   *                            that, the standard 59°F, because nothing was
   *                            recorded and inventing a temperature would be
   *                            worse than admitting to the standard one;
   *   neither                — standard sea level, which is what it was.
   * An anchor that carries its own densityRatio is unaffected by all of it. */
  const assumed = anchorAtmosphere(base);

  /* Yardages are rounded once, here, because the trajectory table is indexed
   * per whole yard and reading row 1000 while dividing by 1000.4 is a
   * different number than reading row 1000 and dividing by 1000. */
  const pts = (anchors || [])
    .filter(a => a && Number.isFinite(a.yd) && a.yd > 0 && Number.isFinite(a.moa))
    .map(a => ({
      ...a,
      yd: Math.round(a.yd),
      /* Each anchor's OWN air, and the shooter's stated zero conditions for an
       * anchor that has none of its own. `atmoRecorded` stays what it was: it
       * means this anchor carried its conditions, not that a sensible
       * assumption was available for it. */
      densityRatio: Number.isFinite(a.densityRatio) ? a.densityRatio : assumed.densityRatio,
      tempF: Number.isFinite(a.tempF) ? a.tempF : assumed.tempF,
      atmoRecorded: Number.isFinite(a.densityRatio),
    }))
    .sort((a, b) => a.yd - b.yd);
  if (!pts.length) return null;

  const near = pts[0], far = pts[pts.length - 1];
  const spread = far.yd - near.yd;
  const baseDR = Number.isFinite(base.densityRatio) ? base.densityRatio : 1;
  const baseTemp = Number.isFinite(base.tempF) ? base.tempF : STD_TEMP_F;
  const anchorsHaveAtmosphere = pts.every(p => p.atmoRecorded);

  /* One anchor, or several all at one distance, cannot separate velocity from
   * drag at all: raise one and lower the other and the curve passes through
   * the same single point. Saying so is the honest answer; picking a pair
   * anyway and reporting it as trued would be a fabrication.
   *
   * This is only the cheap pre-check, and it is worth being clear that it is
   * no longer the thing that decides whether the anchors CAN separate the two.
   * A hundred yards of spread was chosen for being a round number and it
   * admits 100/200/300, where they are 0.9999 collinear. The real test is the
   * leverage the fit produces, and it happens after the fit because that is
   * where the leverage exists — see DEGENERATE_BC_SIGMA. What survives here is
   * the case that needs no fit to reject: fewer than two anchors, or two at
   * the same place, where there is nothing to run a search over. */
  const canTrue = pts.length >= 2 && spread >= 100;

  /* ── Fitting the anchors in the air they were shot in ───────────────────
   * This is the difference between an atmosphere input that does something
   * and one that is decoration. Drag deceleration is ρ·Cd·v²/BC, so ρ and
   * 1/BC enter as a single product — and bcScale is a free fitting parameter.
   * Integrating every anchor in TODAY's air therefore lets the fit produce a
   * bcScale that exactly cancels whatever density is handed in: the shooter
   * types 5,000 ft and 95°F correctly and the prediction does not move.
   *
   * Measured, before this was fixed: DOPE confirmed at sea level, match day
   * entered at 5,000 ft, prediction 34.08 MOA against a physical truth of
   * 30.27 — 3.8 MOA high, about 40 inches at 1000 yards, in the direction of
   * dialling far too much. Temperature was equally inert: 0°F to 110°F moved
   * the prediction from 34.1 to 33.9 while the truth ran 36.58 to 32.38.
   *
   * The degeneracy breaks the moment each anchor is integrated in its OWN
   * density. Then bcScale has to explain the anchors given their air, and the
   * density handed in for today is left free to move the answer. */
  const groups = new Map();
  for (const p of pts) {
    const k = `${p.densityRatio}|${p.tempF}`;
    if (!groups.has(k)) groups.set(k, { densityRatio: p.densityRatio, tempF: p.tempF, pts: [], yds: [] });
    groups.get(k).pts.push(p);
    groups.get(k).yds.push(p.yd);
  }
  const fitMaxYd = Math.max(far.yd, base.zeroYd || 0) + 50;

  const evaluate = (mvScale, bcScale, dt = FIT_DT.fine) => {
    let sse = 0, n = 0;
    const resid = [];
    for (const g of groups.values()) {
      const table = integrate({
        mv: base.mv * mvScale, bc: base.bc * bcScale,
        sightHeightIn: base.sightHeightIn, zeroYd: base.zeroYd,
        maxYd: fitMaxYd, densityRatio: g.densityRatio, tempF: g.tempF, dt,
        /* Only the lines this group's anchors sit on. The fit reads those and
         * the zero line and nothing else, several hundred times over. */
        atYds: g.yds,
      });
      for (const p of g.pts) {
        const row = table[p.yd];
        if (!row) return { sse: Infinity, resid: null };
        const predicted = dropToMoa(row.dropFt, p.yd);
        const d = predicted - p.moa;
        sse += d * d; n++;
        resid.push({ yd: p.yd, moa: p.moa, predicted, residual: d });
      }
    }
    return { sse: n ? sse / n : Infinity, resid };
  };

  /* The fitting tables only reach the furthest anchor, because that is all the
   * objective needs. The table that is KEPT has to reach past them -- the whole
   * point is the distances the shooter has not fired -- and it is flown in
   * TODAY's air, because that is the air the shooter is about to dial in. */
  const horizon = Math.max(base.horizonYd || 1200, far.yd + 200);
  const flyToday = (mvScale, bcScale) => integrate({
    mv: base.mv * mvScale, bc: base.bc * bcScale,
    sightHeightIn: base.sightHeightIn, zeroYd: base.zeroYd, maxYd: horizon,
    densityRatio: baseDR, tempF: baseTemp,
  });

  /* Every refusal returns the same shape as a success, carrying the UNTRUED
   * box numbers: an untrued answer is still an answer, and predict() widens
   * its interval for one. What a refusal must never do is return the fitted
   * numbers, because the whole reason for refusing is that they are not
   * trustworthy. */
  const refuse = (reason, extra = {}) => {
    const r = evaluate(1, 1);
    return {
      trued: false, pinned: false, reason,
      mvScale: 1, bcScale: 1, mv: base.mv, bc: base.bc,
      table: flyToday(1, 1), tempF: baseTemp,
      rmsMoa: Number.isFinite(r.sse) ? Math.sqrt(r.sse) : null,
      anchors: pts, anchorsHaveAtmosphere, assumedAnchorAtmosphere: assumed, ...extra,
    };
  };

  if (!canTrue) {
    return refuse(pts.length < 2
      ? 'one confirmed zero — velocity and drag cannot be separated from a single point'
      : 'all the confirmed zeros are within 100 yards of each other, which cannot separate velocity from drag');
  }

  const B = SEARCH_BOX;
  const clampM = (v) => Math.min(B.mvHi, Math.max(B.mvLo, v));
  const clampB = (v) => Math.min(B.bcHi, Math.max(B.bcLo, v));

  /* ── The coarse pass: which basin ───────────────────────────────────────
   * A full grid over the declared box, clamped to it, so that "the search
   * space is 0.80 to 1.15" is a fact about the code rather than a description
   * of the first sweep. Its step is COARSE_STEP and its COUNT falls out of the
   * box — see the note there for why that is the way round it has to be. */
  const mSteps = Math.ceil((B.mvHi - B.mvLo) / COARSE_STEP.mv);
  const bSteps = Math.ceil((B.bcHi - B.bcLo) / COARSE_STEP.bc);
  const mStep = (B.mvHi - B.mvLo) / mSteps, bStep = (B.bcHi - B.bcLo) / bSteps;
  let coarse = { sse: Infinity, mvScale: NaN, bcScale: NaN };
  for (let i = 0; i <= mSteps; i++) {
    for (let j = 0; j <= bSteps; j++) {
      const ms = B.mvLo + mStep * i, bs = B.bcLo + bStep * j;
      const r = evaluate(ms, bs, FIT_DT.coarse);
      if (r.sse < coarse.sse) coarse = { sse: r.sse, mvScale: ms, bcScale: bs };
    }
  }

  /* ── The local search: where in it ──────────────────────────────────────
   * This used to be two more grids, each spanning ONE step of the sweep before
   * it and centred on that sweep's winner — which is a fence, and the fence is
   * put around the wrong point. The objective here is a long, narrow, curved
   * valley: velocity and drag trade off against each other almost exactly, so
   * a whole ridge of (mv, bc) pairs fits three anchors nearly as well as the
   * truth does, and the coarse winner is a quantised point ON that ridge
   * rather than at its bottom. Measured on the 2712 fps / 0.259 rifle: the
   * coarse winner sat at bcScale 1.150 while the truth was 1.0658 — 1.7 coarse
   * steps along the valley — so a window of ±1 step could not reach it at any
   * resolution, and the fit converged to an RMS of 0.014 that reads as
   * excellent while predicting 0.41 MOA wrong at 1000.
   *
   * A compass search has no fence. It steps to the best of the eight
   * neighbours at the current step size and keeps walking while the objective
   * improves — along the valley for as far as the valley goes — and halves the
   * step only when no neighbour is better. It is bounded by an evaluation
   * budget rather than by a window, so the cost is capped without the answer
   * being capped, and it runs at the full integration step because this is the
   * tier whose winner becomes the answer.
   *
   * The tolerance is where it stops: half a thousandth on velocity is 1.4 fps
   * against a 2800 fps box, and 1.5 thousandths on drag is 0.0004 of BC. Both
   * are far below what a confirmed zero read off a target can distinguish. */
  const LOCAL_TOL = { mv: 5e-4, bc: 1.5e-3 };
  /* And the budget is a backstop, not the usual stopping condition — which is
   * a thing worth measuring rather than assuming, because a budget that binds
   * routinely is a silent truncation dressed as a convergence. Over 192 fits
   * across the box the search uses 104 evaluations at the median, 184 at the
   * ninetieth percentile and 408 at its worst, so 440 is reached by none of
   * them and the answers are the tolerance's, not the budget's. A first
   * attempt at 260 was hit by 3% of fits. */
  const LOCAL_BUDGET = 440;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  let best = { sse: Infinity, mvScale: NaN, bcScale: NaN, resid: null };
  if (Number.isFinite(coarse.sse)) {
    /* Re-evaluated at the fine step: the coarse SSE was measured with a 3 ms
     * integration step and is not comparable with anything below. */
    const seed = evaluate(coarse.mvScale, coarse.bcScale, FIT_DT.fine);
    best = { sse: seed.sse, mvScale: coarse.mvScale, bcScale: coarse.bcScale, resid: seed.resid };
    let sm = mStep, sb = bStep, budget = LOCAL_BUDGET;
    while ((sm > LOCAL_TOL.mv || sb > LOCAL_TOL.bc) && budget > 0) {
      let move = null;
      for (const [dm, db] of DIRS) {
        const ms = clampM(best.mvScale + dm * sm), bs = clampB(best.bcScale + db * sb);
        if (ms === best.mvScale && bs === best.bcScale) continue;
        budget--;
        const r = evaluate(ms, bs, FIT_DT.fine);
        if (r.sse < (move ? move.sse : best.sse))
          move = { sse: r.sse, mvScale: ms, bcScale: bs, resid: r.resid };
        if (budget <= 0) break;
      }
      if (move) best = move; else { sm /= 2; sb /= 2; }
    }
  }

  /* Every candidate failed to integrate. The old code initialised the winner
   * to {sse: Infinity, mvScale: 1, bcScale: 1} and tested `r.sse < best.sse`,
   * which is never true when every evaluation returns Infinity — so the
   * untouched initial value fell through to the success return and reported
   * `trued: true` with `rmsMoa: Infinity`. */
  if (!best.resid || !Number.isFinite(best.sse)) {
    return refuse('the load could not be integrated at any velocity or drag in the search range — check the muzzle velocity, the BC and the zero distance');
  }

  const rms = Math.sqrt(best.sse);
  const worst = best.resid.reduce((a, b) => Math.abs(b.residual) > Math.abs(a.residual) ? b : a);

  /* Where did the winner land? At a bound, or within the local search's own
   * stopping tolerance of one, means the fit wanted to leave the search space,
   * and a fit that wanted to leave the search space is not telling you about
   * the rifle, it is telling you the inputs are not what the shooter thinks
   * they are — usually a velocity or a BC entered for a different load.
   *
   * Refused rather than returned with a wider interval. The choice matters:
   * the interval is calibrated (see predict) on fits that landed INSIDE the
   * box, and a pinned fit is outside the population it was measured over, so
   * widening it would be inventing a number to cover a case it was never
   * measured against. "I cannot answer this, and here is which input to look
   * at" is worth more than a number with an error bar of unknown meaning.
   *
   * The band is the local search's stopping tolerance rather than a grid step,
   * because the local search has no grid — it walks until neither the velocity
   * nor the drag can be improved by more than LOCAL_TOL, and a winner sitting
   * within that of a bound is a winner that stopped because of the bound. */
  const pins = [];
  if (best.mvScale <= B.mvLo + LOCAL_TOL.mv)
    pins.push(`the fit ran to the bottom of the velocity range (${Math.round(base.mv * B.mvLo)} fps) and wanted to go lower`);
  if (best.mvScale >= B.mvHi - LOCAL_TOL.mv)
    pins.push(`the fit ran to the top of the velocity range (${Math.round(base.mv * B.mvHi)} fps) and wanted to go higher`);
  if (best.bcScale <= B.bcLo + LOCAL_TOL.bc)
    pins.push(`the fit ran to the bottom of the BC range (${(base.bc * B.bcLo).toFixed(3)}) and wanted to go lower`);
  if (best.bcScale >= B.bcHi - LOCAL_TOL.bc)
    pins.push(`the fit ran to the top of the BC range (${(base.bc * B.bcHi).toFixed(3)}) and wanted to go higher`);

  const pinnedInfo = pins.length
    ? { pinned: true, pinnedAt: { mvScale: best.mvScale, bcScale: best.bcScale } }
    : { pinned: false };

  /* The RMS gate is checked BEFORE the boundary, and the order was chosen from
   * the numbers rather than from taste. A mistyped anchor drags the fit to a
   * bound too, so both gates fire on it — but its residual is enormous (4.1
   * MOA for the decimal slip, 63.8 for the ×10) while a rifle that is merely
   * outside the search box still fits its own anchors well (0.41 and 0.12 MOA
   * in the two cases measured). The residual therefore separates the two
   * cleanly, and it is the one that can name the line of the log to go and
   * look at. Naming it is the whole value of this gate: "the 600 yd zero does
   * not agree with the other two" sends the shooter somewhere; "fit failed"
   * sends them nowhere. */
  if (rms > RMS_GATE_MOA) {
    const others = pts.length - 1;
    return refuse(
      `the ${worst.yd} yd zero of ${worst.moa.toFixed(2)} MOA does not agree with the other ` +
      `${others === 1 ? 'one' : others} — the physics that fits the rest puts it at ` +
      `${worst.predicted.toFixed(2)} MOA, ${Math.abs(worst.residual).toFixed(2)} MOA away. ` +
      `Check that entry before trusting anything built on it.`,
      { ...pinnedInfo,
        worstAnchor: { yd: worst.yd, moa: worst.moa, predicted: worst.predicted, residual: worst.residual },
        fitRmsMoa: rms });
  }

  if (pins.length) {
    return refuse(`${pins.join('; and ')} — the muzzle velocity or the BC this was started from is probably for a different load`,
                  { ...pinnedInfo, fitRmsMoa: rms });
  }

  const final = flyToday(best.mvScale, best.bcScale);
  if (!final.length) {
    return refuse('the trued numbers could not be flown out to the prediction horizon');
  }

  /* ── How far a tenth of a minute of read error can move the answer ──────
   * The interval used to be built on rmsMoa, and rmsMoa is the wrong quantity
   * for the job in a way that fails hardest exactly where a shooter is most
   * exposed. Two anchors against two free parameters is an EXACTLY determined
   * fit: the curve passes through both points whatever they say, the residual
   * is near zero by construction, and the interval collapses to its floor —
   * while the noise that was in those two readings has gone straight into the
   * velocity and the drag. Measured over 2,850 two-anchor predictions with
   * ±0.1 MOA of read error: 24% fell outside their own interval, the worst by
   * 13.5× it — one of them 2.1 MOA wrong at 500 yd, INSIDE its own anchors, at
   * an RMS of 0.05 and a stated interval of ±0.16.
   *
   * So the interval is built from what the READING ERROR can do instead, which
   * is a quantity that exists whether or not there is anything left over in
   * the residuals. Two extra evaluations give the two columns of the design
   * matrix — how much each anchor's come-up moves per unit of mvScale and per
   * unit of bcScale — and two extra flights give the same two sensitivities at
   * every distance in the kept table. Ordinary least-squares leverage then
   * turns an error of σ on each anchor into an error bar at any distance:
   *
   *   var(moa at y) = σ² · g(y)ᵀ (XᵀX)⁻¹ g(y)
   *
   * This is what makes the interval widen on its own for the cases that
   * deserve it — two anchors, anchors bunched together, an anchor sitting on
   * the zero where the come-up is zero and its noise is all there is, and any
   * distance far outside the anchors — without any of those having to be
   * special-cased, and it is why "shoot a zero further out" is the thing that
   * narrows it. */
  const sM = (best.mvScale + FD_STEP.mv <= B.mvHi) ? FD_STEP.mv : -FD_STEP.mv;
  const sB = (best.bcScale + FD_STEP.bc <= B.bcHi) ? FD_STEP.bc : -FD_STEP.bc;
  const eM = evaluate(best.mvScale + sM, best.bcScale, FIT_DT.fine);
  const eB = evaluate(best.mvScale, best.bcScale + sB, FIT_DT.fine);
  let leverage = null;
  if (eM.resid && eB.resid && eM.resid.length === best.resid.length) {
    let xx = 0, xy = 0, yy = 0;
    for (let i = 0; i < best.resid.length; i++) {
      const u = (eM.resid[i].predicted - best.resid[i].predicted) / sM;
      const v = (eB.resid[i].predicted - best.resid[i].predicted) / sB;
      xx += u * u; xy += u * v; yy += v * v;
    }
    const det = xx * yy - xy * xy;
    const tM = flyToday(best.mvScale + sM, best.bcScale);
    const tB = flyToday(best.mvScale, best.bcScale + sB);
    if (det > 0 && tM.length && tB.length) {
      const gM = [], gB = [];
      for (let y = 1; y < final.length; y++) {
        if (!final[y] || !tM[y] || !tB[y]) continue;
        const m0 = dropToMoa(final[y].dropFt, y);
        gM[y] = (dropToMoa(tM[y].dropFt, y) - m0) / sM;
        gB[y] = (dropToMoa(tB[y].dropFt, y) - m0) / sB;
      }
      leverage = { xx, xy, yy, det, gM, gB };
    }
  }

  /* The σ that gets multiplied by that leverage. With more anchors than
   * parameters the residuals estimate it — over n-2 degrees of freedom, not n,
   * because two of them were spent making the curve pass through the data. With
   * exactly two there are no degrees of freedom left and the residuals estimate
   * nothing, so the prior stands on its own. Either way it never goes below
   * READ_MOA: a fit whose residuals came out at a hundredth of a minute has not
   * demonstrated that a person read a target to a hundredth of a minute. */
  const dof = pts.length - 2;
  const sigmaMoa = Math.max(READ_MOA, dof > 0 ? rms * Math.sqrt(pts.length / dof) : 0);

  /* ── Have these zeros actually separated velocity from drag? ────────────
   * That sentence is what canTrue has always claimed to be enforcing, and it
   * enforced it with `spread >= 100` — a yardage, chosen for being round. It
   * admits 100/200/300, where the two sensitivity columns are 0.9999
   * collinear: raise the velocity, lower the BC, and the curve goes through
   * all three points again. The fit then slides along that ridge until it
   * reaches a bound and the pin check refuses it, blaming the shooter's BC for
   * a rifle that is nothing of the sort — 7.8% of honest short-spread sets,
   * against 0.12% of well-spread ones.
   *
   * The leverage measures the thing the yardage was standing in for. σ on
   * bcScale is how well these anchors pin the drag, in units of the BC itself:
   * 0.05 is the drag known to a twentieth, 2.0 is not knowing it at all. It
   * falls with spread and with anchor count exactly as it should — measured
   * over 1,251 fits with ±0.1 MOA of read error, the median runs 1.28 for
   * three anchors spanning 100 yards, 0.31 at 300, 0.20 at 400 and 0.056 at
   * 700; two anchors spanning 100 yards sit at 1.87.
   *
   * WHAT THE LINE IS NOT CHOSEN BY: coverage. Coverage holds at every
   * threshold measured, from 0.5 to 2.0 — the widest error any accepted fit
   * made was 0.56 of its own interval throughout, because the interval is
   * computed from this same leverage and widens with it. Moving the line does
   * not make the answers wronger; it makes them wider. So the thing to choose
   * on is where the interval stops being a number a shooter can use, and that
   * distribution is sharply bimodal: below the line the widest interval any
   * accepted fit reports out to 1200 yd is a few tens of minutes, and above it
   * the tail runs to 10⁵.
   *
   * Drawn at 0.8, where these are the fits kept, over 1,251 of them, against
   * 0.5 and 1.0 either side:
   *
   *                       σbc≤0.5   σbc≤0.8   σbc≤1.0
   *   3 anchors,  100 yd    14%       35%       42%
   *   3 anchors,  200 yd    50%       68%       70%
   *   3 anchors,  300 yd    72%       85%       89%
   *   3 anchors,  400 yd    91%       96%      100%
   *   3 anchors,  500 yd    99%      100%      100%
   *   2 anchors,  100 yd    19%       35%       42%
   *
   * 0.8 keeps 96% of three anchors spanning 400 yards — the shape this app is
   * for and the shape a season of shooting produces — while keeping only a
   * third of three anchors spanning 100, which is the shape that cannot be
   * answered. 0.5 starts refusing the 400-yard sets, which is refusing real
   * work; 1.0 admits more of the 100-yard ones without making them any more
   * informative. The short-spread sets that ARE kept are kept with the wide
   * interval their leverage earns them, which is the other half of the answer:
   * of the short-spread fits this used to accept, 29% missed their own 600 yd
   * interval, and that number is now a rounding error. */
  const sigmaBcScale = leverage ? sigmaMoa * Math.sqrt(leverage.xx / leverage.det) : Infinity;
  const sigmaMvScale = leverage ? sigmaMoa * Math.sqrt(leverage.yy / leverage.det) : Infinity;
  if (!(sigmaBcScale <= DEGENERATE_BC_SIGMA)) {
    const spanWord = spread < 300
      ? `a confirmed zero further out is what separates them — these span ${spread} yards`
      : `another confirmed zero, further out than the ${far.yd}, is what separates them`;
    return refuse(
      `these confirmed zeros do not separate the muzzle velocity from the drag: they pin the BC ` +
      `no better than ±${Number.isFinite(sigmaBcScale) ? Math.round(sigmaBcScale * 100) + '%' : 'anything at all'}, ` +
      `so a higher velocity with a lower BC fits them just as well and the two answers ` +
      `disagree by minutes at distance. ${spanWord}.`,
      { pinned: false, fitRmsMoa: rms, sigmaBcScale, sigmaMvScale });
  }

  return {
    sigmaBcScale, sigmaMvScale,
    trued: true, pinned: false,
    leverage, sigmaMoa,
    mvScale: best.mvScale, bcScale: best.bcScale,
    mv: base.mv * best.mvScale, bc: base.bc * best.bcScale,
    table: final,
    tempF: baseTemp,
    rmsMoa: rms,
    anchors: pts,
    /* False means at least one anchor carried no conditions of its own and was
     * fitted in the assumed ones below. The correction from there to today's
     * air is still applied and is still better than none, but it rests on an
     * assumption, the interval is widened for it (see predict), and the UI
     * should say so rather than presenting it as measured. */
    anchorsHaveAtmosphere,
    /* What that assumption WAS, so the screen can name it: the density and
     * temperature every untagged anchor was fitted in, and the station
     * pressure it was derived from when it came from one. */
    assumedAnchorAtmosphere: assumed,
    residuals: best.resid,
    worstResidualMoa: Math.abs(worst.residual),
  };
}

/* ── Prediction, with an interval that means something ────────────────────
 * Four sources of doubt, added in quadrature:
 *
 *   1. WHAT THE ANCHORS' OWN READ ERROR CAN DO. A confirmed zero is a number a
 *      person read off a target, and the fit turns whatever error is in it into
 *      an error in velocity and drag and then into an error at the distance
 *      being asked about. How badly depends entirely on the geometry of the
 *      anchors — how many, how far apart, and how far outside them the question
 *      is — and that is computed rather than guessed: see the leverage note in
 *      trueToDope. This is the term that dominates, and it is the one that was
 *      missing.
 *   2. How far past the anchors the question is, as a MODEL error rather than a
 *      noise one: out beyond the furthest anchor the curve is being asked about
 *      a velocity regime it was never shown, and transonic behaviour is where
 *      drag models diverge most, which no amount of clean data fixes.
 *   3. Whether the anchors' air was recorded or assumed.
 *   4. A floor, because nothing here is exact to a hundredth of a minute.
 *
 * The interval is deliberately wide rather than flattering. A shooter who
 * dials a predicted 33.9 and finds it was 34.6 is served by having been told
 * ±1.8 beforehand.
 *
 * BE CLEAR ABOUT WHAT THIS IS AND WHEN IT WAS LAST MEASURED. The leverage is
 * derived; the CONSTANTS — READ_MOA, the 2σ multiplier, the 0.15 floor, the
 * 0.06 untrued term, the 0.05·(stretch−1)·stretch model growth, the 0.05
 * assumed-atmosphere term — are empirical and were chosen by measurement.
 *
 * The measurement, RE-RUN on the current search box, the current search and
 * the current refusals — the figure that used to stand here ("97.5% over 200
 * synthetic rifles") predated all three, and by the time it was quoted it was
 * describing code that no longer existed. What was run: 1,296 synthetic rifles
 * — muzzle velocities 2400 to 3200, G7 BCs 0.20 to 0.37, box errors up to 5%
 * on velocity and 13% on BC, anchor sets of two, three and four spanning 100
 * to 700 yards with the near anchor at 100, 200 and 300 — each anchor given
 * reading error and rounded to the hundredth the app stores, then asked for
 * 300 through 1200 yards and checked against its own physical truth. 32% were
 * refused, almost all of them for not separating velocity from drag; the rest
 * gave 5,244 predictions:
 *
 *   reading error                  outside their interval    worst, as a
 *                                                            fraction of it
 *   ±0.1 MOA uniform (sd 0.058),
 *   which is what the app stores        0 of 5,244  100%          0.61
 *   0.15 MOA gaussian, which is
 *   what READ_MOA claims               14 of 5,274   99.7%        1.47
 *   0.30 MOA gaussian, twice the
 *   claim — a stress case             122 of 4,296   97.2%        1.96
 *
 * So it behaves like a 2σ bound at the reading error it is scaled by, and
 * conservatively at the reading error the app's own rounding implies. The
 * numbers above are re-derived by an assertion in the test file rather than
 * only asserted here, because a coverage figure quoted in a comment and
 * measured nowhere is exactly how the last one came to be wrong.
 *
 * And the qualifier that does not change: an interval only means something
 * over the population it was measured on. That is why trueToDope refuses a fit
 * pinned against the edge of the search box and a fit to an anchor that
 * disagrees with the others, rather than handing them here with a number on
 * them.
 */
const FLOOR_MOA = 0.15;
/* The leverage above is a 1σ quantity. Two of them is the bound reported, which
 * is the convention a shooter reading "±1.8" will assume. */
const CI_SIGMAS = 2;
/* Drag-model divergence past the anchors, as a fraction of the come-up, growing
 * with the square of the stretch. Not a noise term: it is there when the data
 * is perfect. */
const MODEL_STRETCH = 0.05;
/* Anchors fitted in assumed air rather than their own. The assumption is the
 * shooter's stated zero conditions where they gave them and standard sea level
 * where they did not, and either way it is an assumption about the density that
 * scales the whole drag term. */
const ASSUMED_ATMO = 0.05;
/* Untrued: the box numbers, with nothing confirming them. */
const UNTRUED = 0.06;

function predict(trued, yd) {
  if (!trued || !trued.table || !Number.isFinite(yd)) return null;
  /* One yardage, used for both halves. Reading row 1000 and then dividing the
   * drop by 1000.4 yards is arithmetic about a shot nobody took: predict(t,
   * 1000.4) returned 33.898 and predict(t, 1000.6) returned 33.987 off the
   * same row. The table is per whole yard, so the answer is per whole yard. */
  const y = Math.round(yd);
  const row = trued.table[y];
  if (!row) return null;
  const moa = dropToMoa(row.dropFt, y);

  const far = trued.anchors[trued.anchors.length - 1].yd;
  const near = trued.anchors[0].yd;
  const inside = y <= far && y >= near;
  const stretch = y > far ? y / far : (y < near ? near / Math.max(1, y) : 1);

  /* 1. The anchors' read error, through the fit, to here. */
  let fitCi = null;
  const L = trued.leverage;
  if (L && L.det > 0 && Number.isFinite(L.gM[y]) && Number.isFinite(L.gB[y])) {
    const gm = L.gM[y], gb = L.gB[y];
    const q = (L.yy * gm * gm - 2 * L.xy * gm * gb + L.xx * gb * gb) / L.det;
    if (q >= 0 && Number.isFinite(q)) fitCi = CI_SIGMAS * trued.sigmaMoa * Math.sqrt(q);
  }
  /* No leverage means an untrued answer or a degenerate one, and the residual
   * is all there is to fall back on — which is exactly the fallback that was
   * not good enough on its own, so it is used only where there is nothing
   * better. */
  if (fitCi === null) fitCi = Number.isFinite(trued.rmsMoa) ? trued.rmsMoa : 0;

  let ci = Math.hypot(fitCi, FLOOR_MOA);
  if (!trued.trued) ci = Math.hypot(ci, moa * UNTRUED);       // untrued: the box numbers
  if (trued.anchorsHaveAtmosphere === false) ci = Math.hypot(ci, moa * ASSUMED_ATMO);
  if (!inside) {
    /* Grows with the square of the stretch, because the error in a drag model
     * grows fastest where the bullet is slowest, and that is exactly where
     * extrapolation goes. */
    ci = Math.hypot(ci, moa * MODEL_STRETCH * (stretch - 1) * stretch);
  }
  return {
    yd: y, moa, velocity: row.v, timeOfFlight: row.t,
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
    /* Deduplicate before pairing. n counts pairings, so the same observation
     * present twice does not add evidence, it MANUFACTURES it: two identical
     * Prone entries and one Standing at the same distance reported n: 2,
     * elevMoa: 0.5, elevSd: 0 — two independent observations in perfect
     * agreement, which is the most confidence-inspiring thing this function
     * can say, from one observation logged twice.
     *
     * Identity has to be what makes two rows the same SHOOTING. It was the
     * session id where a cell carried one — and that made the whole thing
     * inert, because the caller builds exactly one cell per session and always
     * sets sessionId, so every cell was unique by construction and nothing was
     * ever deduplicated. The duplicate this exists to catch is two SESSIONS
     * holding the same string, which is what happens when a session is logged
     * twice or restored twice from a backup, and those have two different ids.
     *
     * So the id plays no part: same rifle, same place, same distance (the
     * group key), and then the same position, the same date and the same
     * dialled elevation and windage is one shooting, however many sessions of
     * it reached here. Two strings genuinely shot the same day, in the same
     * position, at the same distance, dialled identically are collapsed too —
     * and that is the right way to be wrong, because they carry the same
     * number and pairing them twice would report agreement that was never
     * independently observed. Different days, or different dials, stay
     * separate, which is where the evidence actually is. */
    const seen = new Set();
    const obs = [];
    for (const c of group) {
      const id = `${c.position}|${c.date || ''}|${c.elev}|${c.wind}`;
      if (seen.has(id)) continue;
      seen.add(id);
      obs.push(c);
    }
    for (let i = 0; i < obs.length; i++) {
      for (let j = 0; j < obs.length; j++) {
        if (i === j) continue;
        const a = obs[i], b = obs[j];
        if (!a.position || !b.position || a.position === b.position) continue;
        /* A missing number is not a zero. `(b.elev || 0) - (a.elev || 0)` on a
         * cell with no elevation recorded reported the OTHER cell's elevation
         * as the offset between the positions — a 14 MOA position offset,
         * presented as an observation, out of one absent field. NaN was worse:
         * NaN || 0 is 0, so it fabricated with no NaN left to give it away. */
        if (![a.elev, b.elev, a.wind, b.wind].every(Number.isFinite)) continue;
        const k = `${a.position}→${b.position}`;
        if (!pairs.has(k)) pairs.set(k, { from: a.position, to: b.position, elev: [], wind: [] });
        pairs.get(k).elev.push(b.elev - a.elev);
        pairs.get(k).wind.push(b.wind - a.wind);
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
         trueToDope, predict, positionOffsets, G1_TO_G7, K_DRAG,
         SEARCH_BOX, COARSE_STEP, RMS_GATE_MOA, READ_MOA,
         DEGENERATE_BC_SIGMA, BC_MIN, BC_MAX };
