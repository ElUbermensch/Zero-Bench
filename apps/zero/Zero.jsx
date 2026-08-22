import { useState, useEffect, useRef, useMemo } from "react";

const MOA_PER_100YD = 1.0472;

const DEFAULT_RING_COLORS = {
  X: '#e8943a',
  '10': '#f0f2f8',
  '9': '#3db87a',
  '8': '#7a7f96',
  '7': '#4a5068',
  M: '#c0392b', // miss — distinct red, not reused anywhere else in the ring/category palettes
};
const COLOR_PRESETS = [
  '#b87a1c','#1a1814','#3db87a','#7a7a7a','#b0aba0',
  '#9a2e1e','#4a9eff','#6b3a9a','#2e8a7a','#c47a3a',
  '#ffffff','#dddddd','#ff6b35','#e8c840','#3a7abf',
];

const BUILTIN_TARGETS = [
  {
    id:"sr", name:"SR", desc:"200yd short range", builtin:true,
    rings:[
      // Aiming black extended: X through 9 (13" diam). 8 and below are white.
      {score:"X", diam:3.00,  color:'#1a1814'},
      {score:"10",diam:7.00,  color:'#1a1814'},
      {score:"9", diam:13.00, color:'#1a1814'},
      {score:"8", diam:19.00, color:'#ffffff'},
      {score:"7", diam:25.00, color:'#ffffff'},
      {score:"6", diam:31.00, color:'#ffffff'},
      {score:"5", diam:37.00, color:'#ffffff'},
    ]
  },
  {
    id:"sr3", name:"SR-3", desc:"300yd rapid fire", builtin:true,
    rings:[
      // Enlarged aiming black: X through 8 (19" diam). 7 and below white.
      {score:"X", diam:3.00,  color:'#1a1814'},
      {score:"10",diam:7.00,  color:'#1a1814'},
      {score:"9", diam:13.00, color:'#1a1814'},
      {score:"8", diam:19.00, color:'#1a1814'},
      {score:"7", diam:25.00, color:'#ffffff'},
      {score:"6", diam:31.00, color:'#ffffff'},
      {score:"5", diam:37.00, color:'#ffffff'},
    ]
  },
  {
    id:"mr1", name:"MR-1", desc:"600yd mid range", builtin:true,
    rings:[
      // Enlarged aiming black: X through 7 (36" diam). 6 and below white.
      {score:"X", diam:6.00,  color:'#1a1814'},
      {score:"10",diam:12.00, color:'#1a1814'},
      {score:"9", diam:18.00, color:'#1a1814'},
      {score:"8", diam:24.00, color:'#1a1814'},
      {score:"7", diam:36.00, color:'#1a1814'},
      {score:"6", diam:48.00, color:'#ffffff'},
      {score:"5", diam:60.00, color:'#ffffff'},
    ]
  }
];

function uid() { return Math.random().toString(36).slice(2,10); }
function inchesToMoa(in_, yd) { return in_ / (yd * MOA_PER_100YD / 100); }
// Sight turret: elev/wind are stored as integer CLICKS (lossless, matches a
// detented turret). MOA is the derived display. 1 click = 1/4 MOA on a standard
// target turret; for 1/8-MOA scopes change this one constant to 0.125.
const MOA_PER_CLICK = 0.25;
function clicksToMoa(clicks) { return (clicks || 0) * MOA_PER_CLICK; }
function fmtMoaSigned(clicks) { const v = clicksToMoa(clicks); return (v > 0 ? '+' : '') + v.toFixed(2); }
function dist(a,b) { return Math.sqrt((a.x-b.x)**2+(a.y-b.y)**2); }

// Returns 'A','B','C'... for sighters and '1','2','3'... for record shots
// given the full shots array and the index of the shot in question.
function shotLabel(shots, idx) {
  const sh = shots[idx];
  if (!sh) return String(idx+1);
  let sighterCount = 0, recordCount = 0;
  for (let i = 0; i <= idx; i++) {
    if (shots[i].isSighter) sighterCount++;
    else recordCount++;
  }
  return sh.isSighter
    ? String.fromCharCode(64 + sighterCount)   // A, B, C...
    : String(recordCount);                       // 1, 2, 3...
}

function ringColor(target, score) {
  const r = target.rings.find(r=>r.score===score);
  return r?.color || DEFAULT_RING_COLORS[score] || '#888';
}

function firearmRoundCount(firearm, sessions) {
  if (!firearm) return 0;
  const base = +firearm.roundsAtStart || 0;
  const logged = sessions
    .filter(s => s.rifleId === firearm.id)
    .reduce((sum, s) => sum + (s.shots || []).length, 0);
  return base + logged;
}

function firearmBarrelLifeStatus(firearm, sessions) {
  if (!firearm || !firearm.barrelLife) return null;
  const count = firearmRoundCount(firearm, sessions);
  const pct = count / (+firearm.barrelLife);
  return { count, life: +firearm.barrelLife, pct, remaining: Math.max(0, +firearm.barrelLife - count) };
}

function ringMidR(target, score, pos) {
  const rings = target.rings;
  const idx = rings.findIndex(r => r.score === score);
  if (idx < 0) {
    // Miss ('M') or unrecognized score — place just outside the outermost
    // ring rather than defaulting to a near-center radius.
    return score === 'M' ? rings[rings.length-1].diam/2 * 1.15 : 2;
  }
  const oR = rings[idx].diam / 2;
  const iR = idx > 0 ? rings[idx-1].diam / 2 : 0;
  const p = (pos !== undefined && pos !== null) ? pos : 0.5;
  return iR + p * (oR - iR);
}

function clockToXY(h, m, r) {
  const ang = ((h%12) + m/60) * 30 * Math.PI / 180;
  return { x: r * Math.sin(ang), y: r * Math.cos(ang) };
}

/* ── Stable, stepped view radius for target rendering ──
 * The view radius (in target inches) is chosen from a discrete set of
 * preferred steps tied to the target's ring boundaries. This avoids the
 * "zoom whiplash" of a per-shot continuous scale: instead of viewR jumping
 * smoothly with maxShotR, it snaps to a stable ring-aligned radius that
 * comfortably contains all shots, then *stays* there.
 *
 *   - Steps: each ring's outer edge × 1.10, plus a final step at outer × 1.05.
 *   - Pick the smallest step that contains every input point (with a small
 *     pad of 0.6" to avoid flickering when a shot sits right on a boundary).
 *   - If no shots, pick the step that contains the 10-ring comfortably.
 */
function steppedViewRadius(target, points, opts={}) {
  const pad = opts.pad ?? 0.6;
  const minStepIdx = opts.minStepIdx ?? 1; // never zoom tighter than this
  const rings = target.rings;
  // Build candidate radii from each ring's outer edge with overhang.
  const steps = rings.map(r => r.diam/2 * 1.10);
  steps.push(rings[rings.length-1].diam/2 * 1.05); // outer-edge ceiling
  // Largest required radius from input points.
  const maxR = (points||[])
    .filter(p => p && typeof p.x === 'number' && typeof p.y === 'number')
    .reduce((m,p) => Math.max(m, Math.hypot(p.x, p.y)), 0);
  const required = maxR > 0 ? maxR + pad : 0;
  // Find the smallest step that contains the required radius.
  for (let i = Math.max(0, minStepIdx); i < steps.length; i++) {
    if (steps[i] >= required) return steps[i];
  }
  return steps[steps.length-1];
}

/* Resolve a shot's (x,y) location in target inches. Prefers the explicit
 * shot.xy field set by tap-mode entry; falls back to deriving from ring/clock.
 * Single source of truth for "where did this shot land" used by analytics,
 * preview rendering, group plots, and exports.
 */
function shotXY(shot, target) {
  if (shot && shot.xy && typeof shot.xy.x === 'number' && typeof shot.xy.y === 'number') {
    return { x: shot.xy.x, y: shot.xy.y };
  }
  return clockToXY(shot.clockH, shot.clockM, ringMidR(target, shot.ring, shot.ringPos));
}

/* Inverse of (ring,ringPos,clockH,clockM) → xy.
 * Given an (x,y) in target inches (origin at center, +x right, +y up),
 * return { ring, ringPos, clockH, clockM } so the existing analytics
 * pipeline can compute ES/MR/score the same way regardless of input mode.
 * - ring = innermost ring whose outer radius >= |xy|, else outermost (a "5")
 * - ringPos = how far through that ring (0 = inner edge, 1 = outer edge)
 * - clock = 12-o'clock convention, with 12 = +y up, 3 = +x right
 */
/* ── Zone targets (non-circular) ─────────────────────────────────────────
 * A zone target has `zones` (ordered BEST score first — hit test returns the
 * first zone containing the point, so overlaps resolve to the better score,
 * matching how nested paper zones score) plus a synthesized `rings` array of
 * bounding-equivalent circles. The synthetic rings keep every ring-reading
 * consumer (view stepping, library pills, ringColor, chips) working
 * untouched; only the hit test and the tap-board renderer branch on zones.
 * Shapes, inches, target-centered coords (+x right, +y up), optional cx/cy:
 *   {kind:'circle', d}   {kind:'rect', w, h, rx?}   {kind:'poly', pts:[[x,y],..]}
 */
function pointInShape(shape, x, y) {
  const px = x - (shape.cx||0), py = y - (shape.cy||0);
  if (shape.kind === 'circle') return Math.hypot(px,py) <= shape.d/2;
  if (shape.kind === 'rect') {
    const hw = shape.w/2, hh = shape.h/2, rx = Math.min(shape.rx||0, hw, hh);
    const ax = Math.abs(px), ay = Math.abs(py);
    if (ax > hw || ay > hh) return false;
    if (ax <= hw-rx || ay <= hh-rx) return true;
    return Math.hypot(ax-(hw-rx), ay-(hh-rx)) <= rx; // corner arc
  }
  if (shape.kind === 'poly') {
    const pts = shape.pts; let inside = false;
    for (let i=0, j=pts.length-1; i<pts.length; j=i++) {
      const [xi,yi] = pts[i], [xj,yj] = pts[j];
      if ((yi>py) !== (yj>py) && px < (xj-xi)*(py-yi)/(yj-yi)+xi) inside = !inside;
    }
    return inside;
  }
  return false;
}
function shapeBoundR(shape) {
  const cx = shape.cx||0, cy = shape.cy||0;
  if (shape.kind === 'circle') return Math.hypot(cx,cy) + shape.d/2;
  if (shape.kind === 'rect')  return Math.hypot(Math.abs(cx)+shape.w/2, Math.abs(cy)+shape.h/2);
  if (shape.kind === 'poly')  return shape.pts.reduce((m,[x,y])=>Math.max(m,Math.hypot(x,y)),0);
  return 0;
}
// Same return contract as xyToRing so shot storage/chips/misses need no changes.
function xyToZone(target, x, y) {
  let degFromTwelve = Math.atan2(x, y) * 180 / Math.PI;
  if (degFromTwelve < 0) degFromTwelve += 360;
  const hourFloat = degFromTwelve / 30;
  let hour = Math.floor(hourFloat);
  let minute = Math.round((hourFloat - hour) * 60);
  if (minute === 60) { minute = 0; hour = (hour + 1) % 12; }
  if (hour === 0) hour = 12;
  const z = target.zones.find(zn => pointInShape(zn.shape, x, y));
  if (!z) return { ring: 'M', ringPos: 1, clockH: hour, clockM: minute };
  const bR = shapeBoundR(z.shape) || 1;
  return { ring: z.score, ringPos: Math.min(1, Math.hypot(x,y)/bR), clockH: hour, clockM: minute };
}
// Bounding-circle rings so ring-based consumers work unchanged. Sorted
// ascending like real rings; duplicate scores collapse to the smallest.
function synthRingsFromZones(zones) {
  const seen = new Set();
  return zones
    .map(z => ({ score: z.score, color: z.color, diam: 2*shapeBoundR(z.shape) }))
    .sort((a,b) => a.diam - b.diam)
    .filter(r => seen.has(r.score) ? false : (seen.add(r.score), true));
}

function xyToRing(target, x, y) {
  if (target.zones && target.zones.length) return xyToZone(target, x, y);
  const r = Math.sqrt(x*x + y*y);
  const rings = target.rings;

  // Clock: angle from +y axis going clockwise, in [0, 360)
  // sin(ang) = x/r, cos(ang) = y/r  →  ang = atan2(x, y)
  // Computed before the ring lookup because a miss (below) still has a
  // meaningful clock call — "missed at 2 o'clock" — even with no ring/ringPos.
  let degFromTwelve = Math.atan2(x, y) * 180 / Math.PI;
  if (degFromTwelve < 0) degFromTwelve += 360;
  // Each hour is 30 deg. Convert to {hour 1..12, minute 0..59}.
  const hourFloat = degFromTwelve / 30;                  // 0..12
  let hour = Math.floor(hourFloat);
  let minute = Math.round((hourFloat - hour) * 60);
  if (minute === 60) { minute = 0; hour = (hour + 1) % 12; }
  if (hour === 0) hour = 12;

  // Pick ring: smallest one whose outer radius >= r. If none, this is a clean
  // miss — off the target's scoring rings entirely. Previously this silently
  // clamped to the outermost ring (e.g. a shot well off the paper was scored
  // as a 5); now it's recorded as ring 'M' (0 points via scoreValue's
  // `+score||0` fallback) instead of inflating the total. Consistent with
  // scoreAtXY, which already scores outside-rings as 0 in the MC path.
  let idx = rings.findIndex(R => R.diam/2 >= r);
  if (idx < 0) {
    return { ring: 'M', ringPos: 1, clockH: hour, clockM: minute };
  }
  const ring = rings[idx].score;
  const oR = rings[idx].diam/2;
  const iR = idx > 0 ? rings[idx-1].diam/2 : 0;
  const ringPos = oR > iR ? Math.max(0, Math.min(1, (r - iR) / (oR - iR))) : 0.5;

  return { ring, ringPos, clockH: hour, clockM: minute };
}

function analytics(shots, target, yards) {
  if (!shots || shots.length < 1) return null;
  const recordShots = shots.filter(s => !s.isSighter);
  const allPts = shots.map(s => shotXY(s, target));
  if (recordShots.length < 2) {
    const score = recordShots.reduce((s,sh)=>s+(sh.ring==='X'?10:(+sh.ring||0)),0);
    const xs = recordShots.filter(s=>s.ring==='X').length;
    return { esIn:0, esMoa:0, mrIn:0, mrMoa:0, centX:0, centY:0, pts:allPts, score, xs, n:recordShots.length, hasSighters: shots.some(s=>s.isSighter) };
  }
  const recPts = recordShots.map(s => shotXY(s, target));
  let maxD = 0;
  for (let i=0;i<recPts.length;i++) for (let j=i+1;j<recPts.length;j++) maxD = Math.max(maxD, dist(recPts[i],recPts[j]));
  const cx = recPts.reduce((s,p)=>s+p.x,0)/recPts.length;
  const cy = recPts.reduce((s,p)=>s+p.y,0)/recPts.length;
  const mr = recPts.reduce((s,p)=>s+dist(p,{x:cx,y:cy}),0)/recPts.length;
  const score = recordShots.reduce((s,sh)=>s+(sh.ring==='X'?10:(+sh.ring||0)),0);
  const xs = recordShots.filter(s=>s.ring==='X').length;
  // Honest error bars: pooled isotropic σ with 90% CI (null when n < 3), and
  // the implied MR band via MR = σ·√(π/2). The point estimate shown remains
  // the observed MR; the band answers "how much of a delta is just luck".
  const sci = groupSigmaCI(recPts);
  return { esIn:maxD, esMoa:inchesToMoa(maxD,yards), mrIn:mr, mrMoa:inchesToMoa(mr,yards), centX:cx, centY:cy, pts:allPts, score, xs, n:recordShots.length, hasSighters: shots.some(s=>s.isSighter),
           sigmaIn: sci?.sigma ?? null, sigmaLoIn: sci?.lo ?? null, sigmaHiIn: sci?.hi ?? null,
           mrLoIn: sci ? sci.lo*SQRT_HALF_PI : null, mrHiIn: sci ? sci.hi*SQRT_HALF_PI : null };
}

/* Per-ammo-load dispersion summary across sessions.
 * Pooling raw shot XY across sessions would be wrong — each session has its
 * own zero/POI, so cross-session pooling conflates POI drift with dispersion.
 * Instead: compute MR/ES per session (each about its own group center via the
 * existing analytics()), then aggregate. MR is shot-weighted (a 20-shot
 * session tells you more than a 2-shot one). ES is reported as a plain mean
 * with the caveat that ES grows with n — comparable between loads only when
 * shot counts are similar, which the table exposes by printing n.
 * Sessions with < minShots record shots are excluded (2-shot "groups" are
 * noise, not data). Returns null when no qualifying sessions exist.
 */
function ammoStats(sessions, ammoId, getTarget, minShots = 3) {
  const rows = (sessions||[])
    .filter(s => s.ammoId === ammoId)
    .map(s => {
      const a = analytics(s.shots||[], getTarget(s.targetId), s.rangeYards);
      return a && a.n >= minShots ? { mrMoa:a.mrMoa, esMoa:a.esMoa, n:a.n } : null;
    })
    .filter(Boolean);
  if (!rows.length) return null;
  const shots = rows.reduce((s,r)=>s+r.n,0);
  const mrMoa = rows.reduce((s,r)=>s+r.mrMoa*r.n,0)/shots;         // shot-weighted
  const esMoa = rows.reduce((s,r)=>s+r.esMoa,0)/rows.length;       // per-session mean
  return { mrMoa, esMoa, sessions: rows.length, shots };
}

/* Fit a 95% dispersion (covariance) ellipse to {x,y} points in target inches.
 * Returns { cx, cy, ax, ay, thetaDeg, sigmaX, sigmaY, n } or null if < MIN points.
 *   ax/ay  : semi-major / semi-minor axis lengths (inches) at the 95% contour.
 *            2-D Gaussian: scale = sqrt(chi2inv(0.95, 2)) = sqrt(5.9915) ≈ 2.4477.
 *   thetaDeg: major-axis angle, CCW from +x (math convention, +y up).
 *   sigmaX/sigmaY: per-axis std-dev (inches) — the actionable read. sigmaY is
 *            vertical (elevation/breathing/ammo ES), sigmaX is horizontal
 *            (wind/trigger). These don't depend on the ellipse rotation.
 * Uses the sample covariance (÷ n-1). Needs ≥ 5 points to be meaningful; below
 * that the covariance is noise dressed as a shape, so callers should gate on n.
 */
const CHI2_95_2DOF = 5.991464547;
const ELLIPSE_MIN_SHOTS = 5;
function dispersionEllipse(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((s,p)=>s+p.x,0)/n;
  const my = pts.reduce((s,p)=>s+p.y,0)/n;
  let sxx=0, syy=0, sxy=0;
  for (const p of pts) { const dx=p.x-mx, dy=p.y-my; sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy; }
  const d = n - 1;
  sxx/=d; syy/=d; sxy/=d;
  const tr = sxx + syy;
  const det = sxx*syy - sxy*sxy;
  const root = Math.sqrt(Math.max(0, (tr/2)*(tr/2) - det));
  const l1 = tr/2 + root;                 // larger eigenvalue
  const l2 = Math.max(0, tr/2 - root);
  const scale = Math.sqrt(CHI2_95_2DOF);
  const ax = scale*Math.sqrt(Math.max(0,l1));
  const ay = scale*Math.sqrt(Math.max(0,l2));
  const thetaDeg = 0.5*Math.atan2(2*sxy, sxx - syy) * 180/Math.PI;
  return { cx:mx, cy:my, ax, ay, thetaDeg,
           sigmaX:Math.sqrt(Math.max(0,sxx)), sigmaY:Math.sqrt(Math.max(0,syy)), n };
}

/* ── Statistical honesty & simulation utilities ──────────────────────────
 * Small-n group stats have brutal sampling variance (MR from a 10-shot group
 * has CV ≈ 25–30%). Everything below exists to (a) put honest error bars on
 * the numbers the app already shows, and (b) answer "where do my points go"
 * via Monte Carlo against the exact ring geometry. No dependencies; all
 * closed-form approximations are commented with their source and accuracy.
 */

// Inverse standard normal CDF — Acklam's rational approximation (2003).
// |relative error| < 1.15e-9 over p ∈ (0,1).
function normInv(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a=[-3.969683028665376e+01, 2.209460984245205e+02,-2.759285104469687e+02, 1.383577518672690e+02,-3.066479806614716e+01, 2.506628277459239e+00];
  const b=[-5.447609879822406e+01, 1.615858368580409e+02,-1.556989798598866e+02, 6.680131188771972e+01,-1.328068155288572e+01];
  const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d=[ 7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow=0.02425, phigh=1-plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2*Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p <= phigh) {
    q = p-0.5; r = q*q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  q = Math.sqrt(-2*Math.log(1-p));
  return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

// Inverse chi-square CDF — Wilson–Hilferty cube approximation.
// Error ≲ 1% for dof ≥ 4, which is the gated minimum here (n ≥ 3 → dof ≥ 4).
function chi2Inv(p, k) {
  const z = normInv(p);
  const a = 2/(9*k);
  return k * Math.pow(1 - a + z*Math.sqrt(a), 3);
}

/* Pooled isotropic sigma of a shot group + 90% CI, in target inches.
 * Model: bivariate normal, center estimated from the data, so
 * SS/σ² ~ χ²(2n−2). CI: σ·sqrt(dof/χ²inv(1−α/2)) .. σ·sqrt(dof/χ²inv(α/2)).
 * Isotropic pooling (sxx+syy treated as one σ) is deliberate — it's the
 * scalar that underlies both MR and ES, and comparing two sessions on it is
 * the honest version of comparing their group sizes. Gated at n ≥ 3.
 */
const SQRT_HALF_PI = Math.sqrt(Math.PI/2);   // MR = σ·√(π/2) for circular normal
function groupSigmaCI(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((s,p)=>s+p.x,0)/n;
  const my = pts.reduce((s,p)=>s+p.y,0)/n;
  let ss = 0;
  for (const p of pts) ss += (p.x-mx)**2 + (p.y-my)**2;
  const dof = 2*n - 2;
  const sigma = Math.sqrt(ss/dof);
  return {
    sigma,
    lo: sigma * Math.sqrt(dof / chi2Inv(0.95, dof)),
    hi: sigma * Math.sqrt(dof / chi2Inv(0.05, dof)),
    dof, n,
  };
}

// Sample covariance of {x,y} points (÷ n−1). Shared by the MC scorer.
function covarianceOf(pts) {
  const n = pts.length;
  const mx = pts.reduce((s,p)=>s+p.x,0)/n;
  const my = pts.reduce((s,p)=>s+p.y,0)/n;
  let sxx=0, syy=0, sxy=0;
  for (const p of pts) { const dx=p.x-mx, dy=p.y-my; sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy; }
  const d = Math.max(1, n-1);
  return { mx, my, sxx:sxx/d, syy:syy/d, sxy:sxy/d, n };
}

// Deterministic PRNG (mulberry32) seeded from a string — keeps Monte Carlo
// numbers stable across re-renders instead of jittering.
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Score value of a center hit at (x,y) in target inches. Center-based like
// xyToRing — no bullet-diameter allowance, consistent with how the app scores
// tapped shots everywhere else.
function scoreValue(score) { return score === 'X' ? 10 : (+score || 0); }
function scoreAtXY(target, x, y) {
  const r = Math.hypot(x, y);
  const rings = [...target.rings].sort((a,b)=>a.diam-b.diam);
  for (const R of rings) if (r <= R.diam/2) return scoreValue(R.score);
  return 0;  // outside outermost ring = miss
}

// Expected per-shot score for a bivariate normal (cov) centered at (cx,cy),
// via Monte Carlo with a Cholesky transform. nSim ≈ 4000 gives SE ≈ 0.03 pts.
// Rings are presorted once outside the sample loop — this runs across every
// session for the season budget card, so the per-sample cost matters.
function expectedScoreMC(target, cov, cx, cy, nSim, rand) {
  const sorted = [...target.rings].sort((a,b)=>a.diam-b.diam);
  const radii = sorted.map(R => R.diam/2);
  const vals = sorted.map(R => scoreValue(R.score));
  const nr = radii.length;
  const a = Math.sqrt(Math.max(0, cov.sxx));
  const b = a > 1e-9 ? cov.sxy/a : 0;
  const c = Math.sqrt(Math.max(0, cov.syy - b*b));
  let sum = 0;
  for (let i = 0; i < nSim; i++) {
    const u1 = Math.max(rand(), 1e-12), u2 = rand();
    const m = Math.sqrt(-2*Math.log(u1));
    const z1 = m*Math.cos(2*Math.PI*u2), z2 = m*Math.sin(2*Math.PI*u2);
    const x = cx + a*z1, y = cy + b*z1 + c*z2;
    const r = Math.hypot(x, y);
    for (let j = 0; j < nr; j++) { if (r <= radii[j]) { sum += vals[j]; break; } }
  }
  return sum / nSim;
}

/* Score decomposition: given a session's record shots, split the gap to a
 * perfect score into (a) points lost to dispersion — what the fitted group
 * shape would drop even if perfectly centered — and (b) points lost to POI
 * offset — the extra cost of the centroid sitting off target center.
 * Offset losses = zero/NPOA problem; dispersion losses = fundamentals/ammo.
 * Gated at ELLIPSE_MIN_SHOTS for the same reason the ellipse is: below that
 * the covariance is noise dressed as a shape.
 */
const SCORE_MC_SIMS = 4000;
function scoreDecomposition(shots, target, yards, seedStr, nSim = SCORE_MC_SIMS) {
  const rec = (shots||[]).filter(s => !s.isSighter);
  if (rec.length < ELLIPSE_MIN_SHOTS || !target?.rings?.length) return null;
  const pts = rec.map(s => shotXY(s, target));
  const cov = covarianceOf(pts);
  const rand = mulberry32(hashStr(String(seedStr||'zero')));
  const expActual   = expectedScoreMC(target, cov, cov.mx, cov.my, nSim, rand);
  const expCentered = expectedScoreMC(target, cov, 0, 0, nSim, rand);
  const n = rec.length;
  const actual = rec.reduce((s,sh)=>s+scoreValue(sh.ring),0);
  const offsetIn = Math.hypot(cov.mx, cov.my);
  return {
    n,
    possible: 10*n,
    expActualTotal: expActual*n,
    expCenteredTotal: expCentered*n,
    lostDispersion: Math.max(0, 10*n - expCentered*n),
    lostOffset: expCentered*n - expActual*n,   // can go slightly <0 from MC noise
    actual,
    offsetIn,
    offsetMoa: yards ? inchesToMoa(offsetIn, yards) : null,
  };
}

// Small stats helpers for the pooled analyses below.
function meanOf(a) { return a.reduce((s,v)=>s+v,0)/a.length; }
function sdOf(a) { const m=meanOf(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/Math.max(1,a.length-1)); }
// Welch's t statistic for two samples (unequal variance).
function welchT(x, y) {
  if (x.length < 2 || y.length < 2) return 0;
  const vx = sdOf(x)**2/x.length, vy = sdOf(y)**2/y.length;
  const denom = Math.sqrt(vx+vy);
  return denom > 1e-12 ? (meanOf(x)-meanOf(y))/denom : 0;
}
// OLS slope of r on idx with its t statistic.
function olsSlope(samples) {
  const n = samples.length;
  if (n < 3) return { slope:0, t:0 };
  const mx = meanOf(samples.map(s=>s.idx)), my = meanOf(samples.map(s=>s.r));
  let sxx=0, sxy=0;
  for (const s of samples) { sxx += (s.idx-mx)**2; sxy += (s.idx-mx)*(s.r-my); }
  if (sxx < 1e-12) return { slope:0, t:0 };
  const slope = sxy/sxx;
  const resid = samples.map(s => s.r - (my + slope*(s.idx-mx)));
  const se2 = resid.reduce((s,v)=>s+v*v,0)/(n-2)/sxx;
  // Zero-residual degenerate case: a perfect linear trend is maximally
  // significant, not zero-significant. Only a zero slope maps to t = 0.
  if (se2 <= 1e-16) return { slope, t: Math.abs(slope) > 1e-12 ? 1e9 : 0 };
  return { slope, t: slope/Math.sqrt(se2) };
}

/* Shot-order effects, pooled across sessions per position.
 * Within each session every record shot's radial distance from that session's
 * own centroid is normalized by the session's mean radius — that removes
 * target/distance/day scale and makes shots poolable. Pooling RAW radii across
 * positions or distances would be statistically wrong; normalized radii with
 * per-position buckets is the defensible version.
 *   first-shot effect: mean normalized radius of record shot #1 vs the rest
 *   drift: OLS slope of normalized radius on shot index (fatigue signature)
 * Both flagged noise unless |t| > 2. Gates: ≥5 record shots per session,
 * ≥4 qualifying sessions per position.
 */
const SHOT_ORDER_MIN_SHOTS = 5;
const SHOT_ORDER_MIN_SESSIONS = 4;
function shotOrderAnalytics(sessions, getTarget) {
  const byPos = {};
  (sessions||[]).forEach(s => {
    const rec = (s.shots||[]).filter(sh => !sh.isSighter);
    if (rec.length < SHOT_ORDER_MIN_SHOTS) return;
    const tgt = getTarget(s.targetId);
    if (!tgt) return;
    const pts = rec.map(sh => shotXY(sh, tgt));
    const cx = pts.reduce((a,p)=>a+p.x,0)/pts.length;
    const cy = pts.reduce((a,p)=>a+p.y,0)/pts.length;
    const rs = pts.map(p => Math.hypot(p.x-cx, p.y-cy));
    const mr = meanOf(rs);
    if (mr <= 1e-6) return;
    const pos = (s.position||'').trim() || 'Unspecified';
    const b = (byPos[pos] ||= { pos, sessions:0, samples:[] });
    b.sessions++;
    rs.forEach((r,i) => b.samples.push({ idx:i+1, r:r/mr }));
  });
  return Object.values(byPos)
    .filter(b => b.sessions >= SHOT_ORDER_MIN_SESSIONS)
    .map(b => {
      const first = b.samples.filter(s=>s.idx===1).map(s=>s.r);
      const rest  = b.samples.filter(s=>s.idx>1).map(s=>s.r);
      if (!first.length || !rest.length) return null;
      const t = welchT(first, rest);
      const { slope, t:tS } = olsSlope(b.samples);
      return {
        pos: b.pos, sessions: b.sessions, n: b.samples.length,
        firstPct: (meanOf(first)/meanOf(rest) - 1) * 100,
        firstSig: Math.abs(t) > 2,
        slopePct: slope * 100,          // % of session MR per shot index
        slopeSig: Math.abs(tS) > 2,
      };
    })
    .filter(Boolean)
    .sort((a,b) => posRank(a.pos) - posRank(b.pos));
}

/* Correction response, pooled across sessions.
 * Sign convention (verified against ShotEntry UI): +elev clicks = POI up (+y),
 * +wind clicks = POI right (+x) — standard turret behavior. If a firearm is
 * ever mounted with a nonstandard turret sense this analysis inverts for it.
 *
 * gain: for each dial change ≥ 0.5 MOA (2 clicks) with ≥1 shot on each side
 * within the session, project the actual POI-centroid shift onto the predicted
 * shift: gain = (Δactual · Δpred)/|Δpred|². 1.0 = POI moves exactly as dialed.
 * Single events are dispersion-noise dominated; only the pooled mean means
 * anything, hence the n ≥ 6 gate. Sighters ARE included — the sighter phase is
 * exactly where corrections happen.
 *
 * flipRate: fraction of consecutive same-axis corrections with opposite sign.
 * Independent corrections flip ~50%; correcting off single shots instead of
 * group center produces strong negative autocorrelation and flip rates ≥ ~65%.
 */
const CORRECTION_MIN_EVENTS = 6;
const CORRECTION_MIN_PRED_MOA = 0.5;
function correctionAnalytics(sessions, getTarget) {
  const gains = [];
  const flips = [];
  (sessions||[]).forEach(s => {
    const shots = s.shots || [];
    if (shots.length < 3) return;
    const tgt = getTarget(s.targetId);
    const yards = +s.rangeYards;
    if (!tgt || !yards) return;
    const events = [];
    for (let k = 1; k < shots.length; k++) {
      const dE = (shots[k].elev||0) - (shots[k-1].elev||0);
      const dW = (shots[k].wind||0) - (shots[k-1].wind||0);
      if (dE !== 0 || dW !== 0) events.push({ k, dE, dW });
    }
    // Sign-flip pairs, per axis, within this session only.
    for (const axis of ['dE','dW']) {
      const signs = events.map(e => Math.sign(e[axis])).filter(v => v !== 0);
      for (let i = 1; i < signs.length; i++) flips.push(signs[i] !== signs[i-1] ? 1 : 0);
    }
    // Gain per qualifying event.
    const centroid = arr => {
      const ps = arr.map(sh => shotXY(sh, tgt));
      return { x: ps.reduce((a,p)=>a+p.x,0)/ps.length, y: ps.reduce((a,p)=>a+p.y,0)/ps.length };
    };
    for (let i = 0; i < events.length; i++) {
      const predX = clicksToMoa(events[i].dW), predY = clicksToMoa(events[i].dE);
      const p2 = predX*predX + predY*predY;
      if (Math.sqrt(p2) < CORRECTION_MIN_PRED_MOA) continue;
      const start = i === 0 ? 0 : events[i-1].k;
      const end = i+1 < events.length ? events[i+1].k : shots.length;
      const pre = shots.slice(start, events[i].k), post = shots.slice(events[i].k, end);
      if (!pre.length || !post.length) continue;
      const c0 = centroid(pre), c1 = centroid(post);
      const dxMoa = inchesToMoa(c1.x - c0.x, yards);
      const dyMoa = inchesToMoa(c1.y - c0.y, yards);
      gains.push((dxMoa*predX + dyMoa*predY) / p2);
    }
  });
  return {
    gain: gains.length >= CORRECTION_MIN_EVENTS
      ? { n: gains.length, mean: meanOf(gains), sd: sdOf(gains) } : null,
    flip: flips.length >= CORRECTION_MIN_EVENTS
      ? { n: flips.length, rate: meanOf(flips) } : null,
  };
}

/* ── Backup interchange ──────────────────────────────────────────────────
 * Lenient backup parser. Accepts, in order of preference:
 *   1. The wrapped format this build writes: {schema:'zero-backup', data:{...}}
 *   2. Bare top-level storage keys: {sessions_v1:[...], rifles_v1:[...], ...}
 *      (what the PWA build's exporter writes)
 *   3. Legacy unversioned names: sessions/rifles/firearms/matches/
 *      customTargets/custom_targets/deletedBuiltins/deleted_builtins
 * Also tolerates a UTF-8 BOM, stray whitespace, and junk around the outermost
 * {...} (share-sheet re-saves on iOS can wrap or re-encode the file).
 * Returns {ok:true, data, found, counts} or {ok:false, error}. `data` only
 * contains keys that were actually present, so a partial file only replaces
 * what it carries. Sessions are lightly sanitized (object check, id, shots
 * array) — replace semantics otherwise, no merging.
 */
const BACKUP_KEY_ALIASES = {
  sessions:        ['sessions_v1', 'sessions'],
  firearms:        ['rifles_v1', 'rifles', 'firearms'],
  matches:         ['matches_v1', 'matches'],
  customTargets:   ['custom_targets_v1', 'customTargets', 'custom_targets'],
  deletedBuiltins: ['deleted_builtins_v1', 'deletedBuiltins', 'deleted_builtins'],
  ammo:            ['ammo_v1', 'ammo', 'ammoLoads', 'ammo_loads'],
};
function parseBackupText(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok:false, error:'empty file' };
  let t = text.replace(/^\uFEFF/, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(t); }
  catch {
    // Salvage: extract the outermost {...} and retry.
    const i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i >= 0 && j > i) { try { parsed = JSON.parse(t.slice(i, j+1)); } catch {} }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { ok:false, error:'file is not a JSON object' };
  // Unwrap {schema:'zero-backup', data:{...}} or any {data:{...}} wrapper.
  const root = (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data))
    ? parsed.data : parsed;
  const data = {}, found = [];
  for (const [canon, aliases] of Object.entries(BACKUP_KEY_ALIASES)) {
    for (const k of aliases) {
      if (Array.isArray(root[k])) { data[canon] = root[k]; found.push(canon); break; }
    }
  }
  if (!found.length) return { ok:false, error:'no recognizable Zero data (sessions/firearms/matches/targets) found in file' };
  if (data.sessions) {
    data.sessions = data.sessions
      .filter(s => s && typeof s === 'object')
      .map(s => ({ ...s, id: s.id || uid(), shots: Array.isArray(s.shots) ? s.shots : [] }));
  }
  const counts = `${(data.sessions||[]).length} sessions · ${(data.firearms||[]).length} firearms · ${(data.matches||[]).length} matches · ${(data.customTargets||[]).length} custom targets`;
  return { ok:true, data, found, counts };
}

/* ── Match course-of-fire templates ──────────────────────────────────────
 * NRA High Power Rules (verified against competitions.nra.org rulebook and
 * program pages, July 2026):
 *   NMC 50-shot: 10 slow standing 200 (SR) · 10 rapid sitting/kneeling 200
 *   (SR) · 10 rapid prone 300 (SR-3) · 20 slow prone 600 (MR-1) = 500 pts.
 *   Regional/XTC 80-shot: 20 · 2×10 · 2×10 · 20, same order = 800 pts.
 * Zero logs each rapid-fire pair as ONE session — same target frame, same
 * position, same DOPE slot; string boundaries aren't tracked at shot level.
 * Two sighters per stage are allowed in NRA (not EIC) — log them with the
 * sighter tag as usual. Re-verify time limits/COF against the current
 * rulebook before relying on this at a sanctioned match.
 */
const MATCH_TEMPLATES = [
  { id:'nmc50', name:'National Match Course · 50 shots', type:'NMC', stages:[
    { name:'Stage 1 · Standing slow · 200', targetId:'sr',  rangeYards:200, position:'Standing', fireMode:'Slow',  shots:10 },
    { name:'Stage 2 · Sitting rapid · 200', targetId:'sr',  rangeYards:200, position:'Sitting',  fireMode:'Rapid', shots:10 },
    { name:'Stage 3 · Prone rapid · 300',   targetId:'sr3', rangeYards:300, position:'Prone',    fireMode:'Rapid', shots:10 },
    { name:'Stage 4 · Prone slow · 600',    targetId:'mr1', rangeYards:600, position:'Prone',    fireMode:'Slow',  shots:20 },
  ]},
  { id:'xtc80', name:'Regional / XTC · 80 shots', type:'Across the Course', stages:[
    { name:'Stage 1 · Standing slow · 200',        targetId:'sr',  rangeYards:200, position:'Standing', fireMode:'Slow',  shots:20 },
    { name:'Stage 2 · Sitting rapid · 200 (2×10)', targetId:'sr',  rangeYards:200, position:'Sitting',  fireMode:'Rapid', shots:20 },
    { name:'Stage 3 · Prone rapid · 300 (2×10)',   targetId:'sr3', rangeYards:300, position:'Prone',    fireMode:'Rapid', shots:20 },
    { name:'Stage 4 · Prone slow · 600',           targetId:'mr1', rangeYards:600, position:'Prone',    fireMode:'Slow',  shots:20 },
  ]},
];
// Build a match + its stage sessions from a template. Stage ts values are
// staggered +i so SessionsList's ascending-ts sub-sort preserves firing order.
// Ammo: high-power convention is one load for the short line (200/300) and a
// heavier bullet for 600 (e.g. 77gr short line, 80gr at 600 — mag-length vs
// single-load), so the form offers two slots. Assignment is by stage
// distance: >= 600 gets ammoLong, everything else ammoShort. Either slot may
// be null (its stages just get no ammoId, same as manual session creation).
// The load name is mirrored into ammoDesc for display continuity in DOPE
// cells and chips, matching the NewSession picker's behavior.
function buildMatchFromTemplate(tpl, { name, date, rifleId, rangeLocation, ammoShort, ammoLong } = {}) {
  const now = Date.now();
  const match = { id: uid(), name: (name||'').trim() || tpl.name, type: tpl.type, date: date || '', ts: now };
  const sessions = tpl.stages.map((st, i) => {
    const load = st.rangeYards >= 600 ? ammoLong : ammoShort;
    return {
      id: uid(), matchId: match.id, ts: now + i,
      name: st.name, date: date || '', type: 'Score',
      position: st.position, fireMode: st.fireMode,
      targetId: st.targetId, rangeYards: st.rangeYards,
      rangeLocation: (rangeLocation||'').trim(), rifleId: rifleId || '',
      wSpeed:'', wDir:6, temp:'', lighting:'Clear',
      ammoLot:'', ammoDesc: load ? load.name : '', equipment:'',
      ...(load ? { ammoId: load.id } : {}),
      shots: [],
    };
  });
  return { match, sessions };
}

/* ── NRA HP classification (conventional/XTC) ────────────────────────────
 * NRA HP Rules Sec. 19 percentages, verified July 2026: HM ≥97 · MA 94–96.99
 * · EX 89–93.99 · SS 84–88.99 · MK <84. These are the CONVENTIONAL High
 * Power bands — F-class and Mid-Range Prone use different tables.
 * classificationPace computes the rolling percentage over the most recent
 * match-linked record shots, capped at 240 (the NRA reclassification window),
 * walking matches newest → oldest and taking whole sessions.
 */
const NRA_HP_CLASSES = [
  { name:'High Master', min:97 },
  { name:'Master',      min:94 },
  { name:'Expert',      min:89 },
  { name:'Sharpshooter',min:84 },
  { name:'Marksman',    min:0  },
];
function classifyPct(pct) {
  for (const c of NRA_HP_CLASSES) if (pct >= c.min) return c;
  return NRA_HP_CLASSES[NRA_HP_CLASSES.length-1];
}
const CLASSIFICATION_WINDOW_SHOTS = 240;
const CLASSIFICATION_MIN_SHOTS = 50;
function classificationPace(sessions, matches) {
  const matchIds = new Set((matches||[]).map(m=>m.id));
  const eligible = (sessions||[])
    .filter(s => s.matchId && matchIds.has(s.matchId) && s.type !== 'Sight adjustment')
    .sort((a,b)=>(b.ts||0)-(a.ts||0));   // newest first
  let shots = 0, points = 0;
  for (const s of eligible) {
    if (shots >= CLASSIFICATION_WINDOW_SHOTS) break;
    const rec = (s.shots||[]).filter(sh=>!sh.isSighter);
    if (!rec.length) continue;
    shots += rec.length;
    points += rec.reduce((sum,sh)=>sum+scoreValue(sh.ring),0);
  }
  if (shots < CLASSIFICATION_MIN_SHOTS) return null;
  const pct = (points / (10*shots)) * 100;
  const band = classifyPct(pct);
  const idx = NRA_HP_CLASSES.findIndex(c=>c.name===band.name);
  const next = idx > 0 ? NRA_HP_CLASSES[idx-1] : null;
  return {
    pct, shots, points, band: band.name,
    next: next ? {
      name: next.name,
      // Points short of the next band over a 50-shot / 500-point match.
      ptsPer50: Math.max(0, Math.ceil((next.min - pct) * 5)),
    } : null,
  };
}

/* ── Zero drift detection ────────────────────────────────────────────────
 * Given a DOPE cell's sessions (newest first), flag when the confirmed zero
 * has walked ≥ DRIFT_MIN_CLICKS on either axis between the oldest and newest
 * usable entries (≥3 entries with logged dial). Newest−oldest delta rather
 * than range: a monotonic walk is drift (mount/optic/barrel); oscillation is
 * conditions. Caveat still applies — temp and ammo changes shift real zeros,
 * so this is a "look at it", not a "fix it".
 */
const DRIFT_MIN_CLICKS = 3;   // 0.75 MOA at 1/4-MOA clicks
function zeroDriftInfo(cellSessions) {
  const usable = (cellSessions||[]).filter(e => !e.noDope);
  if (usable.length < 3) return null;
  const newest = usable[0], oldest = usable[usable.length-1];
  const dE = (newest.elev||0) - (oldest.elev||0);
  const dW = (newest.wind||0) - (oldest.wind||0);
  const flagged = [];
  if (Math.abs(dE) >= DRIFT_MIN_CLICKS) flagged.push({ axis:'E', clicks:dE });
  if (Math.abs(dW) >= DRIFT_MIN_CLICKS) flagged.push({ axis:'W', clicks:dW });
  return flagged.length ? { flagged, n: usable.length } : null;
}

/* ── Season points budget ────────────────────────────────────────────────
 * Aggregate of scoreDecomposition across sessions, bucketed by position ×
 * distance, expressed as points lost per 10 shots so buckets of different
 * volume are comparable. Ranked by total loss rate = training-time
 * allocator. Reduced sim count per session (the SE sums, but so does n).
 */
const SEASON_MC_SIMS = 2500;
const SEASON_MIN_SESSIONS = 2;
const SEASON_MIN_SHOTS = 20;
function seasonBudget(sessions, getTarget) {
  const buckets = {};
  (sessions||[]).forEach(s => {
    const tgt = getTarget(s.targetId);
    const yards = +s.rangeYards;
    if (!tgt || !yards) return;
    const dec = scoreDecomposition(s.shots, tgt, yards, s.id, SEASON_MC_SIMS);
    if (!dec) return;
    const pos = (s.position||'').trim() || 'Unspecified';
    const key = `${pos}|${yards}`;
    const b = (buckets[key] ||= { pos, yards, sessions:0, shots:0, lostD:0, lostO:0 });
    b.sessions++; b.shots += dec.n;
    b.lostD += dec.lostDispersion; b.lostO += Math.max(0, dec.lostOffset);
  });
  return Object.values(buckets)
    .filter(b => b.sessions >= SEASON_MIN_SESSIONS && b.shots >= SEASON_MIN_SHOTS)
    .map(b => ({
      ...b,
      dPer10: 10*b.lostD/b.shots, oPer10: 10*b.lostO/b.shots,
      totalPer10: 10*(b.lostD+b.lostO)/b.shots,
    }))
    .sort((a,b) => b.totalPer10 - a.totalPer10);
}

/* Wind call accuracy:
 *   For each shot with a wind call, compare predicted hold (MOA + direction) to
 *   actual horizontal POI deviation from group center. A good caller has small
 *   signed error; a biased caller has consistent sign (e.g. always under-calling R).
 *   All values in MOA.
 */
function windCallAnalytics(shots, target, yards) {
  const called = (shots||[]).filter(s => !s.isSighter && typeof s.windCallMoa === 'number');
  if (called.length < 1) return null;

  const recordShots = shots.filter(s => !s.isSighter);
  const pts = recordShots.map(s => shotXY(s, target));
  const cx = pts.reduce((s,p)=>s+p.x,0)/pts.length;
  const cy = pts.reduce((s,p)=>s+p.y,0)/pts.length;

  const items = called.map(sh => {
    const p = shotXY(sh, target);
    // Horizontal deviation in inches from group center (X axis = horizontal)
    const horizIn = p.x - cx;
    const actualHoldMoa = inchesToMoa(Math.abs(horizIn), yards);
    const actualDir = horizIn > 0 ? 'R' : 'L';
    // Signed predicted hold: R = positive, L = negative
    const predSigned = sh.windCallDir === 'R' ? sh.windCallMoa : -sh.windCallMoa;
    const actualSigned = actualDir === 'R' ? actualHoldMoa : -actualHoldMoa;
    // Error: positive if over-called to R (or under-called to L)
    const errMoa = predSigned - actualSigned;
    return { shot:sh, predSigned, actualSigned, errMoa };
  });

  const meanErr = items.reduce((s,i)=>s+i.errMoa,0)/items.length;
  const absMeanErr = items.reduce((s,i)=>s+Math.abs(i.errMoa),0)/items.length;
  // Bias: does the shooter consistently miss in one direction?
  const biasDir = meanErr > 0.1 ? 'R' : meanErr < -0.1 ? 'L' : 'neutral';
  return { items, meanErr, absMeanErr, biasDir, n:items.length };
}

/* ── IndexedDB safety mirror ─────────────────────────────────────────────
 * The primary store (window.storage — localStorage-backed in the PWA build)
 * is evictable: Safari treats script-writable storage as cache and can wipe
 * it. This mirror writes one snapshot of all five keys to IndexedDB, a
 * separate storage bucket the browser evicts independently (and later, if
 * navigator.storage.persist() is granted, ideally not at all). On boot, if
 * the primary store comes up empty but the mirror has data, the app offers a
 * one-tap restore. Everything is feature-detected and try/caught — in
 * contexts without IndexedDB (some sandboxed iframes) it silently no-ops.
 * Writes are guarded against empty state so a post-eviction boot can never
 * clobber a good snapshot with nothing.
 */
const MIRROR_DB = 'zero_mirror', MIRROR_STORE = 'kv', MIRROR_KEY = 'snapshot_v1';
function idbOpen() {
  return new Promise((resolve, reject) => {
    let rq;
    try {
      if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
      rq = indexedDB.open(MIRROR_DB, 1);
    } catch (e) { return reject(e); }
    rq.onupgradeneeded = () => { try { rq.result.createObjectStore(MIRROR_STORE); } catch {} };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
    rq.onblocked = () => reject(new Error('blocked'));
  });
}
async function idbWriteSnapshot(snap) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(MIRROR_STORE, 'readwrite');
      tx.objectStore(MIRROR_STORE).put(snap, MIRROR_KEY);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch { return false; }
}
async function idbReadSnapshot() {
  try {
    const db = await idbOpen();
    const snap = await new Promise((resolve, reject) => {
      const tx = db.transaction(MIRROR_STORE, 'readonly');
      const rq = tx.objectStore(MIRROR_STORE).get(MIRROR_KEY);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => reject(rq.error);
    });
    db.close();
    return snap;
  } catch { return null; }
}

/* ── DOPE card text ──────────────────────────────────────────────────────
 * Plain-monospace confirmed-zero card for printing/taping to the stock.
 * Takes DopeTab's byFirearm grouping (firearm → location → cells, cells'
 * sessions newest-first). Values in MOA, up/right positive, matching the
 * on-screen convention.
 */
function dopeCardText(byFirearm) {
  const lines = [];
  const today = new Date().toISOString().slice(0,10);
  lines.push(`ZERO — DOPE CARD · ${today}`);
  lines.push(`E/W in MOA · up/right + · ${MOA_PER_CLICK} MOA/click`);
  for (const [fname, locs] of Object.entries(byFirearm)) {
    lines.push('');
    lines.push(`== ${fname} ==`);
    for (const [loc, cs] of Object.entries(locs)) {
      lines.push(`-- ${loc} --`);
      for (const cell of cs) {
        const h = cell.sessions[0];
        const zero = h.noDope ? 'no dial logged' : `E${fmtMoaSigned(h.elev)}  W${fmtMoaSigned(h.wind)}`;
        const meta = [h.date, h.ammo].filter(Boolean).join(' · ');
        lines.push(`${String(cell.yards).padStart(4)}yd  ${cell.position.padEnd(12).slice(0,12)} ${zero}${meta ? `   (${meta})` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

const S = `
@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@400;500;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{
  /* viewport-fit=cover extends the page under the status bar and the home
   * indicator. Those insets have to be paid back or the sticky header rides up
   * under the clock. Left/right matter in landscape, where the notch eats a
   * side. */
  --safe-t:env(safe-area-inset-top,0px);
  --safe-b:env(safe-area-inset-bottom,0px);
  --safe-l:env(safe-area-inset-left,0px);
  --safe-r:env(safe-area-inset-right,0px);
  --bg:#0f1117;--surf:#1a1d27;--surf2:#252836;--bdr:#353848;
  --ink:#f0f2f8;--dim:#9099b0;--acc:#e8943a;
  --red:#f06060;--green:#3db87a;
  --fh:'DM Sans',sans-serif;--fm:'Space Mono',monospace;
}
body{background:var(--bg);color:var(--ink);font-family:var(--fh);font-size:14px;-webkit-font-smoothing:antialiased}
.app{max-width:430px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column;padding-bottom:var(--safe-b)}
.hdr{background:var(--surf);border-bottom:1px solid var(--bdr);padding:calc(11px + var(--safe-t)) calc(15px + var(--safe-r)) 11px calc(15px + var(--safe-l));display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:40}
.htitle{font-family:var(--fh);font-size:17px;font-weight:700;letter-spacing:.01em}
.hsub{font-family:var(--fm);font-size:9px;color:var(--dim);letter-spacing:.12em;margin-top:1px}
.badd{background:var(--acc);color:#0f1117;border:none;border-radius:5px;padding:6px 14px;font-family:var(--fh);font-size:13px;font-weight:700;cursor:pointer}
.bback{background:none;border:none;color:var(--acc);font-family:var(--fh);font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:3px;letter-spacing:.01em}
.content{flex:1;overflow-y:auto;padding-bottom:74px}
.tabbar{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:430px;background:var(--surf);border-top:1px solid var(--bdr);display:flex;z-index:100;padding-bottom:var(--safe-b)}
.tab{flex:1;padding:8px 4px 10px;display:flex;flex-direction:column;align-items:center;gap:2px;background:none;border:none;cursor:pointer;color:var(--dim);transition:color .15s}
.tab.on{color:var(--acc)}
.tabi{font-size:17px}
.tabl{font-family:var(--fh);font-size:10px;font-weight:500;letter-spacing:.04em}
.card{background:var(--surf);border:1px solid var(--bdr);border-radius:9px;margin:8px 13px;overflow:hidden;cursor:pointer;transition:border-color .15s}
.card:hover{border-color:var(--acc)44}
.card:active{background:var(--surf2)}
.ctop{padding:12px 13px 9px;border-bottom:1px solid var(--bdr);display:flex;justify-content:space-between;align-items:flex-start}
.cname{font-family:var(--fh);font-size:15px;font-weight:700}
.cmeta{font-family:var(--fm);font-size:10px;color:var(--dim);margin-top:2px}
.cbody{padding:10px 13px;display:flex;gap:18px;align-items:flex-end}
.sv{font-family:var(--fm);font-size:17px;color:var(--acc)}
.sl{font-family:var(--fm);font-size:9px;color:var(--dim);letter-spacing:.08em;margin-top:1px}
.shdr{padding:14px 13px 5px;font-family:var(--fm);font-size:9px;color:var(--dim);letter-spacing:.14em;text-transform:uppercase}
.form{padding:13px;display:flex;flex-direction:column;gap:13px}
.field{display:flex;flex-direction:column;gap:5px}
.lbl{font-family:var(--fm);font-size:9px;color:var(--acc);letter-spacing:.1em;text-transform:uppercase}
.inp{background:var(--surf2);border:1.5px solid var(--bdr);border-radius:5px;padding:9px 11px;color:var(--ink);font-family:var(--fm);font-size:13px;outline:none;width:100%;transition:border-color .15s;-webkit-appearance:none}
.inp:focus{border-color:var(--acc);background:#1e2235}
select.inp{cursor:pointer}
.row2{display:flex;gap:9px}
.row2 .field{flex:1}
.bprim{background:var(--acc);color:#0f1117;border:none;border-radius:5px;padding:12px;font-family:var(--fh);font-size:15px;font-weight:700;cursor:pointer;width:100%}
.bprim:active{filter:brightness(.88)}
.bgreen{background:var(--green);color:#0f1117;border:none;border-radius:5px;padding:12px;font-family:var(--fh);font-size:15px;font-weight:700;cursor:pointer;width:100%}
.bgreen:active{filter:brightness(.88)}
.bsec{background:transparent;color:var(--dim);border:1px solid var(--bdr);border-radius:5px;padding:11px;font-family:var(--fh);font-size:14px;cursor:pointer;width:100%;margin-top:3px}
.bdel{background:none;border:none;color:var(--red);font-family:var(--fm);font-size:10px;cursor:pointer;letter-spacing:.05em}
.agrid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--bdr);border:1px solid var(--bdr);border-radius:9px;overflow:hidden;margin:0 13px}
.acell{background:var(--surf);padding:13px 12px}
.av{font-family:var(--fm);font-size:21px;color:var(--acc)}
.au{font-family:var(--fm);font-size:9px;color:var(--dim)}
.al{font-size:10px;color:var(--dim);margin-top:3px;font-family:var(--fm);letter-spacing:.05em}
.srow{display:flex;align-items:center;padding:9px 13px;border-bottom:1px solid var(--bdr)55;gap:9px}
.sn{font-family:var(--fm);font-size:9px;color:var(--dim);width:17px;text-align:right}
.sr-ring{font-family:var(--fh);font-size:18px;font-weight:700;width:24px;text-align:center}
.scall{font-family:var(--fm);font-size:11px;color:var(--dim);flex:1}
.ssight{font-family:var(--fm);font-size:10px;color:var(--dim)}
.delx{background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px;padding:2px 4px;line-height:1}
.scoresel{display:flex;gap:7px;flex-wrap:wrap}
.sbtn{width:52px;height:52px;border-radius:7px;border:1.5px solid var(--bdr);background:var(--surf2);font-family:var(--fh);font-size:19px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .1s}
.sbtn.on{border-width:2.5px;background:var(--surf)}
.ckface{border-radius:50%;border:1.5px solid var(--bdr);position:relative;background:var(--surf2);flex-shrink:0;touch-action:none}
.ckhand{position:absolute;bottom:50%;left:50%;width:2px;background:var(--acc);transform-origin:bottom center;border-radius:2px 2px 0 0}
.ckdot{position:absolute;width:6px;height:6px;border-radius:50%;background:var(--acc);top:50%;left:50%;transform:translate(-50%,-50%)}
.chips{display:flex;flex-wrap:wrap;gap:5px;padding:0 13px 11px}
.chip{font-family:var(--fm);font-size:9px;padding:3px 7px;background:var(--surf2);border:1px solid var(--bdr);border-radius:3px;color:var(--acc)}
.plotwrap{margin:0 13px;background:var(--surf);border:1px solid var(--bdr);border-radius:9px;overflow:hidden}
.plothdr{padding:9px 12px;border-bottom:1px solid var(--bdr);font-family:var(--fm);font-size:9px;color:var(--dim);letter-spacing:.1em;text-transform:uppercase}
.empty{padding:44px 20px;text-align:center;color:var(--dim)}
.et{font-family:var(--fh);font-size:16px;font-weight:700;color:var(--ink);margin-bottom:6px}
.es{font-size:13px;line-height:1.6}
.tcard{background:var(--surf);border:1px solid var(--bdr);border-radius:9px;margin:7px 13px;overflow:hidden}
.tch{padding:11px 13px;display:flex;justify-content:space-between;align-items:center;cursor:pointer}
.tcn{font-family:var(--fh);font-size:15px;font-weight:700}
.tcd{font-family:var(--fm);font-size:9px;color:var(--dim)}
.rt{width:100%;border-collapse:collapse}
.rt th,.rt td{padding:6px 13px;text-align:left;font-family:var(--fm);font-size:11px;border-top:1px solid var(--bdr)66}
.rt th{color:var(--dim);font-size:9px;letter-spacing:.08em;text-transform:uppercase}
.tnote{padding:9px 13px 13px;font-family:var(--fm);font-size:9px;color:var(--dim);line-height:1.7}
.stepper{display:flex;align-items:center;border:1.5px solid var(--bdr);border-radius:5px;overflow:hidden;background:var(--surf2)}
.stepbtn{width:40px;height:40px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--acc);display:flex;align-items:center;justify-content:center;flex-shrink:0;-webkit-tap-highlight-color:transparent}
.stepbtn:active{background:var(--bdr)}
.stepval{flex:1;text-align:center;font-family:var(--fm);font-size:14px;font-weight:700;color:var(--ink)}
.shotbar{background:var(--surf);border-top:1px solid var(--bdr);padding:10px 13px;display:flex;gap:8px;position:sticky;bottom:0;z-index:20}
.ringinp{background:var(--surf2);border:1.5px solid var(--bdr);border-radius:4px;padding:6px 8px;color:var(--ink);font-family:var(--fm);font-size:12px;outline:none;width:100%;-webkit-appearance:none}
.ringinp:focus{border-color:var(--acc)}
.colorpicker-wrap{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}
.colorpatch{width:24px;height:24px;border-radius:4px;cursor:pointer;border:2px solid transparent;transition:border-color .1s;flex-shrink:0}
.colorpatch.on{border-color:var(--ink)}
.colorpatch-custom{position:relative;overflow:hidden}
.colorpatch-custom input[type=color]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.mcard{background:var(--surf);border:1px solid var(--bdr);border-radius:9px;margin:8px 13px;overflow:hidden}
.mhdr{padding:11px 13px 9px;display:flex;justify-content:space-between;align-items:flex-start;cursor:pointer;border-bottom:1px solid var(--bdr)}
.mhdr:active{background:var(--surf2)}
.mtitle{font-family:var(--fh);font-size:15px;font-weight:700}
.mmeta{font-family:var(--fm);font-size:10px;color:var(--dim);margin-top:2px}
.mstats{padding:9px 13px;display:flex;gap:18px;align-items:flex-end;border-bottom:1px solid var(--bdr)}
.msubs{padding:6px 0 4px}
.msub{display:flex;align-items:center;padding:8px 13px 8px 0;cursor:pointer;transition:background .1s;gap:0}
.msub:active{background:var(--surf2)}
.mbrack{width:24px;flex-shrink:0;display:flex;align-items:stretch;justify-content:center;position:relative}
.mbrack-line{width:2px;background:var(--bdr);border-radius:1px}
.mbrack-arm{position:absolute;left:50%;top:50%;width:8px;height:2px;background:var(--bdr);border-radius:1px}
.mbrack-first .mbrack-line{top:50%;height:50%}
.mbrack-last .mbrack-line{bottom:50%;height:50%}
.mbrack-only .mbrack-line{display:none}
.msub-body{flex:1;min-width:0}
.msub-name{font-family:var(--fh);font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msub-meta{font-family:var(--fm);font-size:9px;color:var(--dim);margin-top:1px}
.msub-stats{display:flex;gap:12px;margin-top:4px}
.msub-sv{font-family:var(--fm);font-size:13px;color:var(--acc)}
.msub-sl{font-family:var(--fm);font-size:8px;color:var(--dim);letter-spacing:.06em}
.madd{background:none;border:1px dashed var(--bdr);border-radius:5px;margin:0 13px 8px;padding:7px;font-family:var(--fm);font-size:10px;color:var(--dim);cursor:pointer;width:calc(100% - 26px);text-align:left}
.madd:active{background:var(--surf2)}
`;


/* ════════════════════════════════════════════════════════════════════════
 * CLOUD SYNC — shared Supabase backend with Bench.
 *
 * zero-core is the shared auth+sync module (embedded verbatim in both apps;
 * 47-assertion suite lives beside it). Zero's local model stays the source
 * of truth for the UI; sync adds three things:
 *   1. an account (email/password) with offline-queued writes,
 *   2. ammo loads LINKED to Bench batches (imported from
 *      v_ballistic_profiles, carrying the batch serial + safety flags),
 *   3. results flowing back: for every session shot with a linked load,
 *      a range_sessions row + a groups row (ES/MR converted to INCHES —
 *      the schema deliberately splits group_es_in from velocity_es_fps).
 * ══════════════════════════════════════════════════════════════════════ */
//#region zero-core — GENERATED from packages/zero-core/zero-core.js, do not edit
/* ============================================================================
 * zero-core — shared auth + sync layer for the Zero PWA family
 *
 * One module, embedded byte-identically in every app (Zero, the reloading
 * Bench, anything later). No SDK, no build step, no dependencies: it talks to
 * Supabase's GoTrue and PostgREST endpoints with fetch, so each app stays a
 * single self-contained file and still works with no signal.
 *
 * Design commitments, each of which exists because the obvious version is wrong:
 *
 *   - A 401 triggers ONE refresh shared by every in-flight request. Naive
 *     per-request refresh stampedes: ten parallel requests become ten refresh
 *     calls, nine of which present an already-rotated token and fail.
 *   - The outbox flushes in declared table order, which IS foreign-key order.
 *     Pushing a `shots` row before its `range_sessions` parent is a 409.
 *   - The pull cursor advances to the greatest `updated_at` actually returned by
 *     the server, never to the client's clock. Using local `now()` silently
 *     drops every row written between the query and the cursor write.
 *   - `updated_at` is never sent. The server stamps it; phone clocks drift and a
 *     device offline since yesterday would otherwise win every conflict.
 *   - A pull never clobbers a row with unsent local edits.
 * ==========================================================================*/
'use strict';

const ZeroCore = (() => {

  /* ---------------------------------------------------------------- events */
  /** Every event this module emits. Nothing else is emitted; nothing here is
   *  emitted from anywhere else. Both apps can rely on this list being total. */
  const EVENTS = Object.freeze({
    AUTH_SIGNED_IN:      'auth:signed-in',      // { user }
    AUTH_SIGNED_OUT:     'auth:signed-out',     // { reason: 'user'|'refresh-failed'|'revoked' }
    AUTH_TOKEN_REFRESHED:'auth:token-refreshed',// { expiresAt }
    AUTH_ERROR:          'auth:error',          // { phase, error }
    NET_ONLINE:          'net:online',          // {}
    NET_OFFLINE:         'net:offline',         // {}
    SYNC_START:          'sync:start',          // { trigger }
    SYNC_PULLED:         'sync:pulled',         // { table, rows, cursor }
    SYNC_PUSHED:         'sync:pushed',         // { table, rows }
    SYNC_CONFLICT:       'sync:conflict',       // { table, id, resolution }
    SYNC_DONE:           'sync:done',           // { pulled, pushed, conflicts, ms }
    SYNC_ERROR:          'sync:error',          // { phase, table, error }
    OUTBOX_CHANGED:      'outbox:changed',      // { pending, rejected }
    OUTBOX_REJECTED:     'outbox:rejected',     // { table, ids, status, error }
    DATA_CHANGED:        'data:changed',        // { table, ids, origin }
    RELAY_STATE:         'relay:state',         // { relay, shots, messages, participants }
    RELAY_ENDED:         'relay:ended',         // { relayId }
    RELAY_ERROR:         'relay:error',         // { phase, error }
  });

  /** Declared parent-before-child. Push and pull both walk this order, so a
   *  child row can never reach the server before the parent it references. */
  const TABLES = Object.freeze([
    'profiles',
    'firearms',
    'bullet_products', 'powder_products', 'primer_products',
    'component_lots',
    'brass_lots', 'brass_events',
    'recipes',
    'batches',
    'range_sessions',
    'shots', 'groups', 'dope_entries',
    // Shared surface: public-read, own-write. Writes ride the same outbox so
    // publishing works offline at a match; reads go through leaderboard().
    'leaderboard_profiles', 'leaderboard_entries',
  ]);

  /** Columns the server owns. Sending them is at best ignored and at worst
   *  lets a client clock decide conflict resolution. */
  const SERVER_OWNED = Object.freeze(['updated_at', 'created_at']);

  /* Columns a client must not send, because the server owns them.
   *
   * range_sessions' velocity summary USED to be listed here, on the reasoning
   * that a trigger recomputes it from `shots`. That reasoning only holds for a
   * session that HAS a shot string. Bench records a chronograph readout and no
   * per-shot velocities at all, so stripping its summary left the session with
   * no velocity anywhere -- and muzzle velocity is the first thing Zero reads
   * back out of v_ballistic_profiles.
   *
   * The real rule is narrower than the old one: never send a summary ALONGSIDE
   * a shot string, because then two sources of truth disagree until the trigger
   * settles it. Zero writes the string and no summary; Bench writes the summary
   * and no string. Both are honest, and zero-core's own suite pins that Zero
   * still sends no summary, so this stays true by test rather than by memory. */
  const DERIVED = Object.freeze({});

  /* --------------------------------------------------------------- helpers */
  const nowMs = () => Date.now();
  const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
      });

  const stripServerOwned = (table, row) => {
    const out = {};
    const drop = new Set([...SERVER_OWNED, ...(DERIVED[table] || [])]);
    for (const k of Object.keys(row)) if (!drop.has(k)) out[k] = row[k];
    return out;
  };

  /* ------------------------------------------------------------- instance */
  function create(options) {
    const cfg = Object.assign({
      url: null,              // https://<ref>.supabase.co
      anonKey: null,
      appId: 'unknown',       // 'zero' or 'bench' — lands in source_app
      tables: TABLES,
      storage: null,          // injectable; defaults to localStorage or memory
      fetch: (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null),
      pageSize: 500,
      refreshSkewMs: 60_000,  // refresh this long before the token actually dies
      autoSyncMs: 0,          // 0 disables the periodic sync
    }, options || {});

    if (!cfg.url || !cfg.anonKey) throw new Error('zero-core: url and anonKey are required');
    if (!cfg.fetch) throw new Error('zero-core: no fetch available');

    const store = cfg.storage || defaultStorage();
    const K = {
      session: 'zerocore.session',
      cursors: 'zerocore.cursors',
      outbox:  'zerocore.outbox',
      rejected:'zerocore.rejected',
    };

    /* -------------------------------------------------------- event bus */
    const listeners = new Map();
    function on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => off(evt, fn);
    }
    function off(evt, fn) {
      const s = listeners.get(evt);
      if (s) s.delete(fn);
    }
    function emit(evt, payload) {
      const s = listeners.get(evt);
      if (!s) return;
      // A throwing listener must not abort a sync or an auth transition.
      for (const fn of [...s]) {
        try { fn(payload || {}, evt); } catch (e) { /* listener's problem */ }
      }
    }

    /* ------------------------------------------------------------- state */
    let session = store.get(K.session) || null;   // { access_token, refresh_token, expires_at, user }
    let cursors = store.get(K.cursors) || {};     // { table: iso-timestamp }
    let outbox  = store.get(K.outbox)  || [];     // [{ id, table, row, op, queuedAt }]
    let rejected = store.get(K.rejected) || [];   // dead-lettered writes, see pushTable
    let online  = (typeof navigator === 'undefined') ? true : navigator.onLine !== false;
    let refreshInFlight = null;                    // the single shared refresh
    let syncInFlight = null;
    let autoTimer = null;

    const persistOutbox = () => {
      store.set(K.outbox, outbox);
      store.set(K.rejected, rejected);
      emit(EVENTS.OUTBOX_CHANGED, { pending: outbox.length, rejected: rejected.length });
    };

    /* ---------------------------------------------------------- transport */
    async function raw(path, init) {
      const res = await cfg.fetch(cfg.url + path, init);
      return res;
    }

    function authHeaders(extra) {
      const h = Object.assign({
        apikey: cfg.anonKey,
        'Content-Type': 'application/json',
      }, extra || {});
      if (session && session.access_token) {
        h.Authorization = 'Bearer ' + session.access_token;
      }
      return h;
    }

    /**
     * Authenticated request with a single-flight refresh on 401.
     * `retry` guards against a refresh that succeeds but still yields 401,
     * which would otherwise recurse forever.
     */
    async function authed(path, init, retry = true) {
      if (session && session.expires_at &&
          session.expires_at - cfg.refreshSkewMs <= nowMs()) {
        await refresh();                     // proactive; still single-flight
      }
      const tokenUsed = session && session.access_token;
      const res = await raw(path, Object.assign({}, init, {
        headers: authHeaders(init && init.headers),
      }));
      if (res.status === 401 && retry && session && session.refresh_token) {
        // Requests do NOT all fail at the same instant. A straggler whose 401
        // lands after someone else's refresh already completed must not kick
        // off a second refresh -- single-flight alone does not cover this,
        // because by then the shared promise has been cleared. If the token in
        // hand differs from the one this request used, a refresh already
        // happened; just retry with the new one.
        if (session.access_token !== tokenUsed) return authed(path, init, false);
        const ok = await refresh();
        if (ok) return authed(path, init, false);
      }
      return res;
    }

    /* -------------------------------------------------------------- auth */
    function setSession(s, reason) {
      session = s;
      store.set(K.session, s);
      if (s) emit(EVENTS.AUTH_SIGNED_IN, { user: s.user });
      else emit(EVENTS.AUTH_SIGNED_OUT, { reason: reason || 'user' });
    }

    function shapeSession(json) {
      // GoTrue returns expires_in (seconds). Absolute ms is what we can compare.
      const ttl = (json.expires_in != null ? json.expires_in : 3600) * 1000;
      return {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: nowMs() + ttl,
        user: json.user || null,
      };
    }

    async function signUp(email, password) {
      const res = await raw('/auth/v1/signup', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        emit(EVENTS.AUTH_ERROR, { phase: 'signUp', error: json });
        return { ok: false, error: json };
      }
      // With email confirmation on, signup returns a user but no tokens.
      if (json.access_token) setSession(shapeSession(json));
      return { ok: true, session, needsConfirmation: !json.access_token, user: json.user };
    }

    async function signIn(email, password) {
      const res = await raw('/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        emit(EVENTS.AUTH_ERROR, { phase: 'signIn', error: json });
        return { ok: false, error: json };
      }
      setSession(shapeSession(json));
      return { ok: true, session };
    }

    /**
     * Anonymous sign-in: a real auth.users row on the `authenticated` role,
     * carrying an is_anonymous JWT claim, with no email or password. This is
     * what makes "no accounts" true for the user while leaving RLS intact.
     *
     * The wire format is POST /auth/v1/signup with a body containing `data`
     * and no credentials -- taken from @supabase/auth-js, not guessed.
     *
     * Must be enabled in the dashboard (Auth > Providers > Anonymous), and
     * Supabase rate-limits it to 30 per hour per IP by default.
     */
    async function signInAnonymously() {
      const res = await raw('/auth/v1/signup', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: {}, gotrue_meta_security: {} }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.access_token) {
        emit(EVENTS.AUTH_ERROR, { phase: 'signInAnonymously', error: json });
        return { ok: false, error: json };
      }
      setSession(shapeSession(json));
      return { ok: true, session };
    }

    /** True when the current session is an anonymous device rather than a
     *  real account. Anonymous users can relay but cannot publish scores. */
    function isAnonymous() {
      if (!session || !session.access_token) return false;
      // GoTrue puts is_anonymous on the user object; prefer it to picking the
      // token apart, which depends on the token staying a readable JWT.
      if (session.user && typeof session.user.is_anonymous === 'boolean') {
        return session.user.is_anonymous;
      }
      try {
        const payload = JSON.parse(
          atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return payload.is_anonymous === true;
      } catch (e) {
        // Undecidable. Say "not anonymous": the server enforces this anyway via
        // a restrictive policy, so the worst case is offering a publish button
        // that fails, rather than hiding one that would have worked.
        return false;
      }
    }

    /** Ensure SOME identity exists, without asking the user for anything.
     *  Relay entry points call this. */
    async function ensureIdentity() {
      if (isSignedIn()) return { ok: true, session };
      return signInAnonymously();
    }

    /** Magic link / OTP. No password to lose, but needs mail delivery working. */
    async function signInWithOtp(email) {
      const res = await raw('/auth/v1/otp', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, create_user: true }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        emit(EVENTS.AUTH_ERROR, { phase: 'signInWithOtp', error });
        return { ok: false, error };
      }
      return { ok: true };
    }

    /**
     * Single-flight token refresh. Every caller awaits the same promise, so N
     * concurrent 401s produce exactly one network call. A failed refresh is
     * terminal: the refresh token has been rotated or revoked, and the only
     * correct response is to sign out rather than retry with a dead token.
     */
    function refresh() {
      if (refreshInFlight) return refreshInFlight;
      if (!session || !session.refresh_token) return Promise.resolve(false);

      refreshInFlight = (async () => {
        try {
          const res = await raw('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: session.refresh_token }),
          });
          if (!res.ok) {
            setSession(null, 'refresh-failed');
            emit(EVENTS.AUTH_ERROR, { phase: 'refresh', error: { status: res.status } });
            return false;
          }
          const json = await res.json();
          session = shapeSession(json);
          store.set(K.session, session);
          emit(EVENTS.AUTH_TOKEN_REFRESHED, { expiresAt: session.expires_at });
          return true;
        } catch (e) {
          // A network failure is NOT a dead token: stay signed in and retry later.
          emit(EVENTS.AUTH_ERROR, { phase: 'refresh', error: String(e) });
          return false;
        } finally {
          refreshInFlight = null;
        }
      })();
      return refreshInFlight;
    }

    async function signOut() {
      if (session && session.access_token) {
        try {
          await raw('/auth/v1/logout', { method: 'POST', headers: authHeaders() });
        } catch (e) { /* local sign-out proceeds regardless */ }
      }
      setSession(null, 'user');
      cursors = {};
      store.set(K.cursors, cursors);
      // The outbox is deliberately NOT cleared: unsent work belongs to the user,
      // not the session, and signing back in should still deliver it.
    }

    const getSession = () => session;
    const getUser = () => (session && session.user) || null;
    const isSignedIn = () => !!(session && session.access_token);

    /* -------------------------------------------------------------- outbox */
    /**
     * Queue a write. The row is stored whole, so a later flush sends the latest
     * state rather than replaying a stale snapshot: a second edit to the same
     * row replaces the queued entry instead of appending another.
     */
    function enqueue(table, row, op) {
      if (!cfg.tables.includes(table)) throw new Error('zero-core: unknown table ' + table);
      if (!row.id) row.id = uuid();
      const clean = stripServerOwned(table, row);
      const at = outbox.findIndex(e => e.table === table && e.row.id === row.id);
      const entry = { table, row: clean, op: op || 'upsert', queuedAt: nowMs() };
      if (at >= 0) outbox[at] = entry; else outbox.push(entry);
      persistOutbox();
      emit(EVENTS.DATA_CHANGED, { table, ids: [row.id], origin: 'local' });
      return row.id;
    }

    const upsert = (table, row) => enqueue(table, row, 'upsert');

    /** Soft delete: a tombstone, so a device that was offline learns about it. */
    const remove = (table, id) =>
      enqueue(table, { id, deleted_at: new Date().toISOString() }, 'upsert');

    const pendingCount = () => outbox.length;
    const rejectedList = () => rejected.map(r => ({ table: r.table, id: r.row.id,
      status: r.status, error: r.error, rejectedAt: r.rejectedAt }));
    const clearRejected = () => { rejected = []; persistOutbox(); };
    const pendingFor = (table) => outbox.filter(e => e.table === table).length;

    /* ---------------------------------------------------------------- pull */
    async function pullTable(table) {
      const since = cursors[table] || '1970-01-01T00:00:00Z';
      let offset = 0, all = [];
      for (;;) {
        const q = `/rest/v1/${table}` +
          `?select=*&updated_at=gt.${encodeURIComponent(since)}` +
          `&order=updated_at.asc&limit=${cfg.pageSize}&offset=${offset}`;
        const res = await authed(q, { method: 'GET' });
        if (!res.ok) {
          const error = await res.text().catch(() => '');
          emit(EVENTS.SYNC_ERROR, { phase: 'pull', table, error: { status: res.status, body: error } });
          throw new Error(`pull ${table}: ${res.status}`);
        }
        const page = await res.json();
        all = all.concat(page);
        if (page.length < cfg.pageSize) break;
        offset += cfg.pageSize;
      }

      // Advance the cursor to the newest row the SERVER actually returned.
      // Using a local timestamp here loses every row written mid-sync.
      if (all.length) {
        const newest = all.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), since);
        cursors[table] = newest;
        store.set(K.cursors, cursors);
      }
      emit(EVENTS.SYNC_PULLED, { table, rows: all, cursor: cursors[table] || since });
      return all;
    }

    /**
     * Apply pulled rows to local state. A row with an unsent local edit is left
     * alone -- the pending write is newer by definition and would be lost.
     */
    function reconcile(table, rows, apply) {
      const pending = new Set(outbox.filter(e => e.table === table).map(e => e.row.id));
      const applied = [], skipped = [];
      for (const r of rows) {
        if (pending.has(r.id)) {
          skipped.push(r.id);
          emit(EVENTS.SYNC_CONFLICT, { table, id: r.id, resolution: 'kept-local-pending' });
          continue;
        }
        applied.push(r);
      }
      if (apply) apply(table, applied);
      if (applied.length) {
        emit(EVENTS.DATA_CHANGED, { table, ids: applied.map(r => r.id), origin: 'remote' });
      }
      return { applied, skipped };
    }

    /* ---------------------------------------------------------------- push */
    async function pushTable(table) {
      const mine = outbox.filter(e => e.table === table);
      if (!mine.length) return 0;
      const body = mine.map(e => e.row);

      const res = await authed(`/rest/v1/${table}?on_conflict=id`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const error = await res.text().catch(() => '');
        /*
         * A 4xx here is the server saying "this row will never be accepted":
         * RLS refused it (403), a constraint rejected it (400), the payload is
         * malformed (422). Retrying forever would be pointless AND actively
         * harmful -- the failed push aborts the whole sync, so one poisoned
         * row permanently blocks every other pending write from ever leaving
         * the device. Dead-letter it instead, surface it, and keep going.
         *
         * 5xx and network failures are NOT dead-lettered: those are transient
         * and the row deserves another attempt.
         */
        if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
          const ids = new Set(mine.map(e => e.row.id));
          outbox = outbox.filter(e => !(e.table === table && ids.has(e.row.id)));
          rejected = rejected.concat(mine.map(e => ({
            table, row: e.row, status: res.status, error: String(error).slice(0, 400),
            rejectedAt: nowMs(),
          }))).slice(-100);                    // bounded: this is a diagnostic, not a queue
          persistOutbox();
          emit(EVENTS.OUTBOX_REJECTED, { table, ids: [...ids], status: res.status, error });
          emit(EVENTS.SYNC_ERROR, { phase: 'push', table, error: { status: res.status, body: error } });
          return 0;                            // sync continues; other tables still flush
        }
        emit(EVENTS.SYNC_ERROR, { phase: 'push', table, error: { status: res.status, body: error } });
        throw new Error(`push ${table}: ${res.status}`);
      }
      const saved = await res.json().catch(() => body);

      // Only drop the entries we actually sent. Anything queued while the
      // request was in flight stays, or that edit is silently lost.
      const sent = new Set(mine.map(e => e.row.id));
      outbox = outbox.filter(e => !(e.table === table && sent.has(e.row.id) &&
                                    mine.find(m => m.row.id === e.row.id) === e));
      persistOutbox();
      emit(EVENTS.SYNC_PUSHED, { table, rows: saved });
      return mine.length;
    }

    /* ---------------------------------------------------------------- sync */
    /**
     * Push then pull, both in declared table order. Push first so a row created
     * offline is on the server before the pull that would otherwise report it
     * missing. Concurrent calls share one run.
     */
    function sync(opts) {
      if (syncInFlight) return syncInFlight;
      const o = opts || {};
      const empty = { pulled: 0, pushed: 0, conflicts: 0, ms: 0 };

      // These guards MUST sit outside the async body. An async function runs
      // synchronously until its first await, so a guard that returned from
      // inside would clear syncInFlight before the assignment below set it --
      // leaving a resolved failure promise cached forever, and every later
      // sync() returning that same stale result.
      if (!isSignedIn()) return Promise.resolve({ ok: false, reason: 'signed-out', stats: empty });
      if (!online)       return Promise.resolve({ ok: false, reason: 'offline',    stats: empty });

      const run = async () => {
        const started = nowMs();
        const stats = { pulled: 0, pushed: 0, conflicts: 0, ms: 0 };
        emit(EVENTS.SYNC_START, { trigger: o.trigger || 'manual' });
        try {
          for (const t of cfg.tables) stats.pushed += await pushTable(t);
          for (const t of cfg.tables) {
            const rows = await pullTable(t);
            const { applied, skipped } = reconcile(t, rows, o.apply);
            stats.pulled += applied.length;
            stats.conflicts += skipped.length;
          }
          stats.ms = nowMs() - started;
          emit(EVENTS.SYNC_DONE, stats);
          return { ok: true, stats };
        } catch (e) {
          stats.ms = nowMs() - started;
          emit(EVENTS.SYNC_ERROR, { phase: 'sync', error: String(e) });
          return { ok: false, reason: String(e), stats };
        }
      };

      const p = run().finally(() => { if (syncInFlight === p) syncInFlight = null; });
      syncInFlight = p;
      return p;
    }

    /* --------------------------------------------------------- connectivity */
    function setOnline(v, opts) {
      const was = online;
      online = !!v;
      if (was === online) return;
      emit(online ? EVENTS.NET_ONLINE : EVENTS.NET_OFFLINE, {});
      if (online && (!opts || opts.autoSync !== false) && isSignedIn() && outbox.length) {
        sync({ trigger: 'reconnect', apply: (opts || {}).apply });
      }
    }

    function attachBrowserListeners(apply) {
      if (typeof window === 'undefined') return () => {};
      const up = () => setOnline(true, { apply });
      const down = () => setOnline(false);
      window.addEventListener('online', up);
      window.addEventListener('offline', down);
      return () => {
        window.removeEventListener('online', up);
        window.removeEventListener('offline', down);
      };
    }

    function startAutoSync(apply) {
      stopAutoSync();
      if (!cfg.autoSyncMs) return;
      autoTimer = setInterval(() => {
        if (isSignedIn() && online) sync({ trigger: 'interval', apply });
      }, cfg.autoSyncMs);
    }
    function stopAutoSync() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    }

    /* -------------------------------------------------------- convenience */
    /** Call a Postgres function. Relay operations are all RPCs because the
     *  security lives in security-definer functions, not in table policies. */
    async function rpc(fn, args) {
      const res = await authed('/rest/v1/rpc/' + fn, {
        method: 'POST',
        body: JSON.stringify(args || {}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, status: res.status, error: body };
      return { ok: true, data: body };
    }

    /** Read-only query for the cross-app views. */
    async function selectView(view, query) {
      const res = await authed(`/rest/v1/${view}?${query || 'select=*'}`, { method: 'GET' });
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        emit(EVENTS.SYNC_ERROR, { phase: 'select', table: view, error: { status: res.status, body: error } });
        return { ok: false, error };
      }
      return { ok: true, data: await res.json() };
    }

    /** Claim (or change) the public handle. Keyed by the user id, so it is
     *  naturally one-per-account and an upsert renames rather than duplicates.
     *  Server enforces shape and case-insensitive uniqueness. */
    function claimHandle(handle) {
      const u = getUser();
      if (!u) throw new Error('zero-core: not signed in');
      return upsert('leaderboard_profiles', { id: u.id, handle });
    }

    /** Queue a leaderboard entry. Caller supplies a STABLE id per underlying
     *  session (minted once, persisted locally) so republishing updates the
     *  same row instead of stacking duplicates. */
    function publishEntry(entry) {
      if (!entry || !entry.id) throw new Error('zero-core: entry.id is required');
      return upsert('leaderboard_entries', entry);
    }

    /** Retract an entry: tombstone, so it vanishes for every viewer. */
    const retractEntry = (id) => remove('leaderboard_entries', id);

    const leaderboard = (extra) =>
      selectView('v_leaderboard', 'select=*&' + (extra || 'order=score.desc'));

    const ballisticProfiles = (extra) =>
      selectView('v_ballistic_profiles', 'select=*&' + (extra || 'order=loaded_on.desc'));
    const batchPerformance = (extra) =>
      selectView('v_batch_performance', 'select=*&' + (extra || ''));

    /* ==================================================================
     * Live relay client.
     *
     * Polling, not WebSockets, and that is the whole point. A coach's phone
     * spends the session backgrounded; browsers throttle background timers,
     * which stops a WebSocket heartbeat, which makes the server drop the
     * socket -- silently, so the UI still says "connected" over a dead pipe.
     * That is what killed the previous attempt. A plain request on resume
     * simply works, and there is no connection to have quietly died.
     * ================================================================== */
    let relay = null;   // { id, code, role, slot, name, isHost, sinceShot,
                        //   sinceMsg, shots:Map, messages:Map, timer, stopped }
                        //
                        // role decides whether this device may write shots.
                        // isHost decides only who may END the relay. They are
                        // separate on purpose: in a pair, BOTH people are
                        // shooters but only one started it.

    const RELAY_POLL_MS = 2500;
    const RELAY_BACKOFF_MAX_MS = 20000;

    async function createRelay(opts) {
      const o = opts || {};
      const id = await ensureIdentity();
      if (!id.ok) return { ok: false, error: id.error };
      const r = await rpc('create_relay', {
        p_host_name: o.hostName || 'Shooter',
        p_title: o.title || null,
        p_target_name: o.targetName || null,
        p_target_rings: o.targetRings || null,
        p_distance_yd: o.distanceYd || null,
      });
      if (!r.ok) { emit(EVENTS.RELAY_ERROR, { phase: 'create', error: r.error }); return r; }
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      startRelay({ id: row.id, code: row.code, isHost: true, slot: 1,
                   name: o.hostName || 'Shooter', role: 'shooter' });
      return { ok: true, relay: row, slot: 1, role: 'shooter' };
    }

    /** opts.distanceYd: YOUR firing distance, not the relay starter's. It is
     *  what turns your inches into minutes on the coach's screen, and a pair is
     *  not always on the same line. */
    async function joinRelay(code, name, role, opts) {
      const id = await ensureIdentity();
      if (!id.ok) return { ok: false, error: id.error };
      const d = Number((opts || {}).distanceYd);
      const r = await rpc('join_relay', {
        p_code: String(code || '').trim(),
        p_name: name || 'Guest',
        p_role: role === 'shooter' ? 'shooter' : 'coach',
        p_distance_yd: Number.isFinite(d) && d > 0 ? d : null,
      });
      if (!r.ok) { emit(EVENTS.RELAY_ERROR, { phase: 'join', error: r.error }); return r; }
      // join_relay returns a RESULT, not an exception: a bad code is ok:false,
      // which is how the server-side throttle can record the failed attempt.
      const res = r.data || {};
      if (!res.ok) return { ok: false, reason: res.error, message: res.message };
      // Trust the SERVER's answer on role and firing point, not the request:
      // a relay that is already full hands back a coach seat, and rejoining
      // returns the slot you already held rather than a fresh one.
      startRelay({ id: res.relay.id, code: res.relay.code, isHost: false,
                   name: name || 'Guest', role: res.role || 'coach',
                   slot: res.slot || null });
      return { ok: true, relay: res.relay, slot: res.slot || null,
               role: res.role || 'coach' };
    }

    function startRelay(meta) {
      stopRelay();
      relay = Object.assign({
        sinceShot: '1970-01-01T00:00:00Z',
        sinceMsg: '1970-01-01T00:00:00Z',
        shots: new Map(), messages: new Map(), participants: [],
        backoff: RELAY_POLL_MS, stopped: false, timer: null,
      }, meta);
      pumpRelay();
      attachRelayResume();
      return relay;
    }

    function stopRelay() {
      if (relay && relay.timer) clearTimeout(relay.timer);
      if (relay) relay.stopped = true;
      detachRelayResume();
      relay = null;
    }

    async function pollRelayOnce() {
      if (!relay || relay.stopped) return { ok: false, reason: 'no-relay' };
      const r = await rpc('relay_state', {
        p_relay: relay.id,
        p_since_shot: relay.sinceShot,
        p_since_msg: relay.sinceMsg,
      });
      if (!r.ok) { emit(EVENTS.RELAY_ERROR, { phase: 'poll', error: r.error }); return r; }
      const st = r.data || {};

      /* Dedupe by id, because relay_state uses a >= cursor: rows sharing the
       * boundary timestamp are deliberately re-sent rather than dropped. */
      (st.shots || []).forEach(x => relay.shots.set(x.id, x));
      (st.messages || []).forEach(m => relay.messages.set(m.id, m));
      relay.participants = st.participants || [];

      const maxOf = (rows, cur) => rows.reduce(
        (m, x) => (x.created_at > m ? x.created_at : m), cur);
      relay.sinceShot = maxOf(st.shots || [], relay.sinceShot);
      relay.sinceMsg = maxOf(st.messages || [], relay.sinceMsg);

      // Ordered by firing point, then sighters before record, then number.
      // Two shooters both have a shot 1, so shot_no alone no longer orders.
      const shots = [...relay.shots.values()].sort((a, b) =>
        (a.slot || 0) - (b.slot || 0) ||
        (a.is_sighter === b.is_sighter ? 0 : (a.is_sighter ? -1 : 1)) ||
        a.shot_no - b.shot_no);
      const messages = [...relay.messages.values()]
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

      emit(EVENTS.RELAY_STATE, {
        relay: st.relay, shots, messages,
        participants: relay.participants, serverTime: st.server_time,
      });

      if (st.relay && st.relay.status === 'ended') {
        emit(EVENTS.RELAY_ENDED, { relayId: relay.id });
        stopRelay();
      }
      return { ok: true, shots, messages };
    }

    async function pumpRelay() {
      if (!relay || relay.stopped) return;
      const r = await pollRelayOnce();
      if (!relay || relay.stopped) return;
      // Back off on failure so a dead network does not hammer the API, and
      // snap back to the normal cadence the moment a poll succeeds.
      relay.backoff = r.ok ? RELAY_POLL_MS
        : Math.min(RELAY_BACKOFF_MAX_MS, Math.round(relay.backoff * 1.8));
      relay.timer = setTimeout(pumpRelay, relay.backoff);
    }

    /* Resume immediately when the tab comes back or the network returns,
     * rather than waiting out a backoff the user cannot see. */
    let relayResumeHandler = null;
    function attachRelayResume() {
      if (typeof document === 'undefined' || relayResumeHandler) return;
      relayResumeHandler = () => {
        if (!relay || relay.stopped) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        if (relay.timer) clearTimeout(relay.timer);
        relay.backoff = RELAY_POLL_MS;
        pumpRelay();
      };
      document.addEventListener('visibilitychange', relayResumeHandler);
      if (typeof window !== 'undefined') window.addEventListener('online', relayResumeHandler);
    }
    function detachRelayResume() {
      if (!relayResumeHandler) return;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', relayResumeHandler);
      }
      if (typeof window !== 'undefined') window.removeEventListener('online', relayResumeHandler);
      relayResumeHandler = null;
    }

    /** Mirror one of YOUR OWN shots into the relay. Any participant holding
     *  the shooter role may do this; the server enforces that the row is
     *  attributed to the caller, so a partner cannot write your string.
     *
     *  Fire and forget -- a failure here must never block logging the shot
     *  locally, because the local session is the system of record. */
    async function relayPushShot(shot) {
      if (!relay) return { ok: false, reason: 'no-relay' };
      if (relay.role !== 'shooter') return { ok: false, reason: 'not-shooter' };
      const uid = session && session.user && session.user.id;
      // The conflict key includes user_id: re-pushing YOUR shot 3 updates your
      // row and never touches your partner's shot 3.
      const res = await authed(
        '/rest/v1/relay_shots?on_conflict=relay_id,user_id,shot_no,is_sighter', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([{
          relay_id: relay.id,
          user_id: uid || undefined,
          shot_no: shot.shotNo,
          ring: shot.ring == null ? null : String(shot.ring),
          x_in: shot.x, y_in: shot.y,
          // The call is what a coach reads. Sending it is the difference
          // between "he shot a 9 at 4 o'clock" and "he called it centre".
          call_x_in: shot.callX == null ? null : shot.callX,
          call_y_in: shot.callY == null ? null : shot.callY,
          wind_call_moa: shot.windCallMoa == null ? null : shot.windCallMoa,
          wind_call_dir: shot.windCallDir === 'L' || shot.windCallDir === 'R'
            ? shot.windCallDir : null,
          is_sighter: !!shot.isSighter,
          note: shot.note || null,
        }]),
      });
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        emit(EVENTS.RELAY_ERROR, { phase: 'push-shot', error });
        return { ok: false, error };
      }
      pokeRelay();
      return { ok: true };
    }

    async function relaySend(body, kind) {
      if (!relay) return { ok: false, reason: 'no-relay' };
      const text = String(body || '').trim();
      if (!text) return { ok: false, reason: 'empty' };
      const res = await authed('/rest/v1/relay_messages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
          relay_id: relay.id, author_name: relay.name,
          kind: kind === 'wind' ? 'wind' : 'chat', body: text.slice(0, 500),
        }]),
      });
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        emit(EVENTS.RELAY_ERROR, { phase: 'send', error });
        return { ok: false, error };
      }
      pokeRelay();
      return { ok: true };
    }

    /** Poll now rather than waiting for the next tick, so your own writes
     *  appear immediately instead of up to 2.5s later. */
    function pokeRelay() {
      if (!relay || relay.stopped) return;
      if (relay.timer) clearTimeout(relay.timer);
      relay.timer = setTimeout(pumpRelay, 120);
    }

    async function endRelay() {
      if (!relay || !relay.isHost) return { ok: false, reason: 'not-host' };
      const r = await rpc('end_relay', { p_relay: relay.id });
      stopRelay();
      return r;
    }

    /** Leave without ending it for everyone else. Deletes the participant row
     *  rather than just stopping the poll, so the firing point is freed and
     *  the others stop seeing a name that will never come back. Best effort:
     *  a failed delete must not trap you in a relay you have walked away from. */
    async function leaveRelay() {
      if (!relay) return { ok: false, reason: 'no-relay' };
      if (relay.isHost) return endRelay();
      const id = relay.id;
      const uid = session && session.user && session.user.id;
      stopRelay();
      if (!uid) return { ok: true };
      try {
        await authed('/rest/v1/relay_participants?relay_id=eq.' + encodeURIComponent(id) +
                     '&user_id=eq.' + encodeURIComponent(uid), { method: 'DELETE' });
      } catch (_) { /* already gone, or offline -- either way we are out */ }
      return { ok: true };
    }

    const relayInfo = () => (relay
      ? { id: relay.id, code: relay.code, isHost: relay.isHost,
          name: relay.name, role: relay.role, slot: relay.slot,
          canShoot: relay.role === 'shooter',
          shotCount: relay.shots.size, participants: relay.participants }
      : null);

    function resetCursors() { cursors = {}; store.set(K.cursors, cursors); }

    return {
      EVENTS, TABLES,
      on, off, emit,
      signUp, signIn, signInWithOtp, signOut, refresh,
      getSession, getUser, isSignedIn,
      upsert, remove, enqueue, pendingCount, pendingFor, rejectedList, clearRejected,
      sync, pullTable, pushTable, reconcile, resetCursors,
      setOnline, attachBrowserListeners, startAutoSync, stopAutoSync,
      selectView, rpc, ballisticProfiles, batchPerformance,
      signInAnonymously, isAnonymous, ensureIdentity,
      claimHandle, publishEntry, retractEntry, leaderboard,
      createRelay, joinRelay, stopRelay, endRelay, leaveRelay, pollRelayOnce,
      relayPushShot, relaySend, relayInfo,
      uuid,
      get isOnline() { return online; },
      get cursors() { return Object.assign({}, cursors); },
      get outbox() { return outbox.map(e => ({ table: e.table, id: e.row.id, op: e.op })); },
      _config: cfg,
    };
  }

  /* ---------------------------------------------------------------- storage */
  function defaultStorage() {
    let ok = false;
    try {
      localStorage.setItem('zerocore.probe', '1');
      localStorage.removeItem('zerocore.probe');
      ok = true;
    } catch (e) { ok = false; }
    if (ok) {
      return {
        get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }
                 catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; }
                    catch (e) { return false; } },
      };
    }
    const mem = new Map();
    return {
      get: (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
      set: (k, v) => { mem.set(k, JSON.stringify(v)); return true; },
    };
  }

  return { create, EVENTS, TABLES, defaultStorage };
})();
//#endregion zero-core
/* ── Shared deployment ────────────────────────────────────────────────────
 * Every install points at ONE Supabase project so the leaderboard has a
 * population. Fill these in before deploying and users never see a server
 * form -- they just sign in. Left blank, the app falls back to asking each
 * user for a server (useful for testing against a scratch project).
 *
 * The anon key belongs in client code: it is public by design and grants
 * nothing on its own. RLS is what protects the data. Never put the
 * service_role key here. */
/* Injected at build time from supabase.config.json — ONE file for both apps,
 * because two constants that must agree are two constants that eventually do
 * not, and the failure mode is a shooter whose phone talks to a different
 * project from their coach's. The fallback keeps the source runnable when it
 * is opened directly without a build. */
const SHARED_SUPABASE = (typeof __SUPABASE_CONFIG__ !== 'undefined')
  ? __SUPABASE_CONFIG__
  : { url: '', anonKey: '' };
const HAS_SHARED = !!(SHARED_SUPABASE.url && SHARED_SUPABASE.anonKey);

const SYNC_CFG_KEY = 'sync_cfg_v1';
const POSITIONS = ['Prone', 'Sitting', 'Kneeling', 'Standing', 'Supported', 'Unspecified'];
const round3 = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);

/* ══════════════════════════════════════════════════════════════════════════
 * BENCH → ZERO: what a linked batch actually carries.
 *
 * Zero used to import a batch as a name, a bullet and an OAL, flattening the
 * safety flags into a notes STRING. Three things were wrong with that:
 *
 *   1. Powder and charge were dropped, so two loads of the same bullet were
 *      indistinguishable in the picker -- which is most of a load workup.
 *   2. Everything was frozen at import. A batch quarantined on the bench
 *      stayed selectable in Zero forever, because Zero had kept a copy of a
 *      boolean from weeks ago.
 *   3. Flags in prose cannot be enforced. "UNTESTED" inside a notes field is
 *      a thing a human might notice; it is not a thing the app can refuse on.
 *
 * So a linked load now keeps a structured `batch` snapshot, refreshed on every
 * sync, and the flags are booleans the UI acts on. The user's own fields --
 * the load's name, which firearm it is bound to -- are never overwritten by a
 * refresh; those are theirs.
 * ════════════════════════════════════════════════════════════════════════ */

const num = v => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);

/* One row of v_ballistic_profiles → the snapshot Zero stores. Field names are
 * camel-cased at the boundary so the rest of the app never sees snake_case. */
function batchSnapshot(p, atMs) {
  return {
    cartridge: p.cartridge || null,
    loadName: p.load_name || null,
    recipeId: p.recipe_id || null,
    // bullet
    bulletName: p.bullet_name || null,
    bulletWeightGr: num(p.bullet_weight_gr),
    diameterIn: num(p.diameter_in),
    bulletLengthIn: num(p.bullet_length_in),
    bcG1: num(p.bc_g1), bcG7: num(p.bc_g7),
    // the recipe as a shooter says it out loud
    powderName: p.powder_name || null,
    powderTempStable: p.powder_temp_stable ?? null,
    chargeGr: num(p.charge_gr),
    chargeActualGr: num(p.charge_actual_gr),
    chargeSdGr: num(p.charge_sd_gr),
    primerName: p.primer_name || null,
    coalIn: num(p.coal_mean_in), cbtoIn: num(p.cbto_in),
    // velocity, and the spread that actually drives vertical dispersion
    mvFps: num(p.muzzle_velocity_fps),
    sdFps: num(p.velocity_sd_fps),
    esFps: num(p.velocity_es_fps),
    esSigmaFps: num(p.velocity_es_sigma_fps),
    velN: num(p.velocity_n),
    velTempF: num(p.velocity_temp_f),
    velOn: p.velocity_measured_on || null,
    // firearm geometry, which a solver needs and Zero was discarding
    firearmId: p.firearm_id || null,
    firearmName: p.firearm_name || null,
    barrelIn: num(p.barrel_in), twist: p.twist ?? null,
    sightHeightIn: num(p.sight_height_in),
    zeroRangeYd: num(p.zero_range_yd),
    // inventory
    qtyRemaining: num(p.qty_remaining),
    qtyLoaded: num(p.qty_loaded),
    loadedOn: p.loaded_on || null,
    // safety state, as booleans the app can refuse on
    quarantined: !!p.quarantined,
    quarantineReason: p.quarantine_reason || null,
    untested: !!p.untested,
    overPublishedMax: !!p.over_published_max,
    recipeStatus: p.recipe_status || null,
    selfDeveloped: !!p.self_developed,
    source: [p.source_name, p.source_edition, p.source_page && `p.${p.source_page}`]
      .filter(Boolean).join(' ') || null,
    sourceMaxGr: num(p.source_max_gr),
    syncedAt: atMs,
  };
}

/* A load imported from Bench. The flat fields stay populated because the rest
 * of Zero (session chips, DOPE cells, the edit form) reads them. */
function ammoFromProfile(p, atMs) {
  const b = batchSnapshot(p, atMs);
  return {
    id: uid(),
    name: [p.load_name, p.serial].filter(Boolean).join(' · ') || p.serial,
    rifleId: '',
    bullet: [b.bulletName, b.bulletWeightGr ? `${b.bulletWeightGr}gr` : null]
      .filter(Boolean).join(' '),
    powder: b.powderName || '',
    charge: b.chargeActualGr ?? b.chargeGr ?? '',
    oal: b.coalIn ?? '',
    notes: [b.cartridge, b.primerName, b.source].filter(Boolean).join(' · '),
    batchId: p.batch_id,
    batchSerial: p.serial,
    batch: b,
    ts: atMs,
  };
}

/* Re-pull every linked batch and refresh its snapshot in place.
 *
 * Returns a NEW ammo array, or null when nothing changed -- callers persist
 * only on a real change, so a sync that found nothing new does not rewrite
 * storage and re-render the world.
 *
 * A batch that has vanished from the view (deleted on the bench, or shot out)
 * is NOT dropped: it is marked `gone`, because sessions already reference it
 * and silently deleting the load would orphan them. */
async function refreshLinkedBatches(core, ammo, atMs) {
  const linked = (ammo || []).filter(a => a.batchId);
  if (!core || !core.isSignedIn() || !linked.length) return null;
  // No quarantined=eq.false filter here, deliberately: the whole point is to
  // learn that a batch we already hold has BEEN quarantined since.
  const r = await core.ballisticProfiles('order=loaded_on.desc');
  if (!r.ok) return null;
  const by = new Map((r.data || []).map(p => [p.batch_id, p]));
  let changed = false;
  const next = (ammo || []).map(a => {
    if (!a.batchId) return a;
    const p = by.get(a.batchId);
    if (!p) {
      if (a.batch?.gone) return a;
      changed = true;
      return { ...a, batch: { ...(a.batch || {}), gone: true, syncedAt: atMs } };
    }
    const b = batchSnapshot(p, atMs);
    // Compare everything except the timestamp, or every sync looks like a change.
    const same = a.batch && Object.keys(b).every(k =>
      k === 'syncedAt' || JSON.stringify(a.batch[k]) === JSON.stringify(b[k]));
    if (same) return a;
    changed = true;
    // The user's own fields survive. Only Bench's facts are replaced.
    return { ...a, batch: b,
             bullet: a.bullet || [b.bulletName, b.bulletWeightGr && `${b.bulletWeightGr}gr`].filter(Boolean).join(' '),
             powder: a.powder || b.powderName || '',
             charge: a.charge === '' || a.charge == null ? (b.chargeActualGr ?? b.chargeGr ?? '') : a.charge };
  });
  return changed ? next : null;
}

/* Is this load safe to start a new session on? Quarantined ammunition should
 * not be selectable for new work -- but it stays visible and stays attached to
 * sessions already shot, because "we quarantined it after the fact" is exactly
 * how you find out a batch was bad, and deleting that history destroys the
 * evidence. */
const batchBlocked = a => !!(a.batch && a.batch.quarantined);
const batchWarnings = (a) => {
  const b = a && a.batch;
  if (!b) return [];
  const w = [];
  if (b.quarantined) w.push({ kind: 'stop', text: b.quarantineReason
    ? `Quarantined on the bench — ${b.quarantineReason}` : 'Quarantined on the bench' });
  if (b.gone) w.push({ kind: 'warn', text: 'This batch is no longer in Bench' });
  if (b.overPublishedMax) w.push({ kind: 'stop',
    text: `Charge exceeds the cited maximum${b.sourceMaxGr ? ` of ${b.sourceMaxGr}gr` : ''}` });
  if (b.untested) w.push({ kind: 'warn', text: 'No chronograph data — velocity is assumed' });
  if (b.selfDeveloped && !b.source) w.push({ kind: 'warn', text: 'Self-developed load, no published source cited' });
  if (b.qtyRemaining === 0) w.push({ kind: 'warn', text: 'No rounds remaining' });
  if (b.recipeStatus === 'retired') w.push({ kind: 'warn', text: 'Recipe is retired' });
  return w;
};

/* The facts panel on a linked load. Only renders numbers that exist -- a
 * blank cell is worse than an absent one, because it reads as a zero. */
function BatchFacts({ a }) {
  const b = a.batch;
  if (!b) return null;
  const warn = batchWarnings(a);
  const cells = [
    b.mvFps != null && ['MV', `${Math.round(b.mvFps)}`, 'fps'],
    b.sdFps != null && ['SD', b.sdFps.toFixed(1), 'fps'],
    // ES normalised to a comparable sigma: raw ES grows with shot count, so
    // comparing it between a 5-shot and a 20-shot string is meaningless.
    b.esSigmaFps != null && ['ES→σ', b.esSigmaFps.toFixed(1), 'fps'],
    (b.bcG7 ?? b.bcG1) != null && [b.bcG7 != null ? 'G7' : 'G1',
      (b.bcG7 ?? b.bcG1).toFixed(3), 'BC'],
    b.qtyRemaining != null && ['Left', String(b.qtyRemaining), 'rds'],
  ].filter(Boolean);

  return (
    <div style={{ marginTop: 7, paddingTop: 7, borderTop: '1px solid var(--bdr)' }}>
      <div style={{ fontFamily: 'var(--fm)', fontSize: 9, color: 'var(--dim)', marginBottom: 6 }}>
        {[b.powderName && `${b.chargeActualGr ?? b.chargeGr ?? '?'}gr ${b.powderName}`,
          b.primerName, b.coalIn && `COAL ${b.coalIn}"`, b.cbtoIn && `CBTO ${b.cbtoIn}"`]
          .filter(Boolean).join(' · ') || 'No recipe detail on this batch.'}
      </div>
      {cells.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {cells.map(([lab, v, u]) => (
            <div key={lab}>
              <div style={{ fontFamily: 'var(--fm)', fontSize: 12, fontWeight: 700, color: 'var(--acc)' }}>
                {v}<span style={{ fontSize: 8, color: 'var(--dim)', fontWeight: 400 }}> {u}</span>
              </div>
              <div style={{ fontFamily: 'var(--fm)', fontSize: 7.5, color: 'var(--dim)',
                letterSpacing: '.08em', textTransform: 'uppercase' }}>{lab}</div>
            </div>
          ))}
        </div>
      )}
      {b.velN != null && b.velN > 0 && (
        <div style={{ fontFamily: 'var(--fm)', fontSize: 7.5, color: 'var(--dim)', marginTop: 5 }}>
          velocity from {b.velN} shot{b.velN === 1 ? '' : 's'}
          {b.velOn ? ` on ${b.velOn}` : ''}{b.velTempF != null ? ` at ${b.velTempF}°F` : ''}
          {b.sdFps != null ? ' · SD drives vertical dispersion; ES is shown because shooters quote it' : ''}
        </div>
      )}
      {warn.map((w, i) => (
        <div key={i} style={{ fontFamily: 'var(--fm)', fontSize: 8.5, marginTop: 5,
          color: w.kind === 'stop' ? 'var(--red)' : 'var(--acc)' }}>
          {w.kind === 'stop' ? '■ ' : '▲ '}{w.text}
        </div>
      ))}
    </div>
  );
}

/* Map every session that used a Bench-linked load onto the shared schema
 * and queue it. Remote UUIDs are assigned once and SAVED BACK onto the
 * session (via the returned array) so every later push upserts the same rows
 * instead of duplicating them. Sessions with <2 record shots are skipped —
 * the schema requires shot_count >= 2 for a group. */
function zeroSyncOutbound(core, sessions, ammo, getTarget) {
  const linked = new Map(ammo.filter(a => a.batchId).map(a => [a.id, a]));
  let changed = false, queued = 0;
  const updated = sessions.map(s => {
    const a = s.ammoId ? linked.get(s.ammoId) : null;
    if (!a) return s;
    const yards = +s.rangeYards;
    if (!Number.isFinite(yards) || yards <= 0) return s;
    const stats = analytics(s.shots || [], getTarget(s.targetId), yards);
    if (!stats || stats.n < 2) return s;

    let s2 = s;
    if (!s.remoteId || !s.remoteGroupId) {
      s2 = { ...s, remoteId: s.remoteId || core.uuid(),
             remoteGroupId: s.remoteGroupId || core.uuid() };
      changed = true;
    }
    core.upsert('range_sessions', {
      id: s2.remoteId,
      batch_id: a.batchId,
      occurred_on: s2.date || null,
      location: s2.rangeLocation || null,
      rounds_fired: stats.n,
      temp_f: (s2.temp !== '' && s2.temp != null && Number.isFinite(+s2.temp)) ? +s2.temp : null,
      source_app: 'zero',
      notes: [s2.name, s2.position, s2.fireMode].filter(Boolean).join(' · ') || null,
    });
    core.upsert('groups', {
      id: s2.remoteGroupId,
      session_id: s2.remoteId,
      label: s2.name || null,
      distance_yd: yards,
      shot_count: stats.n,
      group_es_in: round3(stats.esIn),      // inches — NOT velocity ES
      mean_radius_in: round3(stats.mrIn),
      source_app: 'zero',
    });
    queued++;
    return s2;
  });
  return { updated, changed, queued };
}

/* ── Cloud sync card ──────────────────────────────────────────────────── */
/* Build a leaderboard row from a session. Returns null when the session
 * cannot legitimately be ranked -- fewer than 2 record shots has no group,
 * and the schema refuses shot_count < 2 anyway. */
function leaderboardEntryFor(session, target, existingId) {
  const yards = +session.rangeYards;
  if (!Number.isFinite(yards) || yards <= 0) return null;
  const a = analytics(session.shots || [], target, yards);
  if (!a || a.n < 2) return null;
  return {
    id: existingId || null,
    occurred_on: session.date || new Date().toISOString().slice(0, 10),
    position: POSITIONS.includes(session.position) ? session.position : 'Unspecified',
    target_name: target?.name || 'Unknown',
    distance_yd: yards,
    shot_count: a.n,
    score: a.score,
    x_count: a.xs,
    mr_moa: round3(a.mrMoa),
    es_moa: round3(a.esMoa),
    source_app: 'zero',
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * LIVE RELAY — the pair-firing kit.
 *
 * Pair fire as actually shot: two shooters and a coach, all three watching
 * each other. Somebody taps "go live" and reads a 4-character code aloud; the
 * others enter it with a name and a role.
 *
 *   shooter  logs their own string, and sees their partner's shots drawn over
 *            their own target in the partner's colour
 *   coach    logs nothing, and sees both strings — calls as well as impacts,
 *            because the gap between the two is what a coach is reading
 *   everyone shares one feed for wind calls and chatter
 *
 * Deliberately polled, not socketed: a phone on the line is backgrounded for
 * most of a string, browsers throttle background timers, the heartbeat stops,
 * and the server drops the socket without the client noticing. Polling has no
 * connection to lose — and because relay_state stamps last_seen_at on every
 * poll, the poll IS the presence heartbeat. "Watching" means watching.
 * ════════════════════════════════════════════════════════════════════════ */

/* Colour is a function of FIRING POINT, not of join order as each device
 * happens to observe it, so the partner who is blue on your phone is blue on
 * the coach's too. Slot 1 takes the app accent; 2 takes the blue already used
 * for sighters and wind, which reads as "the other one" without competing. */
const SLOT_COLORS = ['#e8943a', '#4a9eff', '#3db87a', '#b57cff'];
const slotColor = s => SLOT_COLORS[((+s || 1) - 1) % SLOT_COLORS.length];

/* ── Call error, in minutes ───────────────────────────────────────────────
 *
 * A shooter calls where the sights were when the shot broke; the target says
 * where the bullet went. The difference is the one correction a coach can act
 * on WITHOUT knowing the shooter's aim, and that is why it beats the group
 * centroid for this purpose:
 *
 *   group centroid vs point of aim  =  aiming error + zero error + conditions
 *   impact vs call                  =  zero error + conditions
 *
 * A shooter who calls "low left" and hits low left has a correctly zeroed
 * rifle and made a bad shot. Dialling for that makes the next good shot wrong.
 * Only the SYSTEMATIC part of impact-minus-call is a sight correction.
 *
 * So the number reported is the MEAN error vector, not the mean absolute
 * error. Mean absolute error never approaches zero however well the rifle is
 * zeroed -- it measures how well the shooter calls, which is a separate and
 * also useful thing, reported separately.
 *
 * And a mean over few shots is mostly noise. Each axis carries a 90% interval
 * on the mean (Student t, se = s/sqrt(n)); when that interval spans zero the
 * card says HOLD instead of giving a number, because "dial 0.3 left" computed
 * from four shots with a 0.9 minute spread is an instruction to chase noise.
 */

/* Two-sided 90% t critical values by degrees of freedom. Small n is exactly
 * where this matters -- at df=2 the multiplier is 2.9, not the 1.645 a normal
 * approximation would use, and using 1.645 there would call a correction
 * significant when it is not. */
const T90 = [null, 6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860,
             1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.740,
             1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706,
             1.703, 1.701, 1.699];
const t90 = df => (df < 1 ? null : T90[Math.min(df, T90.length - 1)] ?? 1.645);

/* shots: relayed rows. yards: THIS shooter's distance, not the relay's. */
function relayCallError(shots, yards) {
  const yd = +yards;
  const called = (shots || []).filter(s =>
    !s.is_sighter && s.call_x_in != null && s.call_y_in != null);
  const n = called.length;
  if (!n || !Number.isFinite(yd) || yd <= 0) return null;

  // Error vector, impact minus call, in target inches. +x right, +y up.
  const ex = called.map(s => (+s.x_in || 0) - (+s.call_x_in || 0));
  const ey = called.map(s => (+s.y_in || 0) - (+s.call_y_in || 0));
  const mean = a => a.reduce((p, c) => p + c, 0) / a.length;
  const mx = mean(ex), my = mean(ey);

  // Sample sd, then the standard error of the mean. n-1: with n=1 there is no
  // spread estimate at all and the interval is honestly undefined.
  const sd = (a, m) => (a.length < 2 ? null
    : Math.sqrt(a.reduce((p, c) => p + (c - m) * (c - m), 0) / (a.length - 1)));
  const sx = sd(ex, mx), sy = sd(ey, my);
  const t = t90(n - 1);
  const ciX = sx == null || t == null ? null : t * sx / Math.sqrt(n);
  const ciY = sy == null || t == null ? null : t * sy / Math.sqrt(n);

  const moa = v => inchesToMoa(v, yd);
  const absMean = mean(called.map((_, i) => Math.hypot(ex[i], ey[i])));

  return {
    n, yards: yd,
    // signed offsets: + = impact right of / above the call
    windMoa: moa(mx), elevMoa: moa(my),
    ciWindMoa: ciX == null ? null : moa(ciX),
    ciElevMoa: ciY == null ? null : moa(ciY),
    // significant = the interval does not span zero
    windSig: ciX != null && Math.abs(mx) > ciX,
    elevSig: ciY != null && Math.abs(my) > ciY,
    // how well the shooter is calling at all, independent of any zero error
    absMeanMoa: moa(absMean),
    items: called.map((s, i) => ({
      shot: s, moa: moa(Math.hypot(ex[i], ey[i])),
      windMoa: moa(ex[i]), elevMoa: moa(ey[i]),
    })),
  };
}

/* One axis, phrased as an instruction rather than a measurement. The scope
 * moves the way you want the group to move, so an impact ABOVE the call is
 * corrected DOWN -- the sign flip is the whole reason this is a component and
 * not an inline template string.
 *
 * The number is ALWAYS printed, even when it is inside its own noise. Hiding
 * it takes the judgement away from the coach, who can see the string, knows
 * the conditions, and is better placed than a t-test to decide whether a
 * quarter minute is worth chasing. Confidence is carried by how the number
 * LOOKS -- full colour and a bare interval when confirmed, dimmed and marked
 * "unconfirmed" when the interval still spans zero -- so the distinction is
 * legible at a glance without ever being withheld. */
function CorrectionAxis({ moa, ci, sig, pos, neg, color }) {
  const dial = -moa;                                  // move the group back
  const mag = Math.abs(dial);
  // Below half a hundredth there is no direction worth naming, and "0.00 UP"
  // reads as an instruction when it is really a zero.
  const word = mag < 0.005 ? '' : (dial > 0 ? pos : neg);
  return (
    <div style={{ flex: 1, textAlign: 'center' }}>
      <div style={{ fontFamily: 'var(--fm)', fontSize: 17, fontWeight: 700,
        color: sig ? color : 'var(--dim)' }}>
        {mag.toFixed(2)}
        {word && <span style={{ fontSize: 10, marginLeft: 3 }}>{word}</span>}
      </div>
      <div style={{ fontFamily: 'var(--fm)', fontSize: 8, color: 'var(--dim)',
        textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 2 }}>
        {ci == null
          ? 'MOA · one shot'
          : `MOA ±${ci.toFixed(2)}${sig ? '' : ' · unconfirmed'}`}
      </div>
    </div>
  );
}

/* Both axes as a spoken instruction: "1.00 down and 0.50 left". */
function dialSentence(ce) {
  const part = (moa, pos, neg) => `${Math.abs(moa).toFixed(2)} ${moa > 0 ? pos : neg}`;
  return `${part(ce.elevMoa, 'down', 'up')} and ${part(ce.windMoa, 'left', 'right')}`;
}

/* The coach's card. Always shows the number; marks how much to trust it. */
function CallErrorCard({ ce, color, name }) {
  if (!ce) return null;
  const any = ce.windSig || ce.elevSig;
  return (
    <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--bdr)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
        <div className="lbl">Call vs impact</div>
        <div style={{ fontFamily: 'var(--fm)', fontSize: 8, color: 'var(--dim)' }}>
          {ce.n} called · {ce.yards}yd
        </div>
      </div>
      <div style={{ display: 'flex' }}>
        <CorrectionAxis moa={ce.elevMoa} ci={ce.ciElevMoa} sig={ce.elevSig}
          pos="UP" neg="DOWN" color={color}/>
        <CorrectionAxis moa={ce.windMoa} ci={ce.ciWindMoa} sig={ce.windSig}
          pos="RIGHT" neg="LEFT" color={color}/>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--fm)', fontSize: 17, fontWeight: 700, color: 'var(--ink)' }}>
            {ce.absMeanMoa.toFixed(2)}
          </div>
          <div style={{ fontFamily: 'var(--fm)', fontSize: 8, color: 'var(--dim)',
            textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 2 }}>
            MOA call miss
          </div>
        </div>
      </div>
      <div style={{ fontFamily: 'var(--fm)', fontSize: 8, color: 'var(--dim)',
        lineHeight: 1.5, marginTop: 7 }}>
        {any
          ? <>Dial <b>{[
              ce.elevSig ? `${Math.abs(ce.elevMoa).toFixed(2)} ${ce.elevMoa > 0 ? 'down' : 'up'}` : null,
              ce.windSig ? `${Math.abs(ce.windMoa).toFixed(2)} ${ce.windMoa > 0 ? 'left' : 'right'}` : null,
            ].filter(Boolean).join(' and ')}</b> — {name || 'this shooter'} is
            landing that far from their own call, consistently enough that it is not
            chance.{(!ce.elevSig || !ce.windSig) && ' The dimmed axis is still inside its own interval — your call.'} The
            third number is how tightly they are calling at all; it does not go to zero
            however well the rifle is zeroed.</>
          : <>Reading <b>{dialSentence(ce)}</b>, but both intervals still span zero — on
            this many shots that is as consistent with scatter as with a zero error, so
            it is a trend to watch rather than a number to dial. It firms up as the
            string grows. The third number is how tightly they are calling.</>}
      </div>
    </div>
  );
}

/* Statistics from relayed points alone. No target geometry required -- ES and
 * mean radius are pure point geometry, and score is the sum of ring labels. */
function relayStats(shots) {
  const rec = (shots || []).filter(s => !s.is_sighter);
  const pts = rec.map(s => ({ x: +s.x_in || 0, y: +s.y_in || 0 }));
  const score = rec.reduce((a, s) => a + (s.ring === 'X' ? 10 : (+s.ring || 0)), 0);
  const xs = rec.filter(s => s.ring === 'X').length;
  if (pts.length < 2) return { n: pts.length, score, xs, mr: null, es: null, pts, cx: 0, cy: 0 };
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const mr = pts.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
  let es = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      es = Math.max(es, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  return { n: pts.length, score, xs, mr, es, pts, cx, cy };
}

/* Split a relay's shots into one string per firing point. Shots whose shooter
 * has left carry a null slot; they are kept under slot 0 rather than dropped,
 * because a string that vanishes when someone closes their phone is worse
 * than one attributed to "left the relay". */
function relaySeries(shots, participants) {
  const by = new Map();
  (shots || []).forEach(s => {
    const k = s.slot == null ? 0 : +s.slot;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  });
  (participants || []).filter(p => p.role === 'shooter' && p.slot != null)
    .forEach(p => { if (!by.has(+p.slot)) by.set(+p.slot, []); });
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([slot, ss]) => {
    const who = (participants || []).find(p => +p.slot === slot);
    const yards = who?.distance_yd != null ? +who.distance_yd : null;
    return {
      slot,
      name: ss[0]?.shooter || who?.name || (slot ? `Point ${slot}` : 'Left the relay'),
      isSelf: !!(ss.some(s => s.is_self) || who?.is_self),
      away: who ? undefined : true,
      color: slotColor(slot || 1),
      shots: ss,
      yards,
      stats: relayStats(ss),
      // Minutes are inches over THIS shooter's distance. A pair is not always
      // on the same line, so it is never taken from the relay.
      callError: relayCallError(ss, yards),
    };
  });
}

/* Target-centred scatter, one or more strings at once.
 *
 * Plotted in TARGET coordinates rather than re-centred on each group's own
 * centroid. Re-centring makes two groups easy to compare for size and lies
 * about where either of them actually sits, which is the more important fact
 * when a coach is deciding whether to call a sight change. */
function RelayPlot({ series, yards, size, target }) {
  const SZ = size || 190, pad = 14, c = SZ / 2;
  const all = series.flatMap(s => s.stats.pts);
  if (!all.length) return null;

  /* Both shooters of a pair fire the SAME target, so their coordinates share
   * one frame and the honest picture is one target face with both strings on
   * it. Where the geometry travelled with the relay, draw the real paper and
   * scale it the way the shooter's own plot does; otherwise fall back to a
   * bare grid, which is all an older host will have sent. */
  const face = target && target.rings?.length ? target : null;
  const sc = face
    ? (SZ * 0.88) / (steppedViewRadius(face, all, { pad: 0.6, minStepIdx: 1 }) * 2)
    : (c - pad) / (Math.max(0.5, ...all.map(p => Math.hypot(p.x, p.y))) * 1.15);

  return (
    <svg width="100%" viewBox={`0 0 ${SZ} ${SZ}`}
      style={{ maxWidth: 280, display: 'block', margin: '0 auto',
               background: '#1a1d27', borderRadius: 6 }}>
      {face
        ? <TargetFace target={face} SZ={SZ} c={c} sc={sc}/>
        : <rect width={SZ} height={SZ} fill="var(--surf2)" rx="6"/>}
      <line x1={c} y1={pad / 2} x2={c} y2={SZ - pad / 2}
        stroke={face ? '#ffffff22' : 'var(--bdr)'} strokeWidth={face ? 0.5 : 1}/>
      <line x1={pad / 2} y1={c} x2={SZ - pad / 2} y2={c}
        stroke={face ? '#ffffff22' : 'var(--bdr)'} strokeWidth={face ? 0.5 : 1}/>

      {series.map(s => s.stats.mr != null && (
        <circle key={'mr' + s.slot} cx={c + s.stats.cx * sc} cy={c - s.stats.cy * sc}
          r={s.stats.mr * sc} fill="none" stroke={s.color} strokeWidth="1"
          strokeDasharray="3 3" opacity="0.75"/>
      ))}

      {series.map(s => s.shots.filter(x => !x.is_sighter).map((x, i) => {
        const px = c + (+x.x_in || 0) * sc, py = c - (+x.y_in || 0) * sc;
        return (
          <g key={s.slot + '-' + x.id}>
            {/* the call, when the shooter recorded one: hollow, joined to the
                impact. The line IS the information. */}
            {x.call_x_in != null && (
              <>
                <line x1={c + (+x.call_x_in) * sc} y1={c - (+x.call_y_in || 0) * sc}
                  x2={px} y2={py} stroke={s.color} strokeWidth="0.7" opacity="0.5"/>
                <circle cx={c + (+x.call_x_in) * sc} cy={c - (+x.call_y_in || 0) * sc}
                  r="2.5" fill="none" stroke={s.color} strokeWidth="0.9" opacity="0.7"/>
              </>
            )}
            {/* A white ring around every impact: on a real target face the
                shooter colours sit on top of paper that may be any colour,
                and an unoutlined dot vanishes into the black. */}
            <circle cx={px} cy={py} r="5" fill={s.color}
              stroke="#ffffff" strokeWidth={face ? 1 : 0} opacity={s.isSelf ? 1 : 0.85}/>
            <text x={px} y={py + 3} textAnchor="middle"
              style={{ fontFamily: 'var(--fm)', fontSize: 7, fill: '#1a1d27', fontWeight: 700 }}>
              {i + 1}</text>
          </g>
        );
      }))}

      <text x={c} y={SZ - 3} textAnchor="middle"
        style={{ fontFamily: 'var(--fm)', fontSize: 7, fill: face ? '#ffffffaa' : 'var(--dim)' }}>
        {face ? face.name : 'centre = point of aim'}{yards ? ` · ${yards}yd` : ''}
      </text>
    </svg>
  );
}

/* The four numbers, in one shooter's colour. */
function RelayScoreRow({ stats, color }) {
  const cell = { textAlign: 'center', flex: 1 };
  const val = { fontFamily: 'var(--fm)', fontSize: 17, fontWeight: 700, color };
  const lab = { fontFamily: 'var(--fm)', fontSize: 8, color: 'var(--dim)',
                textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 2 };
  return (
    <div style={{ display: 'flex' }}>
      <div style={cell}><div style={val}>{stats.score}
        <span style={{ fontSize: 11, color: 'var(--dim)' }}>–{stats.xs}X</span></div>
        <div style={lab}>Score</div></div>
      <div style={cell}><div style={val}>{stats.mr != null ? stats.mr.toFixed(2) : '—'}</div>
        <div style={lab}>MR in</div></div>
      <div style={cell}><div style={val}>{stats.es != null ? stats.es.toFixed(2) : '—'}</div>
        <div style={lab}>ES in</div></div>
      <div style={cell}><div style={val}>{stats.n}</div><div style={lab}>Shots</div></div>
    </div>
  );
}

/* The string as chips. Called shots get a mark, because "did he call it" is
 * the first question a coach asks about a dropped point. */
function RelayShotStrip({ shots, color, yards }) {
  if (!shots.length) return null;
  const yd = +yards;
  const usable = Number.isFinite(yd) && yd > 0;
  let n = 0;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {shots.map(s => {
        const label = s.is_sighter ? 'S' : String(++n);
        const called = s.call_x_in != null;
        // Minutes, not inches: a coach dials minutes, and 0.4" means nothing
        // without the distance attached to it.
        const missIn = called
          ? Math.hypot((+s.x_in || 0) - (+s.call_x_in || 0), (+s.y_in || 0) - (+s.call_y_in || 0))
          : null;
        const miss = called && usable ? inchesToMoa(missIn, yd) : missIn;
        const unit = usable ? '′' : '\u2033';
        return (
          <div key={s.id} title={called
            ? `called ${miss.toFixed(2)}${usable ? ' MOA' : ' in'} off`
            : undefined}
            style={{ fontFamily: 'var(--fm)', fontSize: 11, padding: '3px 7px', borderRadius: 4,
              background: s.is_sighter ? 'transparent' : 'var(--surf2)',
              border: `1px ${s.is_sighter ? 'dashed' : 'solid'} ${s.is_sighter ? 'var(--bdr)' : color + '66'}`,
              color: s.ring === 'X' ? color : 'var(--ink)' }}>
            {label}<span style={{ color: 'var(--dim)' }}>·</span>{s.ring}
            {called && <span style={{ color: 'var(--dim)', fontSize: 8 }}> ◦{miss.toFixed(1)}{unit}</span>}
          </div>
        );
      })}
    </div>
  );
}

/* One card per shooter: numbers, plot, string. Stacked rather than side by
 * side because a coach is holding a phone, and two 190px plots on a 430px
 * screen makes both of them useless. */
function RelayShooterCard({ s, yards, dense, faceOf = () => null }) {
  const yd = s.yards || yards;
  return (
    <div className="tcard" style={{ padding: '11px 13px', borderColor: s.color + '55' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <div style={{ width: 9, height: 9, borderRadius: 2, background: s.color }}/>
        <div style={{ fontFamily: 'var(--fm)', fontSize: 11, fontWeight: 700 }}>{s.name}</div>
        {s.isSelf && <div style={{ fontFamily: 'var(--fm)', fontSize: 8, color: 'var(--dim)' }}>you</div>}
        {s.away && <div style={{ fontFamily: 'var(--fm)', fontSize: 8, color: 'var(--dim)' }}>left</div>}
      </div>
      <RelayScoreRow stats={s.stats} color={s.color}/>
      {!dense && s.stats.pts.length > 0 && (
        <div style={{ marginTop: 9 }}><RelayPlot series={[s]} yards={yards} target={faceOf(s)}/></div>
      )}
      {s.shots.length > 0
        ? <div style={{ marginTop: 9 }}>
            <RelayShotStrip shots={s.shots} color={s.color} yards={yd}/></div>
        : <div style={{ marginTop: 9, fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--dim)' }}>
            Waiting for the first shot…
          </div>}
      <CallErrorCard ce={s.callError} color={s.color} name={s.name}/>
    </div>
  );
}

/* The feed is the only two-way channel, and every device renders it from this
 * one component rather than from two that drift apart. Wind calls are tagged
 * separately from chatter: on a firing line "half value from 4" and "nice
 * shot" want different weight at a glance. */
function RelayFeed({ core, messages, disabled, maxHeight }) {
  const [draft, setDraft] = useState('');
  const ref = useRef(null);
  const list = messages || [];

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [list.length]);

  const send = (kind) => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    core.relaySend(body, kind);
  };

  return (
    <>
      <div className="lbl" style={{ marginBottom: 6 }}>Feed</div>
      <div ref={ref} style={{ maxHeight: maxHeight || 190, overflowY: 'auto', marginBottom: 8 }}>
        {list.length === 0 && (
          <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--dim)' }}>
            Wind calls and chatter appear here.
          </div>)}
        {list.map(m => (
          <div key={m.id} style={{ marginBottom: 5 }}>
            <span style={{ fontFamily: 'var(--fm)', fontSize: 9,
              color: m.kind === 'wind' ? 'var(--acc)' : 'var(--dim)' }}>
              {m.kind === 'wind' ? '◈ ' : ''}{m.author_name}
            </span>
            <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>{m.body}</div>
          </div>
        ))}
      </div>
      {!disabled && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="inp" value={draft} maxLength={500}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send('chat'); }}
            placeholder="message" style={{ flex: 1 }}/>
          <button className="badd" onClick={() => send('wind')}
            style={{ fontSize: 10, padding: '5px 9px' }}>wind</button>
          <button className="badd" onClick={() => send('chat')}
            style={{ fontSize: 10, padding: '5px 9px' }}>send</button>
        </div>
      )}
    </>
  );
}

/* Who is here, and who has actually got their eyes on it. Presence is real
 * rather than decorative: relay_state stamps last_seen_at on every poll, so a
 * phone that has gone dark stops counting as watching after 20 seconds. */
function RelayRoster({ participants, serverTime, compact }) {
  const list = participants || [];
  if (!list.length) return null;
  const now = serverTime ? Date.parse(serverTime) : Date.now();
  const away = p => now - Date.parse(p.last_seen_at) > 20000;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {list.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4,
          fontFamily: 'var(--fm)', fontSize: compact ? 9 : 10,
          opacity: away(p) ? 0.45 : 1 }}>
          <div style={{ width: 7, height: 7, borderRadius: 2,
            background: p.slot != null ? slotColor(p.slot) : 'var(--dim)' }}/>
          <span>{p.name}</span>
          <span style={{ color: 'var(--dim)' }}>
            {p.role === 'coach' ? 'coach' : `pt${p.slot ?? '?'}`}{away(p) ? ' · away' : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/* The full-screen view for anyone not shooting on this device: a coach, or a
 * shooter who joined from the home screen without binding a session. */
function RelayViewer({ core, onExit }) {
  const [state, setState] = useState(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    const offs = [
      core.on(core.EVENTS.RELAY_STATE, p => setState(p)),
      core.on(core.EVENTS.RELAY_ENDED, () => setEnded(true)),
    ];
    return () => offs.forEach(o => o());
  }, [core]);

  const info = core.relayInfo();
  const relay = state?.relay;
  const series = relaySeries(state?.shots, state?.participants);
  const withShots = series.filter(s => s.stats.pts.length > 0);

  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="hdr">
          <button className="bback" onClick={() => { core.stopRelay(); onExit(); }}>← leave</button>
          <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: ended ? 'var(--dim)' : 'var(--green)' }}>
            {ended ? '○ ended' : '● live'} · {info?.code}
          </div>
        </div>
        <div className="content">
          <div style={{ padding: '13px 13px 4px' }}>
            <div style={{ fontFamily: 'var(--fh)', fontSize: 18, fontWeight: 700 }}>
              {relay?.title || 'Pair fire'}
            </div>
            <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>
              {[relay?.target_name, relay?.distance_yd && `${relay.distance_yd}yd`]
                .filter(Boolean).join(' · ')}
            </div>
            <div style={{ marginTop: 7 }}>
              <RelayRoster participants={state?.participants} serverTime={state?.serverTime}/>
            </div>
          </div>

          {ended && (
            <div className="tcard" style={{ padding: '11px 13px' }}>
              <div style={{ fontFamily: 'var(--fm)', fontSize: 11, color: 'var(--dim)' }}>
                This relay has ended. What follows is the final state.
              </div>
            </div>
          )}

          {/* Both strings on one target first, then a card each. The combined
              plot is the coach's actual question: are these two groups in the
              same place, or is one of them fighting a different wind? */}
          {withShots.length > 1 && (
            <div className="tcard" style={{ padding: '11px 13px' }}>
              <div className="lbl" style={{ marginBottom: 8 }}>Both strings</div>
              <RelayPlot series={withShots} yards={relay?.distance_yd} size={250}
                target={relay?.target_rings}/>
            </div>
          )}

          {series.length === 0 && (
            <div className="tcard" style={{ padding: '11px 13px' }}>
              <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--dim)' }}>
                Waiting for the first shot…
              </div>
            </div>
          )}
          {series.map(s => (
            <RelayShooterCard key={s.slot} s={s} yards={relay?.distance_yd}
              dense={withShots.length > 1} faceOf={() => relay?.target_rings}/>
          ))}

          <div className="tcard" style={{ padding: '11px 13px' }}>
            <RelayFeed core={core} messages={state?.messages} disabled={ended}/>
          </div>

          <div style={{ margin: '2px 13px 20px', fontFamily: 'var(--fm)', fontSize: 8,
            color: 'var(--dim)', lineHeight: 1.5 }}>
            A hollow ring joined to an impact is the shooter's call: where the sights
            were when the shot broke. The gap between the two is the shot they did not
            know they threw.
          </div>
        </div>
      </div>
    </>
  );
}

function JoinLiveForm({ core, onJoined, onCancel, fixedRole, note, distanceYd }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState(fixedRole || 'coach');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function go() {
    setBusy(true); setErr(null);
    const r = await core.joinRelay(code, name || 'Guest', role, { distanceYd });
    setBusy(false);
    if (!r.ok) { setErr(relayErrText(r)); return; }
    onJoined(r);
  }

  const inp = { width: '100%', background: 'var(--surf2)', border: '1px solid var(--bdr)',
                borderRadius: 5, padding: '9px 10px', color: 'var(--ink)',
                fontFamily: 'var(--fm)', fontSize: 12, marginBottom: 7 };

  return (
    <div className="tcard" style={{ padding: '11px 13px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="lbl">{fixedRole === 'shooter' ? 'Join your partner' : 'Join a live relay'}</div>
        <button onClick={onCancel} style={{ background: 'none', border: 'none',
          color: 'var(--dim)', cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
      </div>
      <input style={{ ...inp, fontSize: 22, letterSpacing: '.28em', textAlign: 'center' }}
        value={code} maxLength={4} autoCapitalize="characters" autoComplete="off"
        onChange={e => setCode(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''))}
        placeholder="CODE"/>
      <input style={inp} value={name} onChange={e => setName(e.target.value)}
        placeholder="your name" maxLength={40}/>
      {!fixedRole && (
        <select style={inp} value={role} onChange={e => setRole(e.target.value)}>
          <option value="coach">Coach — spotting, calling wind, scoring nothing</option>
          <option value="shooter">Shooter — firing my own string</option>
        </select>
      )}
      <button className="badd" style={{ width: '100%', opacity: (code.length === 4 && !busy) ? 1 : 0.4 }}
        disabled={code.length !== 4 || busy} onClick={go}>
        {busy ? 'joining…' : '● join live'}</button>
      {err && <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--red)', marginTop: 7 }}>{err}</div>}
      <div style={{ fontFamily: 'var(--fm)', fontSize: 8.5, color: 'var(--dim)', marginTop: 7, lineHeight: 1.5 }}>
        {note || 'No account needed. The code works only while the relay is live.'}
      </div>
    </div>
  );
}

/* One place to turn a relay failure into something a shooter can act on.
 * The anonymous-sign-in case is called out by name because it is the single
 * most likely first-run failure: the relay needs no accounts, but "no
 * accounts" is implemented as anonymous sign-in, which ships DISABLED. */
function relayErrText(r) {
  if (!r) return 'Could not reach the server. Check your connection.';
  if (r.reason === 'throttled') return 'Too many attempts. Wait a few minutes.';
  if (r.reason === 'full') return r.message || 'That relay already has four shooters.';
  if (r.reason === 'not_found') return 'No live relay with that code.';
  const e = String(r.error || '');
  if (/anonymous|signups? not allowed|signup_disabled/i.test(e))
    return 'Anonymous sign-in is disabled on the server. Enable it under Auth → Providers in the Supabase dashboard.';
  return r.message || 'Could not connect. Check your connection and try again.';
}

/* ── The shooter's own card, on their own session ─────────────────────────
 * Deliberately compact: the shooter is on the line, and this must not push
 * the shot list off the screen. Three states — idle, live, and the join form
 * for the second shooter of a pair. */
function RelayCard({ core, live, hostName, onHostName, onGoLive, onJoinLive, onEndLive, distanceYd }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!core) return undefined;
    return core.on(core.EVENTS.RELAY_STATE, p => setState(p));
  }, [core]);
  useEffect(() => { if (!live) { setState(null); setJoining(false); } }, [live]);

  if (!core) return null;

  const wrap = { margin: '8px 13px 0', background: 'var(--surf)',
                 border: '1px solid var(--bdr)', borderRadius: 9, padding: '11px 13px' };
  const note = { fontFamily: 'var(--fm)', fontSize: 8, color: 'var(--dim)',
                 lineHeight: 1.5, marginTop: 7 };

  if (!live) {
    if (joining) {
      return (
        <div style={{ margin: '8px 0 0' }}>
          <JoinLiveForm core={core} fixedRole="shooter" distanceYd={distanceYd}
            note="Your shots mirror to this relay from this session. Your partner's string is drawn over your target in their colour."
            onCancel={() => setJoining(false)}
            onJoined={r => { setJoining(false); onJoinLive(r); }}/>
        </div>
      );
    }
    return (
      <div style={wrap}>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="inp" style={{ flex: 1, fontSize: 11, padding: '7px 9px' }}
            value={hostName} maxLength={40} placeholder="your name"
            onChange={e => onHostName(e.target.value)}/>
          <button className="badd" disabled={busy} style={{ opacity: busy ? 0.4 : 1, whiteSpace: 'nowrap' }}
            onClick={async () => {
              setBusy(true); setErr(null);
              const r = await onGoLive((hostName || '').trim() || 'Shooter');
              setBusy(false);
              if (!r || !r.ok) setErr(relayErrText(r));
            }}>{busy ? 'starting…' : '● go live'}</button>
          <button className="badd" onClick={() => setJoining(true)}
            style={{ background: 'none', border: '1px solid var(--bdr)', color: 'var(--ink)',
                     whiteSpace: 'nowrap' }}>join</button>
        </div>
        <div style={note}>
          <b>Go live</b> starts a relay and hands you a 4-character code — read it to your
          partner and your coach. <b>Join</b> puts you on someone else's code as the second
          shooter. Either way this session's shots mirror across, and your partner's string
          is drawn over your target in their colour.
        </div>
        {err && <div style={{ ...note, color: 'var(--red)' }}>{err}</div>}
      </div>
    );
  }

  const info = core.relayInfo();
  const series = relaySeries(state?.shots, state?.participants);
  const partners = series.filter(s => !s.isSelf && s.shots.length);

  return (
    <div style={{ ...wrap, borderColor: slotColor(info?.slot) }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div style={{ fontFamily: 'var(--fm)', fontSize: 9, color: 'var(--green)',
            letterSpacing: '.1em', textTransform: 'uppercase' }}>
            ● live{info?.isHost ? ' · read this out' : ''}
          </div>
          <div style={{ fontFamily: 'var(--fm)', fontSize: 30, fontWeight: 700,
            letterSpacing: '.22em', color: slotColor(info?.slot), marginTop: 2 }}>{info?.code}</div>
        </div>
        <button className="badd" onClick={onEndLive}
          style={{ background: 'none', border: '1px solid var(--bdr)', color: 'var(--ink)' }}>
          {info?.isHost ? 'end' : 'leave'}</button>
      </div>

      <div style={{ marginTop: 7 }}>
        <RelayRoster participants={state?.participants} serverTime={state?.serverTime} compact/>
      </div>

      {partners.length === 0
        ? <div style={{ ...note, marginTop: 8 }}>
            Nobody else has fired yet. Their shots will appear over your target in their colour.
          </div>
        : partners.map(s => (
            <div key={s.slot} style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--bdr)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color }}/>
                <div style={{ fontFamily: 'var(--fm)', fontSize: 10, fontWeight: 700 }}>{s.name}</div>
                <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: s.color, marginLeft: 'auto' }}>
                  {s.stats.score}–{s.stats.xs}X
                  <span style={{ color: 'var(--dim)' }}> · {s.stats.n} shots</span>
                </div>
              </div>
              <RelayShotStrip shots={s.shots} color={s.color}/>
            </div>
          ))}

      <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--bdr)' }}>
        <RelayFeed core={core} messages={state?.messages} maxHeight={130}/>
      </div>

      <div style={note}>
        Your shots mirror as you log them. Leaving this session does not end the relay —
        tap {info?.isHost ? '“end”' : '“leave”'}, or it expires on its own.
      </div>
    </div>
  );
}

function SyncPanel({ core, cfg, onSaveCfg, sessions, ammo, getTarget, onSessionsUpdated, onAmmoUpdated }) {
  const [edit, setEdit] = useState(!cfg && !HAS_SHARED);
  const [handle, setHandle] = useState('');
  const [handleSaved, setHandleSaved] = useState(false);
  const [url, setUrl] = useState(cfg?.url || '');
  const [key, setKey] = useState(cfg?.anonKey || '');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);       // {kind:'ok'|'err', text}
  const [, bump] = useState(0);               // re-render on core events

  useEffect(() => {
    if (!core) return undefined;
    const offs = [core.EVENTS.AUTH_SIGNED_IN, core.EVENTS.AUTH_SIGNED_OUT,
                  core.EVENTS.OUTBOX_CHANGED, core.EVENTS.SYNC_DONE, core.EVENTS.SYNC_ERROR]
      .map(e => core.on(e, () => bump(n => n + 1)));
    return () => offs.forEach(off => off());
  }, [core]);

  const linkedLoads = ammo.filter(a => a.batchId).length;
  const lbl = { fontFamily:'var(--fm)', fontSize:9, color:'var(--dim)',
                letterSpacing:'.1em', textTransform:'uppercase', marginBottom:8 };
  const note = { fontFamily:'var(--fm)', fontSize:8, color:'var(--dim)', lineHeight:1.5, marginTop:8 };
  const inp = { width:'100%', background:'var(--surf2)', border:'1px solid var(--bdr)',
                borderRadius:5, padding:'8px 10px', color:'var(--ink)',
                fontFamily:'var(--fm)', fontSize:11, marginBottom:7 };

  /* A sync is the natural moment to re-read Bench: it is when the user
   * already expects the two apps to agree. Doing it here rather than on a
   * timer means a batch quarantined this morning is blocked before the first
   * session of the afternoon, without Zero polling all day. */
  async function refreshBatchesOnSync() {
    try {
      const next = await refreshLinkedBatches(core, ammo, Date.now());
      if (next && onAmmoUpdated) onAmmoUpdated(next);
    } catch (_) { /* never let a batch refresh fail a sync */ }
  }

  async function doSync() {
    if (!core || !core.isSignedIn()) return;
    setBusy(true); setMsg(null);
    try {
      // Assign + PERSIST remote ids before the network runs: if they were not
      // saved first, a retry would mint fresh UUIDs and duplicate every row.
      const out = zeroSyncOutbound(core, sessions, ammo, getTarget);
      if (out.changed) await onSessionsUpdated(out.updated);
      const r = await core.sync({ trigger: 'manual' });
      await refreshBatchesOnSync();
      setMsg(r.ok
        ? { kind:'ok', text:`Synced — ${out.queued} linked session${out.queued===1?'':'s'} pushed, ${r.stats.pulled} row${r.stats.pulled===1?'':'s'} pulled.` }
        : { kind:'err', text:'Sync failed: ' + r.reason });
    } catch (e) { setMsg({ kind:'err', text:'Sync failed: ' + (e?.message || e) }); }
    setBusy(false);
  }

  async function doAuth(mode) {
    if (!core) return;
    setBusy(true); setMsg(null);
    const r = mode === 'up' ? await core.signUp(email.trim(), pw)
                            : await core.signIn(email.trim(), pw);
    setBusy(false);
    if (!r.ok) setMsg({ kind:'err', text:(r.error?.msg || r.error?.error_description || r.error?.message || 'Sign-in failed.') });
    else if (r.needsConfirmation) setMsg({ kind:'ok', text:'Account created — confirm the email, then sign in.' });
    else { setPw(''); setMsg(null); }
  }

  return (
    <div style={{margin:'8px 13px', background:'var(--surf)', border:'1px solid var(--bdr)', borderRadius:9, padding:'11px 13px'}}>
      <div style={{...lbl, display:'flex', justifyContent:'space-between'}}>
        <span>Cloud sync · Bench · leaderboard</span>
        {!HAS_SHARED && cfg && <button onClick={()=>setEdit(e=>!e)} style={{background:'none',border:'none',color:'var(--dim)',fontFamily:'var(--fm)',fontSize:9,cursor:'pointer',padding:0}}>{edit?'close':'server'}</button>}
      </div>

      {edit && (
        <div>
          <input style={inp} value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://YOUR-PROJECT.supabase.co" autoCapitalize="none" spellCheck="false"/>
          <input style={inp} value={key} onChange={e=>setKey(e.target.value)} placeholder="anon public key" autoCapitalize="none" spellCheck="false"/>
          <button className="badd" style={{width:'100%', opacity:(url.trim()&&key.trim())?1:0.4}}
            onClick={()=>{ if(url.trim()&&key.trim()){ onSaveCfg({url:url.trim().replace(/\/+$/,''), anonKey:key.trim()}); setEdit(false);} }}>
            save server</button>
          <div style={note}>The same Supabase project Bench uses. The anon key is the public one — never the service_role key.</div>
        </div>
      )}

      {!edit && core && !core.isSignedIn() && (
        <div>
          <input style={inp} type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="email" autoCapitalize="none"/>
          <input style={inp} type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="password"/>
          <div style={{display:'flex', gap:8}}>
            <button className="badd" style={{flex:1, opacity:busy?0.5:1}} disabled={busy} onClick={()=>doAuth('in')}>sign in</button>
            <button className="badd" style={{flex:1, background:'none', border:'1px solid var(--bdr)', color:'var(--ink)', opacity:busy?0.5:1}} disabled={busy} onClick={()=>doAuth('up')}>create account</button>
          </div>
          <div style={note}>One account, both apps. Offline writes queue and send on the next sync.</div>
        </div>
      )}

      {!edit && core && core.isSignedIn() && (
        <div>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', fontFamily:'var(--fm)', fontSize:10, color:'var(--ink)'}}>
            <span style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:180}}>{core.getUser()?.email || 'signed in'}</span>
            <button onClick={()=>{ core.signOut(); }} style={{background:'none', border:'none', color:'var(--dim)', fontFamily:'var(--fm)', fontSize:9, cursor:'pointer', padding:0}}>sign out</button>
          </div>
          <div style={{display:'flex', gap:8, marginTop:9}}>
            <button className="badd" style={{flex:1, opacity:busy?0.5:1}} disabled={busy} onClick={doSync}>
              {busy ? 'syncing…' : `⇅ Sync now${core.pendingCount() ? ` (${core.pendingCount()})` : ''}`}</button>
          </div>

          {/* Public handle: the ONLY thing other shooters see. Claiming one is
              required before publishing, so nobody lands on the board as a
              raw account id. */}
          <div style={{display:'flex', gap:6, marginTop:9}}>
            <input style={{...inp, marginBottom:0, flex:1}} value={handle}
              onChange={e=>{ setHandle(e.target.value); setHandleSaved(false); }}
              placeholder="leaderboard handle" autoCapitalize="none" spellCheck="false" maxLength={24}/>
            <button className="badd" style={{fontSize:10, opacity:/^[A-Za-z0-9_-]{3,24}$/.test(handle)?1:0.4}}
              onClick={()=>{ if(/^[A-Za-z0-9_-]{3,24}$/.test(handle)){ core.claimHandle(handle); setHandleSaved(true); } }}>
              {handleSaved ? 'queued' : 'claim'}</button>
          </div>
          <div style={note}>3–24 letters, numbers, _ or -. Claimed on the next sync; taken handles are refused by the server.</div>
          {core.rejectedList().length > 0 && (
            <div style={{...note, color:'var(--red)'}}>
              {core.rejectedList().length} write{core.rejectedList().length===1?'':'s'} refused by the server
              (e.g. a handle already taken). They were dropped from the queue so sync keeps working.
              <button onClick={()=>{ core.clearRejected(); bump(n=>n+1); }}
                style={{background:'none',border:'none',color:'var(--dim)',fontFamily:'var(--fm)',fontSize:8,cursor:'pointer',padding:0,marginLeft:6,textDecoration:'underline'}}>dismiss</button>
            </div>
          )}
          <div style={note}>
            {linkedLoads
              ? `${linkedLoads} load${linkedLoads===1?'':'s'} linked to Bench batches. Sessions shot with them push group size (inches) back to the batch record.`
              : 'No loads linked yet — Firearms › Ammunition › “⇣ Bench” imports batches from the reloading log.'}
          </div>
        </div>
      )}
      {msg && <div style={{...note, color: msg.kind==='err' ? 'var(--red)' : 'var(--green)'}}>{msg.text}</div>}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('sessions');
  const [sessions, setSessions] = useState([]);
  const [matches, setMatches] = useState([]);
  const [customTargets, setCustomTargets] = useState([]);
  const [deletedBuiltins, setDeletedBuiltins] = useState([]);
  const [firearms, setFirearms] = useState([]);
  const [ammo, setAmmo] = useState([]);
  const [screen, setScreen] = useState('home');
  const [activeSess, setActiveSess] = useState(null);
  const [ready, setReady] = useState(false);
  // {lastExportTs, sessionsAtExport} — drives the "export is stale" nudge.
  const [backupMeta, setBackupMeta] = useState(null);
  const [syncCfg, setSyncCfg] = useState(null);
  // Live relay (pair fire). Which local session is being mirrored lives HERE,
  // not in SessionDetail, so navigating away from the session does not
  // silently drop the relay or start mirroring a different session's shots.
  const [liveSess, setLiveSess] = useState(null);
  const [relayName, setRelayName] = useState('');
  const [showJoin, setShowJoin] = useState(false);

  /* Which collections could not be READ at boot.
   *
   * Every read below is wrapped in a catch, so a truncated value, a corrupt
   * JSON blob, or a QuotaExceededError thrown by the legacy-key migration
   * leaves that collection silently empty. "Empty because there is none" and
   * "empty because it could not be read" then look identical to the rest of
   * the app -- and the IDB mirror below used to treat them identically, which
   * is how a single unreadable key could destroy the backup for all of them. */
  const bootFailed = useRef({});

  useEffect(() => {
    (async () => {
      try { const r = await window.storage.get('sessions_v1'); if (r) setSessions(JSON.parse(r.value)); } catch { bootFailed.current.sessions = true; }
      try { const r = await window.storage.get('matches_v1'); if (r) setMatches(JSON.parse(r.value)); } catch { bootFailed.current.matches = true; }
      try { const r = await window.storage.get('custom_targets_v1'); if (r) setCustomTargets(JSON.parse(r.value)); } catch { bootFailed.current.customTargets = true; }
      try { const r = await window.storage.get('deleted_builtins_v1'); if (r) setDeletedBuiltins(JSON.parse(r.value)); } catch { bootFailed.current.deletedBuiltins = true; }
      try { const r = await window.storage.get('rifles_v1'); if (r) setFirearms(JSON.parse(r.value)); } catch { bootFailed.current.firearms = true; }
      try { const r = await window.storage.get('ammo_v1'); if (r) setAmmo(JSON.parse(r.value)); } catch { bootFailed.current.ammo = true; }
      try { const r = await window.storage.get('backup_meta_v1'); if (r) setBackupMeta(JSON.parse(r.value)); } catch {}
      try { const r = await window.storage.get(SYNC_CFG_KEY); if (r) setSyncCfg(JSON.parse(r.value)); } catch {}
      try { const r = await window.storage.get('relay_name_v1'); if (r) setRelayName(JSON.parse(r.value)); } catch {}
      setReady(true);
    })();
  }, []);

  // Ask the browser not to evict our storage bucket. Fire-and-forget: denial
  // is fine (the IDB mirror below is the fallback), and some embedded
  // contexts don't expose the API at all.
  useEffect(() => {
    try { navigator.storage?.persist?.().catch?.(()=>{}); } catch {}
  }, []);

  // Boot recovery: primary store empty but the IDB mirror has data → offer a
  // restore. Runs once, on the render where `ready` flips (state closure at
  // that point reflects everything the boot loader found).
  useEffect(() => {
    if (!ready) return;
    if (sessions.length || firearms.length || matches.length || customTargets.length) return;
    (async () => {
      const snap = await idbReadSnapshot();
      if (!snap) return;
      const nS = (snap.sessions||[]).length, nF = (snap.firearms||[]).length;
      if (!nS && !nF) return;
      const when = snap.savedAt ? new Date(snap.savedAt).toLocaleDateString() : 'earlier';
      if (window.confirm(`Primary storage came up empty, but a local safety mirror from ${when} has ${nS} sessions · ${nF} firearms. Restore it?`)) {
        if (Array.isArray(snap.sessions)) saveSessions(snap.sessions);
        if (Array.isArray(snap.matches)) saveMatches(snap.matches);
        if (Array.isArray(snap.customTargets)) saveCustomTargets(snap.customTargets);
        if (Array.isArray(snap.deletedBuiltins)) saveDeletedBuiltins(snap.deletedBuiltins);
        if (Array.isArray(snap.firearms)) saveFirearms(snap.firearms);
        if (Array.isArray(snap.ammo)) saveAmmo(snap.ammo);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /* Mirror writes: a debounced snapshot of every collection to IndexedDB.
   *
   * The old guard was an OR across all six collections, so it passed as soon as
   * ANY of them was non-empty -- and then wrote the empty ones over the good
   * snapshot. Concretely: sessions_v1 fails to parse while rifles_v1 loads
   * fine, the guard sees firearms.length and lets the write through, and 1.5s
   * later the mirror's session history is replaced with []. The restore prompt
   * above requires sessions AND firearms AND matches AND targets to all be
   * empty, so it never fires. Both copies of a shooting log, gone, silently.
   *
   * The mirror is now merged per collection rather than replaced wholesale: any
   * collection that failed to READ at boot keeps whatever the previous snapshot
   * held. A collection the user genuinely emptied still mirrors as empty --
   * bootFailed distinguishes the two cases, which a length check never could. */
  useEffect(() => {
    if (!ready) return;
    if (!(sessions.length || firearms.length || matches.length || customTargets.length || deletedBuiltins.length)) return;
    const t = setTimeout(async () => {
      const prev = (await idbReadSnapshot()) || {};
      const keep = (name, cur) =>
        (bootFailed.current[name] && Array.isArray(prev[name]) ? prev[name] : cur);
      await idbWriteSnapshot({
        savedAt: Date.now(),
        sessions: keep('sessions', sessions),
        matches: keep('matches', matches),
        customTargets: keep('customTargets', customTargets),
        deletedBuiltins: keep('deletedBuiltins', deletedBuiltins),
        firearms: keep('firearms', firearms),
        ammo: keep('ammo', ammo),
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [ready, sessions, matches, customTargets, deletedBuiltins, firearms, ammo]);

  const visibleBuiltins = BUILTIN_TARGETS.filter(t => !deletedBuiltins.includes(t.id));
  const allTargets = [...visibleBuiltins, ...customTargets];

  const saveSessions = async data => {
    setSessions(data);
    try { await window.storage.set('sessions_v1', JSON.stringify(data)); } catch {}
  };
  const saveFirearms = async data => {
    setFirearms(data);
    try { await window.storage.set('rifles_v1', JSON.stringify(data)); } catch {}
  };
  const saveAmmo = async data => {
    setAmmo(data);
    try { await window.storage.set('ammo_v1', JSON.stringify(data)); } catch {}
  };
  const saveMatches = async data => {
    setMatches(data);
    try { await window.storage.set('matches_v1', JSON.stringify(data)); } catch {}
  };
  const saveCustomTargets = async data => {
    setCustomTargets(data);
    try { await window.storage.set('custom_targets_v1', JSON.stringify(data)); } catch {}
  };
  const saveDeletedBuiltins = async data => {
    setDeletedBuiltins(data);
    try { await window.storage.set('deleted_builtins_v1', JSON.stringify(data)); } catch {}
  };

  const saveSyncCfg = async data => {
    setSyncCfg(data);
    try { await window.storage.set(SYNC_CFG_KEY, JSON.stringify(data)); } catch {}
  };
  const saveRelayName = async data => {
    setRelayName(data);
    try { await window.storage.set('relay_name_v1', JSON.stringify(data)); } catch {}
  };

  // One zero-core instance per configured server. Its own session/outbox
  // persistence is independent of window.storage, so a reload stays signed in
  // and keeps unsent work.
  const effCfg = HAS_SHARED ? SHARED_SUPABASE : syncCfg;
  const core = useMemo(() => {
    if (!effCfg?.url || !effCfg?.anonKey) return null;
    try { return ZeroCore.create({ url: effCfg.url, anonKey: effCfg.anonKey, appId: 'zero' }); }
    catch { return null; }
  }, [effCfg?.url, effCfg?.anonKey]);

  // A relay can end without the host tapping "end": it expires, or going live
  // from a second session ends the first. The server's view wins.
  useEffect(() => {
    if (!core) return undefined;
    return core.on(core.EVENTS.RELAY_ENDED, () => setLiveSess(null));
  }, [core]);

  /* One shot, in the shape the relay wants. The call travels with it: the gap
   * between where a shooter said the sights were and where the hole is, is the
   * single most useful thing a coach reads off a live string. */
  const relayShotFor = (prior, sh, tgt) => {
    const p = shotXY(sh, tgt);
    const call = sh.callXY && typeof sh.callXY.x === 'number' ? sh.callXY : null;
    return {
      shotNo: prior.filter(x => !!x.isSighter === !!sh.isSighter).length + 1,
      ring: sh.ring, isSighter: !!sh.isSighter, x: p.x, y: p.y,
      callX: call ? call.x : null, callY: call ? call.y : null,
      windCallMoa: Number.isFinite(sh.windCallMoa) ? sh.windCallMoa : null,
      windCallDir: sh.windCallDir === 'L' || sh.windCallDir === 'R' ? sh.windCallDir : null,
    };
  };

  /* Bind a relay to a local session and push what has already been fired. A
   * shooter who goes live (or joins their partner) at shot 8 must not present
   * an empty target to everyone who just arrived. */
  const bindRelay = (sess, tgt) => {
    setLiveSess(sess.id);
    const prior = sess.shots || [];
    prior.forEach((sh, i) =>
      core.relayPushShot(relayShotFor(prior.slice(0, i), sh, tgt)));
  };

  const goLive = async (sess, tgt, name) => {
    if (!core) return { ok: false, error: 'no backend configured' };
    const r = await core.createRelay({
      hostName: name,
      title: sess.name || sess.rangeLocation || null,
      targetName: tgt?.name || null,
      // The face itself, so a coach can draw the real paper without owning
      // this target. A pair fires ONE target, so both strings land in one
      // frame and the overlay is the literal picture, not an approximation.
      targetRings: tgt ? { name: tgt.name, rings: tgt.rings, zones: tgt.zones || null } : null,
      distanceYd: +sess.rangeYards || null,
    });
    if (r.ok) bindRelay(sess, tgt);
    return r;
  };

  // The second shooter of a pair: JoinLiveForm has already joined by the time
  // this runs, so all that is left is to bind it to the session they are
  // actually shooting.
  const joinLive = (sess, tgt) => { if (core) bindRelay(sess, tgt); };

  // "End" for whoever started it, "leave" for anyone else -- a partner walking
  // off the line must not take the coach's screen down with them.
  const endLive = async () => {
    setLiveSess(null);
    if (core) await (core.relayInfo()?.isHost ? core.endRelay() : core.leaveRelay());
  };

  // Mirror one newly logged shot. Fire and forget by design: the local session
  // is the system of record, and a dead network must never block logging.
  const mirrorShot = (sess, tgt, sh) => {
    if (!core || liveSess !== sess.id) return;
    core.relayPushShot(relayShotFor(sess.shots || [], sh, tgt));
  };

  const importRef = useRef(null);

  // Full-data backup of all personal keys. Schema-versioned for forward compat.
  const exportBackup = () => {
    const payload = {
      schema: 'zero-backup', version: 1, exportedAt: new Date().toISOString(),
      data: {
        sessions_v1: sessions, matches_v1: matches, custom_targets_v1: customTargets,
        deleted_builtins_v1: deletedBuiltins, rifles_v1: firearms, ammo_v1: ammo,
      },
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const el = document.createElement('a');
      el.href = url;
      el.download = `zero-backup-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(el); el.click(); el.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // Record the export so the staleness nudge resets. Not part of the
      // backup payload itself (it's local bookkeeping, not user data).
      const meta = { lastExportTs: Date.now(), sessionsAtExport: sessions.length };
      setBackupMeta(meta);
      window.storage.set('backup_meta_v1', JSON.stringify(meta)).catch?.(()=>{});
    } catch (e) { window.alert('Export failed: ' + (e?.message || e)); }
  };

  // Restore REPLACES local data (merge risks silent ID-collision dupes).
  // Parsing goes through parseBackupText, which accepts the wrapped format,
  // the PWA build's bare-key exports, and legacy key names — the strict
  // schema check here was rejecting valid PWA exports. Only the keys actually
  // present in the file are replaced.
  const importBackup = file => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = parseBackupText(String(reader.result ?? ''));
      if (!res.ok) { window.alert('Import failed: ' + res.error); return; }
      if (!window.confirm(`Restore this backup?\n\nThis REPLACES ${res.found.join(', ')} with:\n${res.counts}\n\nExport a backup first if you want to keep what's here.`)) return;
      const d = res.data;
      if (d.sessions) saveSessions(d.sessions);
      if (d.matches) saveMatches(d.matches);
      if (d.customTargets) saveCustomTargets(d.customTargets);
      if (d.deletedBuiltins) saveDeletedBuiltins(d.deletedBuiltins);
      if (d.firearms) saveFirearms(d.firearms);
      if (d.ammo) saveAmmo(d.ammo);
      window.alert(`Backup restored: ${res.counts}.`);
    };
    reader.onerror = () => window.alert('Import failed: could not read file.');
    reader.readAsText(file);
  };

  const getTarget = id => {
    if (!allTargets.length) return BUILTIN_TARGETS[0]; // ultimate fallback
    return allTargets.find(t=>t.id===id) || allTargets[0];
  };

  if (!ready) return <><style>{S}</style><div style={{padding:40,fontFamily:'var(--fm)',fontSize:11,color:'var(--dim)'}}>loading...</div></>;

  if (screen === 'relay') {
    return <RelayViewer core={core} onExit={()=>setScreen('home')}/>;
  }

  if (screen === 'new_match') {
    return <MatchTemplateForm
      firearms={firearms}
      sessions={sessions}
      ammo={ammo}
      onBack={()=>setScreen('home')}
      onCreate={(tpl, opts) => {
        const built = buildMatchFromTemplate(tpl, opts);
        saveMatches([built.match, ...matches]);
        saveSessions([...built.sessions, ...sessions]);
        setScreen('home');
      }}
    />;
  }

  if (screen === 'new') {
    return <NewSession
      targets={allTargets}
      matches={matches}
      firearms={firearms}
      sessions={sessions}
      ammo={ammo}
      onBack={()=>setScreen('home')}
      onSave={(s, newMatch) => {
        const u = [s, ...sessions];
        saveSessions(u);
        if (newMatch) saveMatches([newMatch, ...matches]);
        setActiveSess(s.id);
        setScreen('detail');
      }}
    />;
  }

  if (screen === 'detail' && activeSess) {
    const sess = sessions.find(s=>s.id===activeSess);
    if (!sess) { setScreen('home'); return null; }
    const tgt = getTarget(sess.targetId);
    const firearm = sess.rifleId ? firearms.find(r=>r.id===sess.rifleId) : null;
    return <SessionDetail
      session={sess} target={tgt} firearm={firearm} sessions={sessions} ammo={ammo}
      match={sess.matchId ? matches.find(m=>m.id===sess.matchId) : null}
      onBack={()=>{ setScreen('home'); setActiveSess(null); }}
      onAddShot={sh=>{ const u=sessions.map(s=>s.id===sess.id?{...s,shots:[...(s.shots||[]),sh]}:s); saveSessions(u); mirrorShot(sess, tgt, sh); }}
      onDelShot={sid=>{ const u=sessions.map(s=>s.id===sess.id?{...s,shots:(s.shots||[]).filter(sh=>sh.id!==sid)}:s); saveSessions(u); }}
      onDelSess={()=>{ if (liveSess===sess.id) endLive(); saveSessions(sessions.filter(s=>s.id!==sess.id)); setScreen('home'); setActiveSess(null); }}
      core={core}
      live={liveSess === sess.id}
      hostName={relayName}
      onHostName={saveRelayName}
      onGoLive={name => goLive(sess, tgt, name)}
      onJoinLive={() => joinLive(sess, tgt)}
      onEndLive={endLive}
      onPublish={s => {
        const entry = leaderboardEntryFor(s, getTarget(s.targetId), s.lbId);
        if (!entry) return;
        // Mint the entry id ONCE and persist it, so republishing after editing
        // shots updates the same row instead of stacking duplicates.
        const lbId = s.lbId || core.uuid();
        core.publishEntry({ ...entry, id: lbId });
        if (!s.lbId) saveSessions(sessions.map(x => x.id === s.id ? { ...x, lbId } : x));
        core.sync({ trigger: 'publish' });
      }}
    />;
  }

  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="hdr">
          <div><div className="htitle">Zero</div><div className="hsub">Precision shooting log</div></div>
          {tab==='sessions' && (
            <div style={{display:'flex',gap:7}}>
              {core && <button className="badd" style={{background:'none',border:'1px solid var(--bdr)',color: showJoin ? 'var(--acc)' : 'var(--ink)'}} onClick={()=>setShowJoin(v=>!v)}>● join</button>}
              <button className="badd" style={{background:'none',border:'1px solid var(--bdr)',color:'var(--ink)'}} onClick={()=>setScreen('new_match')}>+ match</button>
              <button className="badd" onClick={()=>setScreen('new')}>+ session</button>
            </div>
          )}
        </div>
        <div className="content">
          {tab==='sessions' && (
            <>
              {showJoin && core && (
                <JoinLiveForm core={core}
                  note="Joining from here watches the relay. To shoot in it, open your own session and tap join there so your shots mirror."
                  onCancel={()=>setShowJoin(false)}
                  onJoined={()=>{ setShowJoin(false); setScreen('relay'); }}/>
              )}
              {liveSess && sessions.some(s=>s.id===liveSess) && (
                <div className="tcard" style={{padding:'9px 13px',borderColor:'var(--green)',cursor:'pointer'}}
                  onClick={()=>{ setActiveSess(liveSess); setScreen('detail'); }}>
                  <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--green)'}}>
                    ● live · {core?.relayInfo()?.code} — tap to return to the session
                  </div>
                </div>
              )}
              <SessionsList
                sessions={sessions}
                matches={matches}
                getTarget={getTarget}
                onOpenSession={id=>{ setActiveSess(id); setScreen('detail'); }}
                onAddToMatch={matchId=>setScreen('new')}
                onNewSessionInMatch={matchId=>{ setActiveSess(null); setScreen('new_in_match_'+matchId); }}
                onDelMatch={mid=>{ saveMatches(matches.filter(m=>m.id!==mid)); saveSessions(sessions.map(s=>s.matchId===mid?{...s,matchId:null}:s)); }}
              />
              <SyncPanel core={core} cfg={effCfg} onSaveCfg={saveSyncCfg}
                sessions={sessions} ammo={ammo} getTarget={getTarget}
                onSessionsUpdated={saveSessions} onAmmoUpdated={saveAmmo} />
              <div style={{margin:'20px 13px 8px',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,padding:'11px 13px'}}>
                <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.1em',textTransform:'uppercase',marginBottom:8}}>Data backup</div>
                <div style={{display:'flex',gap:8}}>
                  <button className="badd" style={{flex:1}} onClick={exportBackup}>⤓ Export</button>
                  <button className="badd" style={{flex:1,background:'none',border:'1px solid var(--bdr)',color:'var(--ink)'}} onClick={()=>importRef.current?.click()}>⤒ Restore</button>
                </div>
                <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',lineHeight:1.5,marginTop:8}}>
                  Export saves all sessions, firearms, targets &amp; matches to a JSON file. Restore replaces local data with a backup — export first to be safe. Data otherwise lives only in this browser.
                </div>
                {(() => {
                  // Nudge when the last export is stale: never exported with
                  // ≥5 sessions, ≥5 new sessions since, or >30 days old.
                  if (!sessions.length) return null;
                  const newSince = sessions.length - (backupMeta?.sessionsAtExport ?? 0);
                  const days = backupMeta?.lastExportTs ? (Date.now() - backupMeta.lastExportTs) / 86400000 : null;
                  const msg = !backupMeta
                    ? (sessions.length >= 5 ? `No backup exported yet — ${sessions.length} sessions are one storage eviction from gone.` : null)
                    : newSince >= 5 ? `${newSince} sessions logged since your last export.`
                    : days != null && days > 30 ? `Last export was ${Math.floor(days)} days ago.`
                    : null;
                  return msg ? (
                    <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--acc)',lineHeight:1.5,marginTop:6}}>⚠ {msg}</div>
                  ) : null;
                })()}
              </div>
              <input ref={importRef} type="file" accept="application/json,.json" style={{display:'none'}}
                onChange={e=>{ const file=e.target.files?.[0]; if(file) importBackup(file); e.target.value=''; }} />
            </>
          )}
          {tab==='analytics' && <><LeaderboardCard core={core} /><AnalyticsTab sessions={sessions} getTarget={getTarget} firearms={firearms} matches={matches} /></>}
          {tab==='dope' && <DopeTab sessions={sessions} firearms={firearms} getTarget={getTarget} />}
          {tab==='targets' && <TargetsTab customTargets={customTargets} onSave={saveCustomTargets} deletedBuiltins={deletedBuiltins} onDeleteBuiltin={id=>saveDeletedBuiltins([...deletedBuiltins,id])} onRestoreBuiltin={id=>saveDeletedBuiltins(deletedBuiltins.filter(d=>d!==id))} />}
          {tab==='firearms' && <FirearmsTab firearms={firearms} sessions={sessions} getTarget={getTarget} onSave={saveFirearms} ammo={ammo} onSaveAmmo={saveAmmo} core={core} />}
        </div>
        <div className="tabbar">
          {[['sessions','▤','Sessions'],['analytics','◰','Analytics'],['dope','▦','DOPE'],['firearms','⌖','Firearms'],['targets','◎','Targets']].map(([t,ico,lbl])=>(
            <button key={t} className={`tab ${tab===t?'on':''}`} onClick={()=>setTab(t)}>
              <span className="tabi">{ico}</span><span className="tabl">{lbl}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* ── Sessions list with match grouping ── */
function SessionsList({ sessions, matches, getTarget, onOpenSession, onDelMatch }) {
  const [collapsed, setCollapsed] = useState({});
  const [confirmDelMatch, setConfirmDelMatch] = useState(null);
  const [search, setSearch] = useState('');
  const [filterTarget, setFilterTarget] = useState('');
  const [filterPosition, setFilterPosition] = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Distinct values for filter dropdowns (most-recent first)
  const distinctLocations = (() => {
    const seen = new Set();
    const out = [];
    [...sessions].sort((a,b)=>(b.ts||0)-(a.ts||0)).forEach(s => {
      const v = (s.rangeLocation || '').trim();
      if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
    });
    return out;
  })();
  const distinctTargets = (() => {
    const seen = new Set();
    const out = [];
    sessions.forEach(s => {
      const t = getTarget(s.targetId);
      if (t && !seen.has(t.id)) { seen.add(t.id); out.push({id:t.id, name:t.name}); }
    });
    return out;
  })();
  const distinctPositions = (() => {
    const seen = new Set();
    const out = [];
    sessions.forEach(s => {
      const p = s.position;
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
    });
    return out;
  })();

  const activeFilterCount =
    (search ? 1 : 0) +
    (filterTarget ? 1 : 0) +
    (filterPosition ? 1 : 0) +
    (filterLocation ? 1 : 0);

  // Apply filters to sessions
  const matchesFilter = (s) => {
    if (filterTarget && s.targetId !== filterTarget) return false;
    if (filterPosition && s.position !== filterPosition) return false;
    if (filterLocation && (s.rangeLocation || '').toLowerCase() !== filterLocation.toLowerCase()) return false;
    if (search) {
      const q = search.toLowerCase();
      const tgt = getTarget(s.targetId);
      const hay = [
        s.name,
        s.date,
        s.type,
        s.position,
        s.rangeLocation,
        tgt?.name,
        s.ammoDesc,
        s.ammoLot,
        s.equipment,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  const filteredSessions = sessions.filter(matchesFilter);

  if (sessions.length === 0 && matches.length === 0) {
    return <div className="empty"><div className="et">No sessions yet</div><div className="es">Tap + session to start logging.</div></div>;
  }

  // Build ordered list of items: matches (with their sessions) and standalone sessions
  // Ordered by most recent date (match date = earliest sub-session date or match.date)
  // A match is shown only if at least one of its sub-sessions passes the filter.
  const matchItems = matches.map(m => {
    const subs = filteredSessions.filter(s=>s.matchId===m.id).sort((a,b)=>a.ts-b.ts);
    const refDate = subs.length ? subs[0].date : m.date;
    return { type:'match', match:m, subs, date:refDate, ts: subs.length ? subs[0].ts : 0 };
  }).filter(mi => mi.subs.length > 0);
  const standaloneItems = filteredSessions
    .filter(s=>!s.matchId)
    .map(s=>({ type:'session', session:s, date:s.date, ts:s.ts }));

  const items = [...matchItems, ...standaloneItems].sort((a,b)=>b.ts-a.ts);

  return (
    <div>
      {/* Search + filter bar */}
      <div style={{padding:'10px 13px 4px',display:'flex',flexDirection:'column',gap:6}}>
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          <input
            value={search}
            onChange={e=>setSearch(e.target.value)}
            placeholder="Search sessions, locations, ammo..."
            style={{
              flex:1,
              padding:'8px 11px',
              background:'var(--surf2)',
              border:'1.5px solid var(--bdr)',
              borderRadius:5,
              fontFamily:'var(--fm)',fontSize:11,color:'var(--ink)',
              outline:'none',
            }}/>
          <button onClick={()=>setFiltersOpen(v=>!v)}
            style={{
              padding:'8px 11px',
              borderRadius:5,
              border:`1.5px solid ${activeFilterCount > 0 ? 'var(--acc)' : 'var(--bdr)'}`,
              background: activeFilterCount > 0 ? '#e8943a22' : 'var(--surf2)',
              color: activeFilterCount > 0 ? 'var(--acc)' : 'var(--dim)',
              fontFamily:'var(--fm)',fontSize:10,fontWeight:700,
              cursor:'pointer',whiteSpace:'nowrap',
            }}>
            {filtersOpen ? '− filters' : `+ filters${activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}`}
          </button>
          {activeFilterCount > 0 && (
            <button onClick={()=>{setSearch('');setFilterTarget('');setFilterPosition('');setFilterLocation('');}}
              style={{
                padding:'8px 9px',
                borderRadius:5,border:'1.5px solid var(--bdr)',
                background:'var(--surf2)',color:'var(--dim)',
                fontFamily:'var(--fm)',fontSize:10,cursor:'pointer',
              }}>×</button>
          )}
        </div>
        {filtersOpen && (
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginTop:2}}>
            <div>
              <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',letterSpacing:'.08em',textTransform:'uppercase',marginBottom:3}}>Location</div>
              <select value={filterLocation} onChange={e=>setFilterLocation(e.target.value)}
                style={{
                  width:'100%',padding:'7px 9px',
                  background:'var(--surf2)',border:'1.5px solid var(--bdr)',borderRadius:5,
                  fontFamily:'var(--fm)',fontSize:10,color:'var(--ink)',outline:'none',
                }}>
                <option value="">all locations</option>
                {distinctLocations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
              </select>
            </div>
            <div>
              <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',letterSpacing:'.08em',textTransform:'uppercase',marginBottom:3}}>Target</div>
              <select value={filterTarget} onChange={e=>setFilterTarget(e.target.value)}
                style={{
                  width:'100%',padding:'7px 9px',
                  background:'var(--surf2)',border:'1.5px solid var(--bdr)',borderRadius:5,
                  fontFamily:'var(--fm)',fontSize:10,color:'var(--ink)',outline:'none',
                }}>
                <option value="">all targets</option>
                {distinctTargets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div style={{gridColumn:'1 / -1'}}>
              <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',letterSpacing:'.08em',textTransform:'uppercase',marginBottom:3}}>Position</div>
              <select value={filterPosition} onChange={e=>setFilterPosition(e.target.value)}
                style={{
                  width:'100%',padding:'7px 9px',
                  background:'var(--surf2)',border:'1.5px solid var(--bdr)',borderRadius:5,
                  fontFamily:'var(--fm)',fontSize:10,color:'var(--ink)',outline:'none',
                }}>
                <option value="">all positions</option>
                {distinctPositions.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
        )}
        {activeFilterCount > 0 && (
          <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',padding:'2px 2px'}}>
            Showing {filteredSessions.length} of {sessions.length} sessions
          </div>
        )}
      </div>

      <div className="shdr">Recent</div>
      {items.length === 0 && (
        <div className="empty">
          <div className="et">No matches</div>
          <div className="es">No sessions match the current filters.</div>
        </div>
      )}
      {items.map(item => {
        if (item.type === 'session') {
          const s = item.session;
          const tgt = getTarget(s.targetId);
          const a = analytics(s.shots||[], tgt, s.rangeYards);
          return (
            <div className="card" key={s.id} onClick={()=>onOpenSession(s.id)}>
              <div className="ctop">
                <div>
                  <div className="cname">{s.name||`${tgt.name} · ${s.rangeYards}yd`}</div>
                  <div className="cmeta">{s.date} · {s.type} · {(s.shots||[]).length} shots{s.rangeLocation ? ` · ${s.rangeLocation}` : ''}{s.wSpeed ? ` · ${s.wSpeed}mph @ ${s.wDir}` : ''}</div>
                </div>
              </div>
              <div className="cbody">
                {a && a.n >= 2 ? <>
                  <div><div className="sv">{a.esMoa.toFixed(2)}</div><div className="sl">ES MOA</div></div>
                  <div><div className="sv">{a.mrMoa.toFixed(2)}</div><div className="sl">MR MOA</div></div>
                  <div><div className="sv">{a.score}–{a.xs}X</div><div className="sl">Score</div></div>
                </> : a && a.score > 0 ? <>
                  <div><div className="sv">{a.score}–{a.xs}X</div><div className="sl">Score</div></div>
                  <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)'}}>need 2+ record shots for group stats</div>
                </> : <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)'}}>no shots logged</div>}
              </div>
            </div>
          );
        }

        // Match group
        const { match, subs } = item;
        const isCollapsed = collapsed[match.id] !== false; // default collapsed
        const totalScore = subs.reduce((acc,s)=>{
          const tgt=getTarget(s.targetId);
          const a=analytics(s.shots||[],tgt,s.rangeYards);
          return acc+(a?a.score:0);
        },0);
        const totalXs = subs.reduce((acc,s)=>{
          const tgt=getTarget(s.targetId);
          const a=analytics(s.shots||[],tgt,s.rangeYards);
          return acc+(a?a.xs:0);
        },0);
        const totalShots = subs.reduce((acc,s)=>acc+(s.shots||[]).length,0);
        // Percentage over RECORD shots (sighters don't score); band label uses
        // the conventional-HP table. Informal — see ClassificationCard caveat.
        const recordShots = subs.reduce((acc,s)=>acc+(s.shots||[]).filter(sh=>!sh.isSighter).length,0);
        const matchPct = recordShots > 0 ? (totalScore/(recordShots*10))*100 : null;

        return (
          <div className="mcard" key={match.id}>
            {/* Match header */}
            <div className="mhdr" onClick={()=>setCollapsed(c=>({...c,[match.id]: c[match.id]===false ? true : false}))}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:'flex',alignItems:'center',gap:7}}>
                  <div className="mtitle">{match.name||match.type}</div>
                  <span style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--acc)',background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:3,padding:'1px 5px'}}>{match.type}</span>
                </div>
                <div className="mmeta">{match.date} · {subs.length} stage{subs.length!==1?'s':''} · {totalShots} shots</div>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
                {totalScore > 0 && (
                  <div style={{textAlign:'right'}}>
                    <div style={{fontFamily:'var(--fm)',fontSize:14,color:'var(--acc)',fontWeight:700}}>{totalScore}–{totalXs}X</div>
                    {matchPct != null && (
                      <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>
                        {matchPct.toFixed(1)}% · {classifyPct(matchPct).name}
                      </div>
                    )}
                  </div>
                )}
                <div style={{color:'var(--dim)',fontSize:11,userSelect:'none'}}>{isCollapsed?'▼':'▲'}</div>
              </div>
            </div>

            {/* Expanded sub-sessions with bracket */}
            {!isCollapsed && (
              <div className="msubs">
                {subs.map((s, i) => {
                  const tgt = getTarget(s.targetId);
                  const a = analytics(s.shots||[], tgt, s.rangeYards);
                  const isFirst = i === 0;
                  const isLast = i === subs.length - 1;
                  const isOnly = subs.length === 1;
                  return (
                    <div key={s.id} className="msub" onClick={()=>onOpenSession(s.id)}>
                      {/* Left bracket */}
                      <div className="mbrack" style={{height:'100%'}}>
                        <svg width="24" height="100%" viewBox="0 0 24 48" preserveAspectRatio="none" style={{width:24,display:'block',minHeight:44}}>
                          {/* Vertical line */}
                          {!isOnly && (
                            <line
                              x1="16" y1={isFirst ? 24 : 0}
                              x2="16" y2={isLast ? 24 : 48}
                              stroke="var(--bdr)" strokeWidth="1.5" strokeLinecap="round"
                            />
                          )}
                          {/* Horizontal arm */}
                          <line x1="16" y1="24" x2="24" y2="24" stroke="var(--acc)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
                        </svg>
                      </div>
                      {/* Content */}
                      <div className="msub-body">
                        <div className="msub-name">{s.name||`${tgt.name} · ${s.rangeYards}yd`}</div>
                        <div className="msub-meta">{s.type} · {(s.shots||[]).length} shots</div>
                        {a && a.n >= 2 && (
                          <div className="msub-stats">
                            <div><div className="msub-sv">{a.esMoa.toFixed(2)}</div><div className="msub-sl">ES MOA</div></div>
                            <div><div className="msub-sv">{a.score}–{a.xs}X</div><div className="msub-sl">Score</div></div>
                          </div>
                        )}
                        {a && a.n < 2 && a.score > 0 && (
                          <div className="msub-stats">
                            <div><div className="msub-sv">{a.score}–{a.xs}X</div><div className="msub-sl">Score</div></div>
                          </div>
                        )}
                      </div>
                      <div style={{color:'var(--dim)',fontSize:11,paddingRight:13,flexShrink:0}}>›</div>
                    </div>
                  );
                })}
                {subs.length === 0 && (
                  <div style={{padding:'10px 13px',fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)'}}>No stages yet</div>
                )}
                {/* Delete match option */}
                <div style={{display:'flex',justifyContent:'flex-end',padding:'4px 13px 8px',gap:8,alignItems:'center'}}>
                  {confirmDelMatch === match.id ? (
                    <>
                      <span style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>Detach sessions?</span>
                      <button style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--red)',background:'none',border:'1px solid var(--red)',borderRadius:4,padding:'3px 9px',cursor:'pointer'}}
                        onClick={e=>{e.stopPropagation();onDelMatch(match.id);setConfirmDelMatch(null);}}>yes, remove</button>
                      <button style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',background:'none',border:'1px solid var(--bdr)',borderRadius:4,padding:'3px 9px',cursor:'pointer'}}
                        onClick={e=>{e.stopPropagation();setConfirmDelMatch(null);}}>cancel</button>
                    </>
                  ) : (
                    <button className="bdel" style={{fontSize:9}} onClick={e=>{e.stopPropagation();setConfirmDelMatch(match.id);}}>remove match</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NewSession({ targets, matches, firearms, sessions, ammo, onBack, onSave }) {
  const today = new Date().toISOString().slice(0,10);
  // Distinct prior locations, most-recent first, for the datalist autocomplete
  const priorLocations = (() => {
    if (!sessions) return [];
    const seen = new Set();
    const out = [];
    [...sessions].sort((a,b)=>(b.ts||0)-(a.ts||0)).forEach(s => {
      const loc = (s.rangeLocation || '').trim();
      if (loc && !seen.has(loc.toLowerCase())) {
        seen.add(loc.toLowerCase());
        out.push(loc);
      }
    });
    return out;
  })();
  const [f,setF] = useState({name:'',date:today,type:'Score',position:'',fireMode:'',targetId:targets[0]?.id||BUILTIN_TARGETS[0].id,rangeYards:200,rangeLocation:'',rifleId:(firearms&&firearms[0]?.id)||'',ammoId:'',wSpeed:'',wDir:6,temp:'',lighting:'Clear',ammoLot:'',ammoDesc:'',equipment:''});
  const [matchMode, setMatchMode] = useState('none');
  const [selectedMatchId, setSelectedMatchId] = useState(matches[0]?.id||'');
  const [newMatchName, setNewMatchName] = useState('');
  const [newMatchType, setNewMatchType] = useState('Match');
  const [windDragging, setWindDragging] = useState(false);
  const [showExtra, setShowExtra] = useState(false);
  const windFaceRef = useRef(null);
  const set = (k,v) => setF(p=>({...p,[k]:v}));

  function windAngleFromEvent(e, el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    let deg = Math.atan2(clientX-cx, -(clientY-cy)) * 180/Math.PI;
    if (deg<0) deg+=360;
    const h = Math.round(deg/30) % 12 || 12;
    return h;
  }

  function handleSave() {
    if (!f.rangeYards) return;
    let matchId = null, newMatch = null;
    if (matchMode==='existing' && selectedMatchId) { matchId = selectedMatchId; }
    else if (matchMode==='new') {
      newMatch = {id:uid(), name:newMatchName.trim(), type:newMatchType, date:f.date, ts:Date.now()};
      matchId = newMatch.id;
    }
    onSave({...f, id:uid(), shots:[], matchId, ts:Date.now()}, newMatch);
  }

  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="hdr">
          <button className="bback" onClick={onBack}>← back</button>
          <div style={{fontFamily:'var(--fh)',fontSize:15,fontWeight:700}}>New session</div>
          <div style={{width:48}} />
        </div>
        <div className="content">
          <div className="form">
            <div className="field"><div className="lbl">Name (optional)</div>
              <input className="inp" value={f.name} onChange={e=>set('name',e.target.value)} placeholder="e.g. 200yd prone slow fire" /></div>
            <div className="row2">
              <div className="field"><div className="lbl">Date</div>
                <input className="inp" type="date" value={f.date} onChange={e=>set('date',e.target.value)} /></div>
              <div className="field"><div className="lbl">Type</div>
                <select className="inp" value={f.type} onChange={e=>set('type',e.target.value)}>
                  <option value="Score">Score</option>
                  <option value="Sight adjustment">Sight adjustment</option>
                </select></div>
            </div>
            <div className="row2">
              <div className="field"><div className="lbl">Position</div>
                <select className="inp" value={f.position} onChange={e=>set('position',e.target.value)}>
                  <option value="">— unspecified —</option>
                  <optgroup label="Rifle">
                    <option value="Prone">Prone</option>
                    <option value="Sitting">Sitting</option>
                    <option value="Kneeling">Kneeling</option>
                    <option value="Standing">Standing / Offhand</option>
                  </optgroup>
                  <optgroup label="Pistol">
                    <option value="Two-hand">Two-hand / Freestyle</option>
                    <option value="Strong-hand">Strong-hand only</option>
                    <option value="Weak-hand">Weak-hand only</option>
                  </optgroup>
                  <optgroup label="Other">
                    <option value="Bench">Bench / Rested</option>
                    <option value="Unsupported">Unsupported</option>
                  </optgroup>
                </select></div>
              <div className="field"><div className="lbl">Fire mode</div>
                <select className="inp" value={f.fireMode} onChange={e=>set('fireMode',e.target.value)}>
                  <option value="">— unspecified —</option>
                  <option value="Slow">Slow fire</option>
                  <option value="Rapid">Rapid fire</option>
                </select></div>
            </div>
            <div className="row2">
              <div className="field"><div className="lbl">Target</div>
                <select className="inp" value={f.targetId} onChange={e=>set('targetId',e.target.value)}>
                  {targets.map(t=><option key={t.id} value={t.id}>{t.name} — {t.desc}</option>)}
                </select></div>
              <div className="field"><div className="lbl">Range (yd)</div>
                <input className="inp" type="number" value={f.rangeYards} onChange={e=>set('rangeYards',+e.target.value||0)} /></div>
            </div>

            <div className="field"><div className="lbl">Range location</div>
              <input className="inp" list="prior-locations" value={f.rangeLocation}
                onChange={e=>set('rangeLocation', e.target.value)}
                placeholder="e.g. Ben Avery, Camp Perry, Phoenix Rod & Gun"/>
              {priorLocations.length > 0 && (
                <datalist id="prior-locations">
                  {priorLocations.map(loc => <option key={loc} value={loc}/>)}
                </datalist>
              )}
            </div>

            {/* Firearm picker */}
            <div className="field"><div className="lbl">Firearm</div>
              {firearms && firearms.length > 0 ? (
                <select className="inp" value={f.rifleId} onChange={e=>{
                  const rid = e.target.value;
                  setF(p=>{
                    const load = p.ammoId && ammo ? ammo.find(a=>a.id===p.ammoId) : null;
                    const keep = load && (!load.rifleId || load.rifleId === rid);
                    return { ...p, rifleId: rid, ammoId: keep ? p.ammoId : '' };
                  });
                }}>
                  <option value="">— none selected —</option>
                  {firearms.map(r=>(
                    <option key={r.id} value={r.id}>{r.name}{r.caliber?` · ${r.caliber}`:''}</option>
                  ))}
                </select>
              ) : (
                <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)',padding:'9px 11px',background:'var(--surf2)',border:'1px dashed var(--bdr)',borderRadius:5}}>
                  No firearms added yet. Add one from the Firearms tab to track round count and group trends per firearm.
                </div>
              )}
            </div>

            {/* Ammo load picker — loads tied to the selected firearm plus
                any-firearm loads. Selecting mirrors the load name into
                ammoDesc so DOPE cells and session chips (which read the
                legacy free-text fields) display it without schema changes;
                the ammoId is what analytics aggregation keys on. */}
            {ammo && ammo.length > 0 && (() => {
              const avail = ammo.filter(a => !a.rifleId || a.rifleId === f.rifleId);
              if (!avail.length) return null;
              // Ammunition Bench has quarantined is not something to start a
              // new session on. It stays listed and stays attached to sessions
              // already shot -- quarantining after the fact is exactly how you
              // find out a batch was bad, and hiding it destroys the evidence.
              const picked = ammo.find(a => a.id === f.ammoId);
              const warns = picked ? batchWarnings(picked) : [];
              return (
                <div className="field"><div className="lbl">Ammo load</div>
                  <select className="inp" value={f.ammoId||''} onChange={e=>{
                    const id = e.target.value;
                    const load = ammo.find(a=>a.id===id);
                    if (load && batchBlocked(load)) return;      // belt and braces
                    setF(p=>({ ...p, ammoId: id, ammoDesc: load ? load.name : p.ammoDesc }));
                  }}>
                    <option value="">— none / entered manually —</option>
                    {avail.map(a=>(
                      <option key={a.id} value={a.id} disabled={batchBlocked(a)}>
                        {batchBlocked(a) ? '⛔ ' : ''}{a.name}
                        {a.charge?` · ${a.charge}gr${a.powder?' '+a.powder:''}`:''}
                        {batchBlocked(a) ? ' — quarantined' : ''}</option>
                    ))}
                  </select>
                  {warns.map((w, i) => (
                    <div key={i} style={{fontFamily:'var(--fm)',fontSize:8.5,marginTop:5,
                      color: w.kind === 'stop' ? 'var(--red)' : 'var(--acc)'}}>
                      {w.kind === 'stop' ? '■ ' : '▲ '}{w.text}
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Match grouping */}
            <div style={{background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:7,padding:'11px 12px',display:'flex',flexDirection:'column',gap:9}}>
              <div className="lbl">Group into match</div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {[['none','Standalone'],['existing','Add to existing'],['new','Create new match']].map(([v,lbl])=>(
                  <button key={v} onClick={()=>setMatchMode(v)} style={{
                    padding:'5px 10px',borderRadius:5,border:'1.5px solid',cursor:'pointer',
                    fontFamily:'var(--fm)',fontSize:10,
                    borderColor:matchMode===v?'var(--acc)':'var(--bdr)',
                    background:matchMode===v?'var(--surf)':'transparent',
                    color:matchMode===v?'var(--acc)':'var(--dim)',
                  }}>{lbl}</button>
                ))}
              </div>
              {matchMode==='existing' && (matches.length===0
                ? <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)'}}>No matches yet — use "Create new match".</div>
                : <select className="inp" value={selectedMatchId} onChange={e=>setSelectedMatchId(e.target.value)}>
                    {matches.map(m=><option key={m.id} value={m.id}>{m.name||m.type} · {m.date}</option>)}
                  </select>
              )}
              {matchMode==='new' && (
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  <input className="inp" value={newMatchName} onChange={e=>setNewMatchName(e.target.value)} placeholder="Match name (e.g. CMP ATC)" style={{fontSize:12}}/>
                  <select className="inp" value={newMatchType} onChange={e=>setNewMatchType(e.target.value)}>
                    {['Match','Practice','Qualification','EIC','CMP','NMC','Across the Course'].map(t=><option key={t}>{t}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div className="shdr" style={{padding:'2px 0 0',fontSize:9}}>Conditions</div>
            {/* Wind speed + clock direction */}
            <div style={{display:'flex',gap:9,alignItems:'flex-start'}}>
              <div className="field" style={{flex:1}}>
                <div className="lbl">Wind (mph)</div>
                <input className="inp" type="number" value={f.wSpeed} onChange={e=>set('wSpeed',e.target.value)} placeholder="0" />
              </div>
              <div className="field" style={{flex:1}}>
                <div className="lbl">Direction (clock)</div>
                {/* Compact clock face */}
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  {(() => {
                    const WFACE=60, wc=WFACE/2;
                    const wAngle = (f.wDir%12)*30;
                    const ticks = Array.from({length:12},(_,i)=>i*30);
                    return (
                      <div
                        ref={windFaceRef}
                        style={{
                          width:WFACE,height:WFACE,borderRadius:'50%',border:'1.5px solid var(--bdr)',
                          background:'var(--surf2)',position:'relative',flexShrink:0,cursor:'crosshair',
                          touchAction:'none',userSelect:'none',
                          boxShadow: windDragging?'0 0 0 2px var(--acc)':'none',
                        }}
                        onMouseDown={e=>{e.preventDefault();setWindDragging(true);set('wDir',windAngleFromEvent(e,windFaceRef.current));}}
                        onMouseMove={e=>{if(!windDragging)return;e.preventDefault();set('wDir',windAngleFromEvent(e,windFaceRef.current));}}
                        onMouseUp={()=>setWindDragging(false)} onMouseLeave={()=>setWindDragging(false)}
                        onTouchStart={e=>{e.preventDefault();setWindDragging(true);set('wDir',windAngleFromEvent(e,windFaceRef.current));}}
                        onTouchMove={e=>{if(!windDragging)return;e.preventDefault();set('wDir',windAngleFromEvent(e,windFaceRef.current));}}
                        onTouchEnd={()=>setWindDragging(false)}
                      >
                        <svg width={WFACE} height={WFACE} style={{position:'absolute',inset:0,pointerEvents:'none'}}>
                          {ticks.map(deg=>{
                            const r1=wc-4, r2=wc-2;
                            const rad=(deg-90)*Math.PI/180;
                            return <line key={deg}
                              x1={wc+r1*Math.cos(rad)} y1={wc+r1*Math.sin(rad)}
                              x2={wc+r2*Math.cos(rad)} y2={wc+r2*Math.sin(rad)}
                              stroke={deg%90===0?'var(--ink)':'var(--bdr)'} strokeWidth={deg%90===0?1.2:0.7}/>;
                          })}
                          {/* Hand */}
                          <line
                            x1={wc} y1={wc}
                            x2={wc + (wc-7)*Math.sin(wAngle*Math.PI/180)}
                            y2={wc - (wc-7)*Math.cos(wAngle*Math.PI/180)}
                            stroke="var(--acc)" strokeWidth={1.5} strokeLinecap="round"/>
                          <circle cx={wc} cy={wc} r={2} fill="var(--acc)"/>
                          {/* 12 marker */}
                          <text x={wc} y={7} textAnchor="middle" fill="var(--dim)" fontSize={5} fontFamily="Space Mono,monospace">12</text>
                        </svg>
                      </div>
                    );
                  })()}
                  <div>
                    <div style={{fontFamily:'var(--fm)',fontSize:15,fontWeight:700,color:'var(--acc)'}}>{f.wDir}</div>
                    <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',marginTop:1}}>o'clock</div>
                    {/* Fine adjustment */}
                    <div style={{display:'flex',gap:3,marginTop:4}}>
                      {[12,3,6,9].map(h=>(
                        <button key={h} onClick={()=>set('wDir',h)} style={{
                          width:20,height:18,border:'1px solid var(--bdr)',borderRadius:3,
                          background:f.wDir===h?'var(--ink)':'var(--surf2)',
                          color:f.wDir===h?'var(--bg)':'var(--dim)',
                          fontFamily:'var(--fm)',fontSize:8,cursor:'pointer',padding:0,
                        }}>{h}</button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="row2">
              <div className="field"><div className="lbl">Temp (°F)</div>
                <input className="inp" type="number" value={f.temp} onChange={e=>set('temp',e.target.value)} placeholder="70" /></div>
              <div className="field"><div className="lbl">Lighting</div>
                <select className="inp" value={f.lighting} onChange={e=>set('lighting',e.target.value)}>
                  {['Clear','Overcast','Bright sun','Low light','Mixed'].map(d=><option key={d} value={d}>{d}</option>)}
                </select></div>
            </div>
            {/* Ammo + equipment — collapsed by default */}
            <button onClick={()=>setShowExtra(v=>!v)} style={{background:'none',border:'1px dashed var(--bdr)',borderRadius:5,padding:'7px 11px',fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)',cursor:'pointer',textAlign:'left',display:'flex',justifyContent:'space-between'}}>
              <span>Ammo &amp; equipment</span>
              <span>{showExtra?'▲':'▼'}</span>
            </button>
            {showExtra && (
              <div style={{display:'flex',flexDirection:'column',gap:9,marginTop:-4}}>
                <div className="row2">
                  <div className="field">
                    <div className="lbl">Ammo lot #</div>
                    <input className="inp" value={f.ammoLot} onChange={e=>set('ammoLot',e.target.value)} placeholder="e.g. LC21-001" style={{fontSize:12}}/>
                  </div>
                  <div className="field">
                    <div className="lbl">Ammo description</div>
                    <input className="inp" value={f.ammoDesc} onChange={e=>set('ammoDesc',e.target.value)} placeholder="e.g. 77gr SMK" style={{fontSize:12}}/>
                  </div>
                </div>
                <div className="field">
                  <div className="lbl">Equipment / firearm notes</div>
                  <input className="inp" value={f.equipment} onChange={e=>set('equipment',e.target.value)} placeholder="e.g. Rock River NM, 20in Krieger, NF 8-32" style={{fontSize:12}}/>
                </div>
              </div>
            )}
            <button className="bprim" onClick={handleSave}>Create session</button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Export / share ── */
function buildExportText(session, target, a, firearm, wa) {
  const lines = [];
  const name = session.name || `${target.name} · ${session.rangeYards}yd`;
  lines.push(`Zero — ${name}`);
  lines.push(`${session.date} · ${session.type} · ${target.name} @ ${session.rangeYards}yd`);
  if (session.rangeLocation) lines.push(`Location: ${session.rangeLocation}`);
  if (session.position) lines.push(`Position: ${session.position}`);
  if (session.fireMode && session.fireMode !== 'Slow') lines.push(`Fire mode: ${session.fireMode}`);
  if (session.fireMode) lines.push(`Fire mode: ${session.fireMode} fire`);
  if (firearm) lines.push(`Firearm: ${firearm.name}${firearm.caliber?` · ${firearm.caliber}`:''}`);
  if (session.wSpeed) lines.push(`Wind: ${session.wSpeed}mph · ${session.wDir} o'clock`);
  if (session.temp) lines.push(`Temp: ${session.temp}°F · ${session.lighting||''}`);
  if (session.ammoDesc||session.ammoLot) lines.push(`Ammo: ${[session.ammoDesc,session.ammoLot&&`lot ${session.ammoLot}`].filter(Boolean).join(' · ')}`);
  if (session.equipment) lines.push(`Equipment: ${session.equipment}`);
  lines.push('');

  if (a && a.esMoa > 0) {
    lines.push(`Score:  ${a.score}–${a.xs}X  (${a.n} record shots)`);
    lines.push(`ES:     ${a.esMoa.toFixed(2)} MOA  (${a.esIn.toFixed(3)}")`);
    lines.push(`MR:     ${a.mrMoa.toFixed(2)} MOA  (${a.mrIn.toFixed(3)}")`);
    lines.push('');
  }

  if (wa && wa.n >= 1) {
    lines.push(`Wind call: ${wa.n} calls · ${wa.absMeanErr.toFixed(2)} MOA avg error · bias ${wa.biasDir==='neutral'?'neutral':wa.biasDir+' '+Math.abs(wa.meanErr).toFixed(2)+' MOA'}`);
    lines.push('');
  }

  const shots = session.shots || [];
  const recordShots = shots.filter(s=>!s.isSighter);
  const sighters = shots.filter(s=>s.isSighter);

  if (sighters.length) {
    lines.push(`Sighters (${sighters.length}):`);
    let sc = 0;
    shots.forEach(sh => {
      if (!sh.isSighter) return;
      sc++;
      const lbl = String.fromCharCode(64 + sc);
      const wcTag = typeof sh.windCallMoa === 'number' ? ` wc:${sh.windCallMoa}${sh.windCallDir}` : '';
      const psw = typeof sh.perShotWind === 'number' ? ` ${sh.perShotWind}mph${sh.perShotWindDir?'@'+sh.perShotWindDir:''}` : '';
      const cer = (sh.callXY && sh.xy) ? ` Δ${Math.hypot(sh.xy.x-sh.callXY.x, sh.xy.y-sh.callXY.y).toFixed(2)}"` : '';
      lines.push(`   ${lbl}  ${sh.ring}  ${sh.clockH}:${String(sh.clockM).padStart(2,'0')}  E${fmtMoaSigned(sh.elev)} W${fmtMoaSigned(sh.wind)} MOA${psw}${wcTag}${cer}${sh.notes?' — '+sh.notes:''}`);
    });
    lines.push('');
  }

  lines.push(`Record shots (${recordShots.length}):`);
  let ri = 0;
  shots.forEach(sh => {
    if (sh.isSighter) return;
    ri++;
    const wcTag = typeof sh.windCallMoa === 'number' ? ` wc:${sh.windCallMoa}${sh.windCallDir}` : '';
    const psw = typeof sh.perShotWind === 'number' ? ` ${sh.perShotWind}mph${sh.perShotWindDir?'@'+sh.perShotWindDir:''}` : '';
    const cer = (sh.callXY && sh.xy) ? ` Δ${Math.hypot(sh.xy.x-sh.callXY.x, sh.xy.y-sh.callXY.y).toFixed(2)}"` : '';
    lines.push(`  ${String(ri).padStart(2)}  ${sh.ring.padStart(2)}  ${sh.clockH}:${String(sh.clockM).padStart(2,'0')}  E${fmtMoaSigned(sh.elev)} W${fmtMoaSigned(sh.wind)} MOA${psw}${wcTag}${cer}${sh.notes?' — '+sh.notes:''}`);
  });

  return lines.join('\n');
}

/* ── Call vs actual chart: shows distance from called point to actual impact, per shot.
 * A useful diagnostic for follow-through quality. Tight bars = good follow-through;
 * tall bars trending in one direction = consistent flinch/jerk in that direction.
 */
function CallErrorChart({ shots, target, yards }) {
  const calledShots = (shots||[]).filter(s => !s.isSighter && s.callXY && s.xy);
  if (calledShots.length === 0) return null;

  const W=330, H=140, PL=32, PR=10, PT=10, PB=28;
  const pw = W-PL-PR, ph = H-PT-PB;

  // Per-shot signed deviation: shot X minus call X (horizontal component)
  // and shot Y minus call Y (vertical component). Distance = magnitude.
  const items = calledShots.map((sh, i) => {
    const dx = sh.xy.x - sh.callXY.x;
    const dy = sh.xy.y - sh.callXY.y;
    const distIn = Math.hypot(dx, dy);
    return { sh, idx: i, dx, dy, distIn, distMoa: inchesToMoa(distIn, yards) };
  });

  const maxDist = Math.max(...items.map(i => i.distIn)) * 1.15 || 0.5;
  const meanDist = items.reduce((s,i) => s + i.distIn, 0) / items.length;
  const meanDistMoa = inchesToMoa(meanDist, yards);
  // Mean signed dx/dy — shows directional bias of the trigger error
  const meanDx = items.reduce((s,i) => s+i.dx, 0)/items.length;
  const meanDy = items.reduce((s,i) => s+i.dy, 0)/items.length;
  const meanDirDeg = Math.atan2(meanDx, meanDy) * 180/Math.PI;
  // Convert dominant direction to coarse description
  const dirText = (() => {
    const mag = Math.hypot(meanDx, meanDy);
    if (mag < 0.05) return 'neutral';
    const a = ((meanDirDeg % 360) + 360) % 360; // 0..360, 0 = up
    if (a < 22.5 || a >= 337.5) return 'high';
    if (a < 67.5)  return 'high-right';
    if (a < 112.5) return 'right';
    if (a < 157.5) return 'low-right';
    if (a < 202.5) return 'low';
    if (a < 247.5) return 'low-left';
    if (a < 292.5) return 'left';
    return 'high-left';
  })();

  const barW = pw / items.length;
  const gx = i => PL + i * barW + barW/2;
  const gy = v => PT + (1 - v/maxDist) * ph;

  return (
    <>
      <div className="shdr">Call vs impact · {items.length} called shot{items.length===1?'':'s'}</div>
      <div style={{margin:'0 13px 8px',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,padding:'11px 13px'}}>

        <div style={{display:'flex',gap:14,marginBottom:8}}>
          <div style={{flex:1}}>
            <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--acc)',fontWeight:700}}>{meanDist.toFixed(2)}" / {meanDistMoa.toFixed(2)} MOA</div>
            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',letterSpacing:'.08em'}}>mean call error</div>
          </div>
          <div style={{flex:1}}>
            <div style={{fontFamily:'var(--fm)',fontSize:10,color: dirText==='neutral'?'var(--green)':'var(--red)',fontWeight:700}}>
              {dirText}
            </div>
            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',letterSpacing:'.08em'}}>error direction</div>
          </div>
        </div>

        <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',display:'block'}}>
          {/* Y gridlines */}
          {[0, 0.5, 1].map(f=>{
            const y = gy(f * maxDist);
            return (
              <g key={f}>
                <line x1={PL} y1={y} x2={W-PR} y2={y} stroke="#ffffff10" strokeWidth={1}/>
                <text x={PL-3} y={y+3} textAnchor="end" fill="var(--dim)" fontSize={7} fontFamily="Space Mono,monospace">{(f*maxDist).toFixed(2)}"</text>
              </g>
            );
          })}

          {/* Bars — colored by magnitude (green tight, red wide) */}
          {items.map(it => {
            const x = gx(it.idx);
            const y = gy(it.distIn);
            const heightPx = (H-PB) - y;
            const fracOfMean = it.distIn / Math.max(meanDist, 0.001);
            const color = fracOfMean < 0.7 ? 'var(--green)' : fracOfMean < 1.3 ? 'var(--acc)' : 'var(--red)';
            return (
              <g key={it.idx}>
                <rect x={x - barW*0.32} y={y} width={barW*0.64} height={heightPx} fill={color} opacity={0.85}/>
              </g>
            );
          })}

          {/* Mean reference line */}
          <line x1={PL} y1={gy(meanDist)} x2={W-PR} y2={gy(meanDist)} stroke="var(--acc)" strokeWidth={0.8} strokeDasharray="3 2" opacity={0.5}/>

          {/* X-axis shot labels */}
          {items.map(it => (
            <text key={it.idx} x={gx(it.idx)} y={H-4} textAnchor="middle" fill="var(--dim)" fontSize={7} fontFamily="Space Mono,monospace">
              {shotLabel(shots, shots.indexOf(it.sh))}
            </text>
          ))}
        </svg>

        <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',lineHeight:1.5,marginTop:6}}>
          {dirText === 'neutral'
            ? 'Your follow-through is balanced. Calls and impacts agree in direction.'
            : `Your shots break ${dirText} of where you called them on average — typical of ${
                dirText.includes('low') ? 'flinching/anticipating recoil' :
                dirText.includes('left') ? 'trigger jerk (right-handed shooter)' :
                dirText.includes('right') ? 'trigger jerk (left-handed shooter) or pushing' :
                'follow-through inconsistency'
              }.`}
        </div>
      </div>
    </>
  );
}

/* ── Per-shot inspector: SVG showing hold trace, call point, and impact for one shot.
 * Used inline in SessionDetail when a shot is expanded.
 */
function ShotInspector({ shot, target }) {
  const SZ = 220;
  const c = SZ / 2;

  // Determine view radius from this shot's points (tap mode or derived)
  const impactXY = shot.xy || (() => {
    const r = ringMidR(target, shot.ring, shot.ringPos);
    const ang = ((shot.clockH%12) + (shot.clockM||0)/60) * 30 * Math.PI/180;
    return { x: r*Math.sin(ang), y: r*Math.cos(ang) };
  })();
  const callXY = shot.callXY || null;
  const trace = shot.holdTrace || [];
  // Stepped view: stable, frames everything in this shot with even margin
  const viewR = steppedViewRadius(target, [impactXY, callXY, ...trace].filter(Boolean), { pad: 0.6, minStepIdx: 1 });
  const sc = (SZ * 0.88) / (viewR * 2);

  const tracePath = trace.length > 1
    ? trace.map((p,i) => `${i?'L':'M'}${(c + p.x*sc).toFixed(1)},${(c - p.y*sc).toFixed(1)}`).join(' ')
    : '';

  const callDistIn = (callXY && shot.xy) ? Math.hypot(shot.xy.x - callXY.x, shot.xy.y - callXY.y) : null;

  return (
    <div style={{padding:'10px 12px',background:'var(--bg)',borderTop:'1px solid var(--bdr)',borderBottom:'1px solid var(--bdr)'}}>
      <svg viewBox={`0 0 ${SZ} ${SZ}`} style={{width:'100%',maxWidth:280,display:'block',margin:'0 auto',background:'#1a1d27',borderRadius:5}}>
        {/* Background = outermost ring color */}
        {(() => {
          const o = target.rings[target.rings.length-1];
          const col = o.color || DEFAULT_RING_COLORS[o.score] || '#aaa';
          return <rect x={0} y={0} width={SZ} height={SZ} fill={col}/>;
        })()}
        {/* Rings */}
        {[...target.rings].reverse().map((r, revIdx) => {
          const fwdIdx = target.rings.length - 1 - revIdx;
          const col = r.color || DEFAULT_RING_COLORS[r.score] || '#aaa';
          const outerCol = fwdIdx < target.rings.length - 1
            ? (target.rings[fwdIdx + 1].color || DEFAULT_RING_COLORS[target.rings[fwdIdx+1].score] || '#aaa')
            : '#0f1117';
          const borderCol = ringBorderColor(col, outerCol);
          return (
            <circle key={r.score} cx={c} cy={c} r={r.diam/2 * sc}
              fill={col} stroke={borderCol} strokeWidth={1}/>
          );
        })}
        {/* Crosshair */}
        <line x1={c-6} y1={c} x2={c+6} y2={c} stroke="#ffffff33" strokeWidth={0.5}/>
        <line x1={c} y1={c-6} x2={c} y2={c+6} stroke="#ffffff33" strokeWidth={0.5}/>
        {/* Hold trace */}
        {tracePath && (
          <path d={tracePath} fill="none" stroke="#8d9aaa" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.85}/>
        )}
        {/* Trace start dot */}
        {trace.length > 0 && (
          <circle cx={c + trace[0].x*sc} cy={c - trace[0].y*sc} r={2} fill="#8d9aaa"/>
        )}
        {/* Call crosshair */}
        {callXY && (
          <g>
            <circle cx={c + callXY.x*sc} cy={c - callXY.y*sc} r={6} fill="none" stroke="#e8943a" strokeWidth={1.4} strokeDasharray="2 2"/>
            <line x1={c + callXY.x*sc - 7} y1={c - callXY.y*sc} x2={c + callXY.x*sc + 7} y2={c - callXY.y*sc} stroke="#e8943a" strokeWidth={0.9}/>
            <line x1={c + callXY.x*sc} y1={c - callXY.y*sc - 7} x2={c + callXY.x*sc} y2={c - callXY.y*sc + 7} stroke="#e8943a" strokeWidth={0.9}/>
          </g>
        )}
        {/* Impact dot */}
        {(() => {
          const ri = target.rings.findIndex(r => r.score === shot.ring);
          const ringFill = ri>=0 ? (target.rings[ri].color||'#aaa') : '#0f1117';
          const outline = isLightColor(ringFill) ? '#0a0a0a' : '#ffffff';
          const dot = shot.isSighter ? '#4a9eff' : '#e91e63';
          return (
            <g>
              {/* Connecting line call → impact */}
              {callXY && (
                <line
                  x1={c + callXY.x*sc} y1={c - callXY.y*sc}
                  x2={c + impactXY.x*sc} y2={c - impactXY.y*sc}
                  stroke="#e8943a" strokeWidth={0.7} strokeDasharray="1 2" opacity={0.6}/>
              )}
              <circle cx={c + impactXY.x*sc} cy={c - impactXY.y*sc} r={5}
                fill={shot.isSighter ? 'none' : dot}
                stroke={outline} strokeWidth={2}
                strokeDasharray={shot.isSighter ? '2 1' : undefined}/>
            </g>
          );
        })()}
      </svg>

      {/* Legend */}
      <div style={{display:'flex',justifyContent:'center',gap:14,marginTop:7,fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>
        {trace.length > 1 && (
          <span><span style={{color:'#8d9aaa',fontWeight:700}}>━━</span> hold</span>
        )}
        {callXY && (
          <span><span style={{color:'#e8943a',fontWeight:700}}>⊕</span> call</span>
        )}
        <span><span style={{color: shot.isSighter ? '#4a9eff' : '#e91e63',fontWeight:700}}>●</span> impact</span>
      </div>

      {/* Position readout */}
      <div style={{display:'flex',justifyContent:'center',gap:14,marginTop:6,fontFamily:'var(--fm)',fontSize:10,flexWrap:'wrap'}}>
        <div><span style={{color:'var(--dim)'}}>ring </span><span style={{color:'var(--ink)',fontWeight:700}}>{shot.ring}</span></div>
        <div><span style={{color:'var(--dim)'}}>clk </span><span style={{color:'var(--ink)',fontWeight:700}}>{shot.clockH}:{String(shot.clockM).padStart(2,'0')}</span></div>
        {callDistIn !== null && (
          <div><span style={{color:'var(--dim)'}}>Δcall </span><span style={{color:'var(--acc)',fontWeight:700}}>{callDistIn.toFixed(2)}"</span></div>
        )}
      </div>

      {/* Sight adjustment readout — mirrors the directional pad used at entry */}
      {(shot.elev !== 0 || shot.wind !== 0 || typeof shot.perShotWind === 'number' || typeof shot.windCallMoa === 'number') && (
        <div style={{
          marginTop:8,padding:'7px 10px',
          background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:5,
          display:'flex',justifyContent:'center',alignItems:'center',gap:14,flexWrap:'wrap',
          fontFamily:'var(--fm)',fontSize:10,
        }}>
          {(shot.elev !== 0 || shot.wind !== 0) && (
            <>
              <div style={{display:'flex',alignItems:'center',gap:4}}>
                <span style={{color:'var(--dim)',fontSize:9,letterSpacing:'.05em',textTransform:'uppercase'}}>sight MOA</span>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:5}}>
                <span style={{color:'var(--dim)'}}>E</span>
                <span style={{
                  color: shot.elev === 0 ? 'var(--dim)' : 'var(--acc)',
                  fontWeight:700,minWidth:44,textAlign:'right',
                }}>{fmtMoaSigned(shot.elev)}</span>
                <span style={{color:shot.elev === 0 ? 'var(--bdr)' : 'var(--acc)',fontSize:11,fontWeight:700}}>
                  {shot.elev > 0 ? '↑' : shot.elev < 0 ? '↓' : '·'}
                </span>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:5}}>
                <span style={{color:'var(--dim)'}}>W</span>
                <span style={{
                  color: shot.wind === 0 ? 'var(--dim)' : '#4a9eff',
                  fontWeight:700,minWidth:44,textAlign:'right',
                }}>{fmtMoaSigned(shot.wind)}</span>
                <span style={{color:shot.wind === 0 ? 'var(--bdr)' : '#4a9eff',fontSize:11,fontWeight:700}}>
                  {shot.wind > 0 ? '→' : shot.wind < 0 ? '←' : '·'}
                </span>
              </div>
            </>
          )}
          {typeof shot.perShotWind === 'number' && (
            <div style={{display:'flex',alignItems:'center',gap:4}}>
              <span style={{color:'var(--dim)'}}>wind</span>
              <span style={{color:'var(--green)',fontWeight:700}}>
                {shot.perShotWind}mph{shot.perShotWindDir ? ` @ ${shot.perShotWindDir}` : ''}
              </span>
            </div>
          )}
          {typeof shot.windCallMoa === 'number' && (
            <div style={{display:'flex',alignItems:'center',gap:4}}>
              <span style={{color:'var(--dim)'}}>hold</span>
              <span style={{color:'#4a9eff',fontWeight:700}}>
                {shot.windCallMoa} MOA {shot.windCallDir}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Notes if present */}
      {shot.notes && (
        <div style={{
          marginTop:6,padding:'6px 10px',
          background:'var(--surf2)',border:'1px dashed var(--bdr)',borderRadius:5,
          fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',
          fontStyle:'italic',lineHeight:1.5,
        }}>
          “{shot.notes}”
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  function doCopy() {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(()=>{});
    }
    setCopied(true);
    setTimeout(()=>setCopied(false), 2000);
  }
  return (
    <button onClick={doCopy} style={{
      fontFamily:'var(--fm)',fontSize:9,
      color: copied ? 'var(--green)' : 'var(--acc)',
      background:'none',border:`1px solid ${copied ? 'var(--green)' : 'var(--acc)'}`,
      borderRadius:4,padding:'3px 9px',cursor:'pointer',transition:'color .2s,border-color .2s',
    }}>{copied ? '✓ copied' : 'copy'}</button>
  );
}

function SessionDetail({ session, target, firearm, match, sessions, ammo, onBack, onAddShot, onDelShot, onDelSess, core, onPublish, live, hostName, onHostName, onGoLive, onJoinLive, onEndLive }) {
  const [addingShot, setAddingShot] = useState(false);
  const [confirmDelSess, setConfirmDelSess] = useState(false);
  const [confirmDelShot, setConfirmDelShot] = useState(null);
  const [shareText, setShareText] = useState(null);
  const [expandedShot, setExpandedShot] = useState(null);
  // Live relay state, subscribed here rather than threaded down from App:
  // the partner's string is a property of the relay, not of this session, and
  // it must reach the plot without every intermediate component knowing.
  const [relayState, setRelayState] = useState(null);
  useEffect(() => {
    if (!core || !live) { setRelayState(null); return undefined; }
    return core.on(core.EVENTS.RELAY_STATE, p => setRelayState(p));
  }, [core, live]);
  const partners = live
    ? relaySeries(relayState?.shots, relayState?.participants)
        .filter(x => !x.isSelf && x.stats.pts.length)
    : [];

  const shots = session.shots || [];
  const a = analytics(shots, target, session.rangeYards);
  const wa = windCallAnalytics(shots, target, session.rangeYards);

  if (addingShot) {
    const last = shots[shots.length-1];
    // First shot of a session: pre-fill the sight setting from the confirmed
    // zero for this exact firearm × location × distance × position slot (same
    // key the DOPE tab uses), so the shooter starts from their known dial
    // instead of 0/0. Once any shot exists, the in-session last shot wins —
    // DOPE never overrides live adjustments.
    const dopeZero = !last && sessions
      ? findConfirmedZero(sessions, {
          rifleId: session.rifleId,
          location: session.rangeLocation,
          yards: session.rangeYards,
          position: session.position,
        }, session.id)
      : null;
    return <ShotEntry
      num={shots.length+1}
      target={target}
      yards={session.rangeYards}
      fireMode={session.fireMode || 'Slow'}
      priorShots={shots}
      lastElev={last?.elev ?? dopeZero?.elev ?? 0}
      lastWind={last?.wind ?? dopeZero?.wind ?? 0}
      lastRing={last?.ring || (target.rings[1]?.score || target.rings[0]?.score)}
      dopeSource={!last && dopeZero ? dopeZero : null}
      onBack={()=>setAddingShot(false)}
      onSave={sh=>onAddShot(sh)}
      onDone={()=>setAddingShot(false)}
      getShotCount={()=>shots.length}
      partners={partners}
    />;
  }

  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="hdr">
          <button className="bback" onClick={onBack}>← {match ? match.name||match.type : 'sessions'}</button>
          <div style={{display:'flex',gap:6}}>
            {core && core.isSignedIn() && leaderboardEntryFor(session, target, session.lbId) && (
              <button className="badd" onClick={()=>onPublish(session)}
                style={{background:'none',border:'1px solid var(--bdr)',color: session.lbId ? 'var(--green)' : 'var(--ink)'}}>
                {session.lbId ? '✓ published' : '⇧ publish'}</button>
            )}
            <button className="badd" onClick={()=>setAddingShot(true)}>+ shot</button>
          </div>
        </div>
        <div className="content">
          <div style={{padding:'13px 13px 4px'}}>
            {match && <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--acc)',letterSpacing:'.08em',marginBottom:3,textTransform:'uppercase'}}>{match.name||match.type}</div>}
            <div style={{fontFamily:'var(--fh)',fontSize:18,fontWeight:700}}>{session.name||`${target.name} · ${session.rangeYards}yd`}</div>
            <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)',marginTop:2}}>{session.date} · {session.type}</div>
          </div>
          <div className="chips">
            <span className="chip">{target.name} / {session.rangeYards}yd</span>
            {session.rangeLocation && <span className="chip">{session.rangeLocation}</span>}
            {session.position && <span className="chip" style={{color:'var(--green)',borderColor:'var(--green)'}}>{session.position}</span>}
            {session.fireMode === 'Rapid' && <span className="chip" style={{color:'var(--acc)',borderColor:'var(--acc)'}}>Rapid fire</span>}
            {session.fireMode && <span className="chip" style={{color:'var(--green)',borderColor:'var(--green)'}}>{session.fireMode} fire</span>}
            {session.type && session.type !== 'Score' && <span className="chip" style={{color:'var(--acc)',borderColor:'var(--acc)'}}>{session.type}</span>}
            {firearm && <span className="chip" style={{color:'var(--acc)',borderColor:'var(--acc)'}}>{firearm.name}{firearm.caliber?` · ${firearm.caliber}`:''}</span>}
            {session.wSpeed && <span className="chip">wind {session.wSpeed}mph · {session.wDir} o'clock</span>}
            {session.temp && <span className="chip">{session.temp}°F</span>}
            {session.lighting && <span className="chip">{session.lighting}</span>}
            {session.ammoId && (()=>{ const load = (ammo||[]).find(a=>a.id===session.ammoId); return load
              ? <span className="chip" style={{color:'var(--acc)',borderColor:'var(--acc)'}}>{load.name}</span>
              : null; })()}
            {session.ammoLot && <span className="chip">lot {session.ammoLot}{session.ammoDesc ? ` · ${session.ammoDesc}` : ''}</span>}
            {session.equipment && <span className="chip" style={{maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{session.equipment}</span>}
          </div>

          <RelayCard core={core} live={live} hostName={hostName}
            onHostName={onHostName} onGoLive={onGoLive} onJoinLive={onJoinLive}
            onEndLive={onEndLive} distanceYd={+session.rangeYards || null}/>

          {a && a.n >= 2 && <>
            <div className="shdr">Group analytics</div>
            <div className="agrid">
              <div className="acell"><div className="av">{a.esMoa.toFixed(2)}</div><div className="au">MOA</div><div className="al">Extreme spread</div></div>
              <div className="acell"><div className="av">{a.mrMoa.toFixed(2)}</div><div className="au">MOA</div><div className="al">Mean radius</div></div>
              <div className="acell"><div className="av">{a.esIn.toFixed(2)}"</div><div className="au">inches</div><div className="al">ES physical</div></div>
              <div className="acell"><div className="av">{a.score}–{a.xs}X</div><div className="au"> </div><div className="al">Score</div></div>
            </div>
            {a.mrLoIn != null && session.rangeYards > 0 && (
              <div style={{margin:'6px 13px 0',fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',lineHeight:1.5}}>
                MR 90% CI {inchesToMoa(a.mrLoIn,session.rangeYards).toFixed(2)}–{inchesToMoa(a.mrHiIn,session.rangeYards).toFixed(2)} MOA · n={a.n}.
                Sessions whose bands overlap are indistinguishable — a delta inside this range is sampling luck, not a change.
              </div>
            )}
            <div style={{height:10}} />
            <GroupPlot pts={a.pts} target={target} shots={shots} yards={session.rangeYards} partners={partners} />
            <ScoreDecomposition session={session} target={target} shots={shots} />
          </>}
          {a && a.score > 0 && a.n < 2 && (
            <div className="agrid" style={{marginTop:8}}>
              <div className="acell"><div className="av">{a.score}–{a.xs}X</div><div className="au"> </div><div className="al">Score</div></div>
              <div className="acell" style={{display:'flex',alignItems:'center'}}><div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>2+ record shots needed for group stats</div></div>
            </div>
          )}

          {/* Wind call accuracy */}
          {wa && wa.n >= 1 && a && a.n >= 2 && (
            <>
              <div className="shdr">Wind call accuracy · {wa.n} shot{wa.n===1?'':'s'}</div>
              <div style={{margin:'0 13px 8px',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,padding:'11px 13px'}}>
                <div style={{display:'flex',justifyContent:'space-between',gap:14,marginBottom:8}}>
                  <div style={{flex:1}}>
                    <div style={{fontFamily:'var(--fm)',fontSize:10,color:'#4a9eff',fontWeight:700}}>{wa.absMeanErr.toFixed(2)} MOA</div>
                    <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',letterSpacing:'.08em'}}>mean abs error</div>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontFamily:'var(--fm)',fontSize:10,color: wa.biasDir==='neutral' ? 'var(--green)' : 'var(--acc)',fontWeight:700}}>
                      {wa.biasDir==='neutral' ? 'neutral' : `${Math.abs(wa.meanErr).toFixed(2)} ${wa.biasDir}`}
                    </div>
                    <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',letterSpacing:'.08em'}}>directional bias</div>
                  </div>
                </div>
                <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',lineHeight:1.5}}>
                  {wa.biasDir==='neutral'
                    ? 'Your wind calls are balanced — no consistent directional error.'
                    : `Your calls tend to be ${Math.abs(wa.meanErr).toFixed(2)} MOA too far ${wa.biasDir==='R'?'right':'left'}. Consider adjusting hold.`}
                </div>
              </div>
            </>
          )}

          {/* Per-shot call vs impact analysis */}
          <CallErrorChart shots={shots} target={target} yards={session.rangeYards}/>

          <div className="shdr">Shots ({shots.length}{shots.some(s=>s.isSighter) ? ` · ${shots.filter(s=>s.isSighter).length}S` : ''})</div>
          {shots.length===0
            ? <div className="empty"><div className="et" style={{fontSize:14}}>No shots yet</div><div className="es">Tap + shot to begin logging.</div></div>
            : shots.map((sh,i)=>{
              const expanded = expandedShot === sh.id;
              return (
              <div key={sh.id}>
                <div className="srow" style={{
                  opacity: sh.isSighter ? 0.55 : 1,
                  cursor: 'pointer',
                  background: expanded ? 'var(--surf2)' : 'transparent',
                }}
                onClick={(e)=>{
                  if (e.target.closest('.delx,button')) return;
                  setExpandedShot(prev => prev === sh.id ? null : sh.id);
                }}>
                <div className="sn" style={{color: sh.isSighter ? '#4a9eff' : 'var(--dim)'}}>{shotLabel(shots,i)}</div>
                {sh.isSighter
                  ? <div style={{fontFamily:'var(--fm)',fontSize:9,fontWeight:700,color:'#4a9eff',width:24,textAlign:'center',border:'1px solid #4a9eff44',borderRadius:3,padding:'1px 0'}}>S</div>
                  : <div className="sr-ring" style={{
                      color:'var(--ink)',
                      borderLeft:`3px solid ${ringColor(target, sh.ring)}`,
                      paddingLeft:5,
                      marginLeft:-2,
                    }}>{sh.ring}</div>
                }
                <div className="scall">{sh.isSighter ? 'sighter · ' : ''}{sh.clockH}:{String(sh.clockM).padStart(2,'0')}</div>
                <div className="ssight">E{fmtMoaSigned(sh.elev)} W{fmtMoaSigned(sh.wind)}</div>
                {typeof sh.windCallMoa === 'number' && (
                  <div style={{fontFamily:'var(--fm)',fontSize:8,color:'#4a9eff',border:'1px solid #4a9eff66',borderRadius:3,padding:'1px 4px',letterSpacing:'.05em',flexShrink:0}}>
                    wc {sh.windCallMoa}{sh.windCallDir}
                  </div>
                )}
                {typeof sh.perShotWind === 'number' && (
                  <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--green)',border:'1px solid var(--green)66',borderRadius:3,padding:'1px 4px',letterSpacing:'.05em',flexShrink:0}}>
                    {sh.perShotWind}mph{sh.perShotWindDir?` ${sh.perShotWindDir}`:''}
                  </div>
                )}
                {sh.callXY && sh.xy && (() => {
                  const d = Math.hypot(sh.xy.x - sh.callXY.x, sh.xy.y - sh.callXY.y);
                  return (
                    <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--acc)',border:'1px solid var(--acc)66',borderRadius:3,padding:'1px 4px',letterSpacing:'.05em',flexShrink:0}} title={`Call error: ${d.toFixed(2)}"`}>
                      Δ{d.toFixed(1)}"
                    </div>
                  );
                })()}
                {sh.holdTrace && sh.holdTrace.length > 1 && (
                  <div style={{fontFamily:'var(--fm)',fontSize:8,color:'#8d9aaa',border:'1px solid #8d9aaa66',borderRadius:3,padding:'1px 4px',letterSpacing:'.05em',flexShrink:0}} title="Hold trace recorded">
                    trc
                  </div>
                )}
                {sh.notes && <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',maxWidth:60,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={sh.notes}>{sh.notes}</div>}
                {/* Expand chevron */}
                <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',flexShrink:0,marginLeft:'auto'}}>
                  {expanded ? '▾' : '▸'}
                </div>
                {confirmDelShot === sh.id ? (
                  <div style={{display:'flex',gap:4,alignItems:'center',flexShrink:0}}>
                    <button style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--red)',background:'none',border:'1px solid var(--red)',borderRadius:3,padding:'2px 6px',cursor:'pointer'}}
                      onClick={(e)=>{e.stopPropagation();onDelShot(sh.id);setConfirmDelShot(null);}}>del</button>
                    <button style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',background:'none',border:'1px solid var(--bdr)',borderRadius:3,padding:'2px 6px',cursor:'pointer'}}
                      onClick={(e)=>{e.stopPropagation();setConfirmDelShot(null);}}>×</button>
                  </div>
                ) : (
                  <button className="delx" onClick={(e)=>{e.stopPropagation();setConfirmDelShot(sh.id);}}>×</button>
                )}
              </div>
              {expanded && (
                <ShotInspector shot={sh} target={target} />
              )}
              </div>
              );
            })
          }

          {shots.length > 0 && (
            <div style={{padding:'12px 13px 4px'}}>
              <div className="shdr" style={{padding:'0 0 8px'}}>Sight drift</div>
              <SightChart shots={shots} />
            </div>
          )}

          <div style={{padding:'18px 13px 8px',display:'flex',gap:9,alignItems:'center'}}>
            {confirmDelSess ? (
              <>
                <span style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>Delete this session?</span>
                <button style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--red)',background:'none',border:'1px solid var(--red)',borderRadius:4,padding:'4px 10px',cursor:'pointer'}}
                  onClick={onDelSess}>yes, delete</button>
                <button style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',background:'none',border:'1px solid var(--bdr)',borderRadius:4,padding:'4px 10px',cursor:'pointer'}}
                  onClick={()=>setConfirmDelSess(false)}>cancel</button>
              </>
            ) : (
              <button className="bdel" onClick={()=>setConfirmDelSess(true)}>Delete session</button>
            )}
            <div style={{flex:1}}/>
            <button onClick={()=>setShareText(buildExportText(session, target, a, firearm, wa))} style={{
              background:'none',border:'1px solid var(--bdr)',borderRadius:5,
              padding:'6px 13px',fontFamily:'var(--fm)',fontSize:10,
              color:'var(--dim)',cursor:'pointer',
            }}>↑ Share</button>
          </div>

          {/* Share / export panel */}
          {shareText && (
            <div style={{margin:'0 13px 16px',background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:9,overflow:'hidden'}}>
              <div style={{padding:'9px 12px',borderBottom:'1px solid var(--bdr)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--acc)',letterSpacing:'.1em',textTransform:'uppercase'}}>Export text</div>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <CopyButton text={shareText}/>
                  <button onClick={()=>setShareText(null)} style={{background:'none',border:'none',color:'var(--dim)',cursor:'pointer',fontSize:14,lineHeight:1}}>×</button>
                </div>
              </div>
              <textarea
                readOnly
                value={shareText}
                onFocus={e=>e.target.select()}
                style={{
                  width:'100%',minHeight:180,background:'transparent',border:'none',
                  padding:'10px 12px',color:'var(--ink)',fontFamily:'var(--fm)',fontSize:10,
                  lineHeight:1.6,resize:'vertical',outline:'none',
                }}
              />
              <div style={{padding:'6px 12px 9px',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>
                Tap the text above to select, or use the copy button.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ── MOA reference grid ──
 * Uniform 1/2-MOA gridlines (= two clicks) at TRUE MOA spacing for the shooter's
 * distance, with a crosshair marking center. 1/2 MOA subtends
 * (0.5 * MOA_PER_100YD * yards/100) inches downrange; that length is mapped to
 * pixels with the same px/inch scale (`sc`) the target face uses, so each square
 * is exactly two clicks. All lines are the same weight — no major/minor tiers, no
 * labels. A faint dark+light pair keeps them visible on any ring color without
 * reading as "bold". Shared by the tap board and the live preview. */
function MoaGrid({ SZ, c, sc, yards }) {
  if (!yards || yards <= 0 || !sc || !isFinite(sc) || sc <= 0) return null;
  const inchPerMoa = MOA_PER_100YD * yards / 100;
  const stepIn = 0.5 * inchPerMoa;                   // 1/2 MOA = two clicks
  const stepPx = stepIn * sc;
  if (!isFinite(stepPx) || stepPx < 2) return null;  // degenerate: lines would overlap
  const halfInches = SZ / (2 * sc);
  const maxK = Math.min(160, Math.floor(halfInches / stepIn));
  const offs = [];
  for (let k = 1; k <= maxK; k++) offs.push(k * stepPx);
  const ch = SZ * 0.05;                              // center crosshair half-length
  const VLine = ({ x }) => (<>
    <line x1={x} y1={0} x2={x} y2={SZ} stroke="#00000033" strokeWidth={0.8}/>
    <line x1={x} y1={0} x2={x} y2={SZ} stroke="#ffffff30" strokeWidth={0.4}/>
  </>);
  const HLine = ({ y }) => (<>
    <line x1={0} y1={y} x2={SZ} y2={y} stroke="#00000033" strokeWidth={0.8}/>
    <line x1={0} y1={y} x2={SZ} y2={y} stroke="#ffffff30" strokeWidth={0.4}/>
  </>);
  return (
    <g pointerEvents="none">
      {offs.map((o,i) => (<g key={'v'+i}><VLine x={c+o}/><VLine x={c-o}/></g>))}
      {offs.map((o,i) => (<g key={'h'+i}><HLine y={c+o}/><HLine y={c-o}/></g>))}
      {/* center crosshair */}
      <line x1={c-ch} y1={c} x2={c+ch} y2={c} stroke="#000000aa" strokeWidth={1.6}/>
      <line x1={c-ch} y1={c} x2={c+ch} y2={c} stroke="#ffffff" strokeWidth={0.8}/>
      <line x1={c} y1={c-ch} x2={c} y2={c+ch} stroke="#000000aa" strokeWidth={1.6}/>
      <line x1={c} y1={c-ch} x2={c} y2={c+ch} stroke="#ffffff" strokeWidth={0.8}/>
    </g>
  );
}

/* ── Real-time target preview ── */
/* A partner's impact, drawn on the target you are both shooting.
 *
 * Partner shots are deliberately NOT included in the view-radius calculation:
 * letting one of their wide shots rescale the picture would move the paper
 * under a shooter who is mid-aim, and that is the one moment the frame has to
 * hold still. But silently dropping what falls outside is worse -- on a shared
 * target the wide shot is the one you most need to know about -- so an
 * off-frame impact is clamped to the edge along its own bearing. You lose the
 * exact position and keep the fact and the direction. */
function RelayImpactMark({ pt, slot, i, color, SZ, c, sc, r = 4.5 }) {
  const px = c + pt.x * sc, py = c - pt.y * sc;
  const m = 7;
  if (px >= m && py >= m && px <= SZ - m && py <= SZ - m) {
    return (
      <g key={'pp' + slot + '-' + i}>
        <circle className="relayed" cx={px} cy={py} r={r} fill="none"
          stroke={color} strokeWidth={1.9} strokeDasharray="3.5 2"/>
        <text x={px} y={py + 2} textAnchor="middle" fill={color}
          fontSize={4.5} fontFamily="Space Mono,monospace" fontWeight="700">{i + 1}</text>
      </g>
    );
  }
  const dx = px - c, dy = py - c;
  const t = Math.min((c - m) / Math.max(Math.abs(dx), 1e-6),
                     (c - m) / Math.max(Math.abs(dy), 1e-6));
  const ex = c + dx * t, ey = c + dy * t;
  return (
    <g key={'pp' + slot + '-' + i}>
      <circle className="relayed relayed-edge" cx={ex} cy={ey} r={3} fill={color} opacity={0.9}/>
      <title>{`shot ${i + 1} landed outside this view`}</title>
    </g>
  );
}

/* The target face itself: background, zones or rings, and score labels.
 *
 * One implementation, used by the shooter's live preview and by the coach's
 * relay plot. They draw the same paper and had every reason to diverge —
 * which is exactly the kind of duplication that ends with two apps disagreeing
 * about where the 10 ring is. */
function TargetFace({ target, SZ, c, sc, labels = true }) {
  if (!target || !target.rings?.length) return null;
  const outermost = target.rings[target.rings.length - 1];
  const bg = outermost.color || DEFAULT_RING_COLORS[outermost.score] || '#aaa';
  return (
    <>
      {/* Background fill, for rings scrolled off the edge of the view */}
      <rect x={0} y={0} width={SZ} height={SZ} fill={bg}/>
      {/* Zone targets: true shapes worst→best so better zones paint on top,
          mirroring the best-first hit-test order. Ring targets fall through
          to the concentric render below. */}
      {target.zones?.length ? [...target.zones].reverse().map((z, i) => {
        const col = z.color || '#7a7f96';
        const stroke = isLightColor(col) ? '#00000055' : '#ffffff55';
        const cxp = c + (z.shape.cx||0)*sc, cyp = c - (z.shape.cy||0)*sc;
        if (z.shape.kind === 'circle')
          return <circle key={i} cx={cxp} cy={cyp} r={z.shape.d/2*sc} fill={col} stroke={stroke} strokeWidth={0.8}/>;
        if (z.shape.kind === 'rect')
          return <rect key={i} x={cxp - z.shape.w/2*sc} y={cyp - z.shape.h/2*sc}
            width={z.shape.w*sc} height={z.shape.h*sc} rx={(z.shape.rx||0)*sc}
            fill={col} stroke={stroke} strokeWidth={0.8}/>;
        if (z.shape.kind === 'poly')
          return <path key={i} d={'M'+z.shape.pts.map(([px,py])=>`${c+px*sc},${c-py*sc}`).join('L')+'Z'}
            fill={col} stroke={stroke} strokeWidth={0.8}/>;
        return null;
      }) : null}
      {/* Rings: outside-in, only those that intersect the viewport */}
      {!target.zones?.length && [...target.rings].reverse().map((r, revIdx) => {
        const fwdIdx = target.rings.length - 1 - revIdx;
        const col = r.color || DEFAULT_RING_COLORS[r.score] || '#aaa';
        const outerCol = fwdIdx < target.rings.length - 1
          ? (target.rings[fwdIdx + 1].color || DEFAULT_RING_COLORS[target.rings[fwdIdx+1].score] || '#aaa')
          : '#0f1117';
        const borderCol = ringBorderColor(col, outerCol);
        const ringW = fwdIdx > 0
          ? (r.diam/2 - target.rings[fwdIdx-1].diam/2) * sc
          : r.diam/2*sc;
        const sw = Math.min(1.5, Math.max(0.5, ringW * 0.06));
        return (
          <circle key={r.score} cx={c} cy={c} r={r.diam / 2 * sc}
            fill={col} stroke={borderCol} strokeWidth={sw}/>
        );
      })}
      {/* Score labels, only where the band is wide enough to hold one */}
      {labels && !target.zones?.length && target.rings.map((r, i) => {
        const oR = r.diam / 2 * sc;
        const iR = i > 0 ? target.rings[i-1].diam / 2 * sc : 0;
        if (oR - iR < 8 || oR < 4) return null;
        const labelR = (iR + oR) / 2;
        const col = r.color || DEFAULT_RING_COLORS[r.score] || '#aaa';
        const textCol = isLightColor(col) ? '#00000066' : '#ffffff66';
        return (
          <text key={r.score} x={c + labelR} y={c + 3.5}
            textAnchor="middle" fill={textCol}
            fontSize={Math.min(9, (oR - iR) * 0.5)}
            fontFamily="Space Mono,monospace"
          >{r.score}</text>
        );
      })}
    </>
  );
}

function TargetPreview({ target, yards, ring, ringPos, clockH, clockM, priorShots, lastSavedIdx, isSighter, partners }) {
  const SZ = 200;
  const c = SZ / 2;

  const shotR = ringMidR(target, ring, ringPos);
  const ang = ((clockH % 12) + clockM / 60) * 30 * Math.PI / 180;

  // Stepped view radius: stable, ring-aligned, doesn't whiplash on outliers.
  // Includes the current (in-progress) shot so the preview frames it, but
  // since the steps are quantized, small movements within a ring don't
  // change the scale.
  const priorPts = (priorShots || []).map(sh => shotXY(sh, target));
  const currentPt = { x: shotR * Math.sin(ang), y: shotR * Math.cos(ang) };
  // Partner impacts are drawn but deliberately NOT included in the view
  // radius. A pair fires one target, so their shots belong in this frame --
  // but letting a partner's wide shot rescale the picture would move the
  // paper under a shooter who is mid-aim, which is the one moment the frame
  // has to hold still.
  const viewR = steppedViewRadius(target, [...priorPts, currentPt], { pad: 0.6, minStepIdx: 1 });
  const sc = (SZ * 0.88) / (viewR * 2);

  // Now project shot positions with the computed scale (using shotXY so tap-mode shots are honored)
  const prior = (priorShots || []).map((sh, i) => {
    const p = shotXY(sh, target);
    return {
      x: c + p.x * sc,
      y: c - p.y * sc,
      num: i + 1,
      label: shotLabel(priorShots, i),
      isSighter: sh.isSighter,
    };
  });

  const sx = c + shotR * sc * Math.sin(ang);
  const sy = c - shotR * sc * Math.cos(ang);

  // Label for the current (unsaved) shot
  const currentSighterCount = (priorShots||[]).filter(s=>s.isSighter).length + (isSighter ? 1 : 0);
  const currentRecordCount  = (priorShots||[]).filter(s=>!s.isSighter).length + (isSighter ? 0 : 1);
  const currentLabel = isSighter
    ? String.fromCharCode(64 + currentSighterCount)
    : String(currentRecordCount);

  // Which rings are visible in this view (avoid rendering rings entirely outside the viewport)
  const visibleRings = target.rings.filter(r => r.diam / 2 * sc > 2);

  return (
    <div style={{
      background:'var(--surf)',
      border:'1px solid var(--bdr)',
      borderRadius:9,
      overflow:'hidden',
      margin:'0 0 4px',
    }}>
      <div style={{padding:'7px 12px',borderBottom:'1px solid var(--bdr)',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.1em',textTransform:'uppercase',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span>Live preview · {target.name}</span>
        <span style={{color:'var(--acc)',fontWeight:700}}>
          {currentLabel} {ring} @ {clockH}:{String(clockM).padStart(2,'0')}
        </span>
      </div>
      <svg viewBox={`0 0 ${SZ} ${SZ}`} style={{width:'100%',display:'block',background:'#1a1d27'}}>
        <TargetFace target={target} SZ={SZ} c={c} sc={sc}/>
        {/* MOA reference grid */}
        <MoaGrid SZ={SZ} c={c} sc={sc} yards={yards}/>
        {/* Crosshair */}
        <line x1={c-6} y1={c} x2={c+6} y2={c} stroke="#ffffff22" strokeWidth={0.5}/>
        <line x1={c} y1={c-6} x2={c} y2={c+6} stroke="#ffffff22" strokeWidth={0.5}/>
        {/* The partner's string, live. Hollow and dashed in their firing-point
            colour so it never reads as one of yours, and excluded from every
            statistic on this screen. Seeing it while you are on the gun is the
            point of pair fire: their last shot is your wind call. */}
        {(partners || []).flatMap(o => o.stats.pts.map((pt, i) => (
          <RelayImpactMark key={'pp' + o.slot + '-' + i} pt={pt} slot={o.slot} i={i}
            color={o.color} SZ={SZ} c={c} sc={sc}/>
        )))}
        {/* Prior shots — fixed high-visibility color with contrast outline */}
        {prior.map((p) => {
          const sh = (priorShots||[])[p.num-1];
          const ri = sh ? target.rings.findIndex(r=>r.score===sh.ring) : -1;
          const ringFill = ri>=0 ? (target.rings[ri].color||DEFAULT_RING_COLORS[sh.ring]||'#aaa') : '#0f1117';
          const isJustSaved = lastSavedIdx === p.num - 1;
          // Fixed dot color: bright red-pink, highly visible on any NRA ring color
          const DOT_COLOR = p.isSighter ? '#4a9eff' : '#e91e63';
          // Outline contrasts with the ring the dot is drawn on (not with the dot itself)
          const outline = isLightColor(ringFill) ? '#0a0a0a' : '#ffffff';
          const sw = isJustSaved ? 2.2 : 1.4;
          // Number text color: always high-contrast against the dot color
          const numCol = '#ffffff';
          return (
            <g key={p.num} opacity={p.isSighter ? 0.55 : 1}>
              <circle cx={p.x} cy={p.y} r={4}
                fill={p.isSighter ? 'none' : DOT_COLOR}
                stroke={p.isSighter ? '#4a9eff' : outline}
                strokeWidth={sw}
                strokeDasharray={p.isSighter ? '2 1' : undefined}/>
              <text x={p.x} y={p.y+2} textAnchor="middle" fill={p.isSighter?'#4a9eff':numCol} fontSize={4.5} fontFamily="Space Mono,monospace" fontWeight="700">{p.label}</text>
            </g>
          );
        })}
        {/* Current shot — same fixed color, brighter white outline for identification */}
        {(() => {
          const ri = target.rings.findIndex(r=>r.score===ring);
          const ringFill = ri>=0 ? (target.rings[ri].color||DEFAULT_RING_COLORS[ring]||'#aaa') : '#0f1117';
          const DOT_COLOR = isSighter ? '#4a9eff' : '#e91e63';
          const outline = isLightColor(ringFill) ? '#0a0a0a' : '#ffffff';
          return (
            <g opacity={isSighter ? 0.9 : 1}>
              <circle cx={sx} cy={sy} r={5}
                fill={isSighter ? 'none' : DOT_COLOR}
                stroke={outline} strokeWidth={2.5}
                strokeDasharray={isSighter ? '2 1' : undefined}/>
              <text x={sx} y={sy+2} textAnchor="middle" fill="#ffffff" fontSize={4.5} fontFamily="Space Mono,monospace" fontWeight="700">{currentLabel}</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

function isLightColor(hex) {
  const h = (hex||'#888888').replace('#','').padEnd(6,'0');
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  return (r*299 + g*587 + b*114) / 1000 > 155;
}

// Returns a perceptually contrasting border color for a ring,
// guaranteed to differ from both the ring's own fill and its outer neighbor's fill.
// Uses luminance-based approach: picks from a set of candidate grays/neutrals
// and selects the one with highest minimum contrast against both adjacent colors.
function ringBorderColor(ringCol, outerCol) {
  const lum = hex => {
    const h = (hex||'#888888').replace('#','').padEnd(6,'0');
    const [r,g,b] = [0,2,4].map(i => {
      const v = parseInt(h.slice(i,i+2),16)/255;
      return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
    });
    return 0.2126*r + 0.7152*g + 0.0722*b;
  };
  const contrast = (a,b) => {
    const [l1,l2] = [lum(a),lum(b)].sort((x,y)=>y-x);
    return (l1+0.05)/(l2+0.05);
  };
  // Candidate border strokes: dark to light neutrals + some warm/cool options
  const candidates = ['#0a0a0a','#1a1d27','#2a2a3a','#444','#666','#888','#aaa','#ccc','#e8e8e8','#ffffff',
                       '#e8943a','#f0f2f8','#353848','#7a7f96'];
  let best = '#444444', bestScore = -1;
  for (const cand of candidates) {
    const score = Math.min(contrast(cand, ringCol), contrast(cand, outerCol || '#0f1117'));
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

/* ── Tap-to-place target input ──
 * Three-step entry: hold trace → call point → actual impact.
 * All coordinates stored in target inches (origin = center, +x right, +y up).
 * The user can advance/back through steps; the call point and hold trace are
 * optional (can skip) but the actual shot is required for save.
 */
function TapInput({
  target, yards, fireMode, priorShots, partners,
  tapXY, setTapXY,
  callXY, setCallXY,
  holdTrace, setHoldTrace,
  step, setStep,
  tracing, setTracing,
  isSighter,
}) {
  const SZ = 320;
  const c = SZ / 2;
  const svgRef = useRef(null);
  const [zoomStep, setZoomStep] = useState(0); // user zoom offset; 0 = auto, +/- bumps

  const isRapid = fireMode === 'Rapid';
  // In rapid fire, force step to 'shot' — no time to log hold/call between shots.
  useEffect(() => {
    if (isRapid && step !== 'shot') setStep('shot');
  }, [isRapid, step, setStep]);

  // Dynamic scaling: fit prior shots + current placements + a default minimum view
  const priorPts = (priorShots || []).map(sh => shotXY(sh, target));
  // Scale is computed ONLY from prior shots (committed data). In-progress
  // placements (current tap/call/hold) deliberately do NOT affect the scale,
  // so placing a shot near the edge doesn't suddenly zoom out and shift your
  // finger position. The user can manually expand the view via the zoom
  // control if they need to place a shot outside the current frame.
  const baseViewR = steppedViewRadius(target, priorPts, { pad: 0.6, minStepIdx: 2 });
  // User zoom override: an integer step offset, accumulated via +/− buttons.
  // Always >= 0 (cannot zoom tighter than the auto-pick).
  const baseStepIdx = (() => {
    const rings = target.rings;
    const steps = rings.map(r => r.diam/2 * 1.10);
    steps.push(rings[rings.length-1].diam/2 * 1.05);
    return steps.findIndex(s => Math.abs(s - baseViewR) < 0.01);
  })();
  const totalSteps = target.rings.length + 1;
  const effectiveIdx = Math.min(totalSteps - 1, Math.max(baseStepIdx, baseStepIdx + zoomStep));
  const stepRadii = (() => {
    const rings = target.rings;
    const steps = rings.map(r => r.diam/2 * 1.10);
    steps.push(rings[rings.length-1].diam/2 * 1.05);
    return steps;
  })();
  const viewR = stepRadii[effectiveIdx];
  const sc = (SZ * 0.88) / (viewR * 2);

  // Inverse projection: SVG coords → target inches
  function svgToInches(clientX, clientY) {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width)  * SZ;
    const py = ((clientY - rect.top)  / rect.height) * SZ;
    return {
      x: (px - c) / sc,
      y: -(py - c) / sc, // flip y so +y is up
    };
  }

  function getPointer(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function onDown(e) {
    e.preventDefault();
    const p = getPointer(e);
    const inch = svgToInches(p.x, p.y);
    if (step === 'hold') {
      setHoldTrace([inch]);
      setTracing(true);
    } else if (step === 'call') {
      setCallXY(inch);
      // Auto-advance to shot step. User can tap call again to correct.
      setStep('shot');
    } else if (step === 'shot') {
      setTapXY(inch);
      // Stay on shot — user often corrects this one.
    }
  }

  function onMove(e) {
    if (step === 'hold' && tracing) {
      e.preventDefault();
      const p = getPointer(e);
      const inch = svgToInches(p.x, p.y);
      setHoldTrace(prev => {
        const last = prev[prev.length-1];
        if (last && Math.hypot(inch.x-last.x, inch.y-last.y) < 0.2) return prev;
        return [...prev, inch];
      });
    }
  }

  function onUp() {
    if (step === 'hold' && tracing) {
      setTracing(false);
      // Auto-advance to call after a meaningful trace; if it was just a tap,
      // treat as "skip hold" and go straight to call as well.
      setStep('call');
    } else {
      setTracing(false);
    }
  }

  // SVG path string for hold trace
  const holdPath = holdTrace.length > 1
    ? holdTrace.map((p,i) => `${i?'L':'M'}${(c + p.x*sc).toFixed(1)},${(c - p.y*sc).toFixed(1)}`).join(' ')
    : '';

  // Step-specific UI
  const stepConfig = {
    hold: {
      label: 'Trace your hold',
      hint: 'Drag to trace your wobble path. Release to advance to call. Skip if you don\'t need to record sight movement.',
      color: '#8d9aaa',
    },
    call: {
      label: 'Call your shot',
      hint: 'Tap where the sights were when the trigger broke. Auto-advances to shot. Re-tap to correct.',
      color: '#e8943a',
    },
    shot: {
      label: 'Mark actual impact',
      hint: 'Tap where the round actually hit. Re-tap to correct.',
      color: '#e91e63',
    },
  };
  const cfg = stepConfig[step];

  return (
    <div style={{display:'flex',flexDirection:'column',gap:8}}>

      {/* Step indicator (slow fire only) */}
      {!isRapid && (
        <div style={{display:'flex',gap:5,alignItems:'center'}}>
          {['hold','call','shot'].map((s, i) => {
            const isCur = step === s;
            const isDone =
              (s==='hold' && holdTrace.length > 1) ||
              (s==='call' && callXY) ||
              (s==='shot' && tapXY);
            return (
              <button key={s}
                onClick={()=>setStep(s)}
                style={{
                  flex:1,
                  padding:'7px 6px',
                  borderRadius:5,
                  border:`1.5px solid ${isCur ? stepConfig[s].color : (isDone ? 'var(--green)' : 'var(--bdr)')}`,
                  background: isCur ? `${stepConfig[s].color}22` : 'none',
                  color: isCur ? stepConfig[s].color : (isDone ? 'var(--green)' : 'var(--dim)'),
                  fontFamily:'var(--fm)',fontSize:9,fontWeight:700,
                  letterSpacing:'.05em',cursor:'pointer',
                }}>
                {i+1}. {s.toUpperCase()}{isDone && !isCur ? ' ✓' : ''}
              </button>
            );
          })}
        </div>
      )}
      {isRapid && (
        <div style={{
          padding:'7px 10px',background:'#e8943a22',border:'1.5px solid var(--acc)',
          borderRadius:5,fontFamily:'var(--fm)',fontSize:9,color:'var(--acc)',
          fontWeight:700,letterSpacing:'.08em',textAlign:'center',
        }}>
          RAPID FIRE — TAP TO RECORD HIT
        </div>
      )}

      {/* Hint line */}
      {!isRapid && (
        <div style={{fontFamily:'var(--fm)',fontSize:9,color:cfg.color,lineHeight:1.5,padding:'2px 2px'}}>
          {cfg.hint}
        </div>
      )}

      {/* The interactive target */}
      <svg ref={svgRef} viewBox={`0 0 ${SZ} ${SZ}`}
        style={{
          width:'100%',display:'block',
          background:'#1a1d27',
          border:`1.5px solid ${cfg.color}`,
          borderRadius:9,
          touchAction:'none',
          cursor: step === 'hold' ? 'crosshair' : 'pointer',
        }}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
        onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
      >
        {/* Background fill = outermost ring color */}
        {(() => {
          const o = target.rings[target.rings.length-1];
          const col = o.color || DEFAULT_RING_COLORS[o.score] || '#aaa';
          return <rect x={0} y={0} width={SZ} height={SZ} fill={col}/>;
        })()}

        {/* Rings outside-in */}
        {[...target.rings].reverse().map((r, revIdx) => {
          const fwdIdx = target.rings.length - 1 - revIdx;
          const col = r.color || DEFAULT_RING_COLORS[r.score] || '#aaa';
          const outerCol = fwdIdx < target.rings.length - 1
            ? (target.rings[fwdIdx + 1].color || DEFAULT_RING_COLORS[target.rings[fwdIdx+1].score] || '#aaa')
            : '#0f1117';
          const borderCol = ringBorderColor(col, outerCol);
          return (
            <circle key={r.score} cx={c} cy={c} r={r.diam/2 * sc}
              fill={col} stroke={borderCol} strokeWidth={1}/>
          );
        })}

        {/* MOA reference grid */}
        <MoaGrid SZ={SZ} c={c} sc={sc} yards={yards}/>
        {/* Crosshair at exact center */}
        <line x1={c-8} y1={c} x2={c+8} y2={c} stroke="#ffffff44" strokeWidth={0.6}/>
        <line x1={c} y1={c-8} x2={c} y2={c+8} stroke="#ffffff44" strokeWidth={0.6}/>

        {/* The partner's string, live, on the target you are both shooting.
            Full opacity where your own prior shots are dimmed to 0.35: theirs
            is the new information. Hollow and dashed so it can never be
            mistaken for one of yours, and outside every statistic here. */}
        {(partners || []).flatMap(o => o.stats.pts.map((pt, i) => (
          <RelayImpactMark key={'pp'+o.slot+'-'+i} pt={pt} slot={o.slot} i={i}
            color={o.color} SZ={SZ} c={c} sc={sc} r={5}/>
        )))}

        {/* Prior shots — dimmed */}
        {priorShots && priorShots.map((sh,i) => {
          const p = shotXY(sh, target);
          const ri = target.rings.findIndex(r=>r.score===sh.ring);
          const ringFill = ri>=0 ? (target.rings[ri].color||DEFAULT_RING_COLORS[sh.ring]||'#aaa') : '#0f1117';
          const outline = isLightColor(ringFill) ? '#0a0a0a' : '#ffffff';
          const fill = sh.isSighter ? 'none' : '#e91e63';
          return (
            <g key={sh.id} opacity={0.35}>
              <circle cx={c + p.x*sc} cy={c - p.y*sc} r={4}
                fill={fill}
                stroke={sh.isSighter ? '#4a9eff' : outline}
                strokeWidth={1.2}
                strokeDasharray={sh.isSighter ? '2 1' : undefined}/>
              <text x={c + p.x*sc} y={c - p.y*sc + 2} textAnchor="middle" fill="#ffffffaa" fontSize={4} fontFamily="Space Mono,monospace" fontWeight="700">{shotLabel(priorShots,i)}</text>
            </g>
          );
        })}

        {/* Hold trace — a translucent path */}
        {holdPath && (
          <path d={holdPath} fill="none" stroke="#8d9aaa" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.7}/>
        )}
        {/* Hold trace endpoints */}
        {holdTrace.length > 0 && (
          <circle cx={c + holdTrace[0].x*sc} cy={c - holdTrace[0].y*sc} r={2} fill="#8d9aaa" opacity={0.7}/>
        )}

        {/* Call point — amber crosshair */}
        {callXY && (
          <g>
            <circle cx={c + callXY.x*sc} cy={c - callXY.y*sc} r={6} fill="none" stroke="#e8943a" strokeWidth={1.5} strokeDasharray="2 2"/>
            <line x1={c + callXY.x*sc - 8} y1={c - callXY.y*sc} x2={c + callXY.x*sc + 8} y2={c - callXY.y*sc} stroke="#e8943a" strokeWidth={1}/>
            <line x1={c + callXY.x*sc} y1={c - callXY.y*sc - 8} x2={c + callXY.x*sc} y2={c - callXY.y*sc + 8} stroke="#e8943a" strokeWidth={1}/>
            <text x={c + callXY.x*sc + 9} y={c - callXY.y*sc - 5} fill="#e8943a" fontSize={6} fontFamily="Space Mono,monospace" fontWeight="700">CALL</text>
          </g>
        )}

        {/* Actual shot — solid pink dot, larger when current. Off the rings
            entirely, it's a called miss: red X instead of a scoring dot, so
            it reads unambiguously at a glance (including in bright sun). */}
        {tapXY && (() => {
          const derived = xyToRing(target, tapXY.x, tapXY.y);
          const isMiss = derived.ring === 'M';
          const ri = target.rings.findIndex(r=>r.score===derived.ring);
          const ringFill = ri>=0 ? (target.rings[ri].color||'#aaa') : '#0f1117';
          const outline = isLightColor(ringFill) ? '#0a0a0a' : '#ffffff';
          const dotColor = isSighter ? '#4a9eff' : '#e91e63';
          const mx = c + tapXY.x*sc, my = c - tapXY.y*sc;
          return (
            <g>
              {/* Connecting line from call to shot, if both placed */}
              {callXY && (
                <line
                  x1={c + callXY.x*sc} y1={c - callXY.y*sc}
                  x2={mx}  y2={my}
                  stroke="#e8943a" strokeWidth={0.8} strokeDasharray="1 2" opacity={0.6}/>
              )}
              {isMiss ? (
                <g>
                  <circle cx={mx} cy={my} r={7} fill="none" stroke="#c0392b" strokeWidth={1.6}/>
                  <line x1={mx-4.5} y1={my-4.5} x2={mx+4.5} y2={my+4.5} stroke="#c0392b" strokeWidth={2} strokeLinecap="round"/>
                  <line x1={mx-4.5} y1={my+4.5} x2={mx+4.5} y2={my-4.5} stroke="#c0392b" strokeWidth={2} strokeLinecap="round"/>
                  <text x={mx} y={my+15} textAnchor="middle" fill="#c0392b" fontSize={7} fontFamily="Space Mono,monospace" fontWeight="700">MISS</text>
                </g>
              ) : (
                <>
                  <circle cx={mx} cy={my} r={5}
                    fill={isSighter ? 'none' : dotColor}
                    stroke={outline} strokeWidth={2}
                    strokeDasharray={isSighter ? '2 1' : undefined}/>
                  <text x={mx} y={my + 2} textAnchor="middle" fill="#ffffff" fontSize={4.5} fontFamily="Space Mono,monospace" fontWeight="700">●</text>
                </>
              )}
            </g>
          );
        })()}
      </svg>

      {/* Step nav: clear, skip forward, go back. Auto-advance is the primary flow. */}
      <div style={{display:'flex',gap:6}}>
        {!isRapid && step !== 'hold' && (
          <button
            onClick={() => setStep(step === 'shot' ? 'call' : 'hold')}
            style={{flex:1,background:'none',border:'1px solid var(--bdr)',borderRadius:5,padding:'6px',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer'}}>
            ← back
          </button>
        )}
        <button
          onClick={() => {
            if (step === 'hold') setHoldTrace([]);
            else if (step === 'call') setCallXY(null);
            else if (step === 'shot') setTapXY(null);
          }}
          style={{flex:1,background:'none',border:'1px solid var(--bdr)',borderRadius:5,padding:'6px',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer'}}>
          clear
        </button>
        {!isRapid && step !== 'shot' && (
          <button
            onClick={() => setStep(step === 'hold' ? 'call' : 'shot')}
            style={{flex:1,background:'none',border:`1px solid ${cfg.color}`,borderRadius:5,padding:'6px',fontFamily:'var(--fm)',fontSize:9,color:cfg.color,fontWeight:700,cursor:'pointer'}}>
            skip →
          </button>
        )}
      </div>

      {/* Zoom toolbar */}
      <div style={{display:'flex',gap:5,alignItems:'center',padding:'2px 0'}}>
        <span style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.08em',textTransform:'uppercase',marginRight:5}}>view</span>
        <button onClick={()=>setZoomStep(z=>Math.max(z-1, -baseStepIdx))}
          disabled={effectiveIdx <= Math.max(0, baseStepIdx)}
          style={{
            flex:'0 0 auto',width:32,
            background:'var(--surf2)',
            border:'1px solid var(--bdr)',borderRadius:4,padding:'5px 0',
            fontFamily:'var(--fm)',fontSize:11,
            color: effectiveIdx <= Math.max(0, baseStepIdx) ? 'var(--bdr)' : 'var(--ink)',
            cursor: effectiveIdx <= Math.max(0, baseStepIdx) ? 'default' : 'pointer',
            opacity: effectiveIdx <= Math.max(0, baseStepIdx) ? 0.5 : 1,
            fontWeight:700,
          }}>−</button>
        <button onClick={()=>setZoomStep(z=>Math.min(z+1, totalSteps - 1 - baseStepIdx))}
          disabled={effectiveIdx >= totalSteps - 1}
          style={{
            flex:'0 0 auto',width:32,
            background:'var(--surf2)',
            border:'1px solid var(--bdr)',borderRadius:4,padding:'5px 0',
            fontFamily:'var(--fm)',fontSize:11,
            color: effectiveIdx >= totalSteps - 1 ? 'var(--bdr)' : 'var(--ink)',
            cursor: effectiveIdx >= totalSteps - 1 ? 'default' : 'pointer',
            opacity: effectiveIdx >= totalSteps - 1 ? 0.5 : 1,
            fontWeight:700,
          }}>+</button>
        <button onClick={()=>setZoomStep(0)}
          style={{
            flex:1,
            background:zoomStep===0?'var(--surf2)':'none',
            border:`1px solid ${zoomStep===0?'var(--bdr)':'var(--acc)'}`,
            borderRadius:4,padding:'5px 8px',
            fontFamily:'var(--fm)',fontSize:9,
            color: zoomStep===0 ? 'var(--dim)' : 'var(--acc)',
            cursor:'pointer',
          }}>
          {zoomStep === 0 ? 'auto' : 'reset'}
        </button>
        <span style={{flex:'0 0 auto',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',marginLeft:5}}>
          ±{viewR.toFixed(1)}"
        </span>
      </div>

      {/* Live numbers */}
      {tapXY && (() => {
        const derived = xyToRing(target, tapXY.x, tapXY.y);
        const callDistIn = callXY ? Math.hypot(tapXY.x - callXY.x, tapXY.y - callXY.y) : null;
        return (
          <div style={{background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:5,padding:'8px 11px',fontFamily:'var(--fm)',fontSize:10,color:'var(--ink)',display:'flex',gap:14,flexWrap:'wrap'}}>
            <div><span style={{color:'var(--dim)'}}>shot </span><span style={{color: derived.ring==='M' ? '#c0392b' : '#e91e63',fontWeight:700}}>{derived.ring==='M' ? `MISS @ ${derived.clockH}:${String(derived.clockM).padStart(2,'0')}` : `${derived.ring} @ ${derived.clockH}:${String(derived.clockM).padStart(2,'0')}`}</span></div>
            {callDistIn !== null && (
              <div><span style={{color:'var(--dim)'}}>call err </span><span style={{color:'var(--acc)',fontWeight:700}}>{callDistIn.toFixed(2)}"</span></div>
            )}
            {yards > 0 && (() => {
              // Correction to bring THIS impact to center. Impact right/high ->
              // dial left/down. This is a suggestion read off the grid, not the
              // applied dial — that still lives in the sight-adjustment pad.
              const moaX = inchesToMoa(Math.abs(tapXY.x), yards);
              const moaY = inchesToMoa(Math.abs(tapXY.y), yards);
              const wDir = tapXY.x > 0.001 ? 'L' : tapXY.x < -0.001 ? 'R' : '·';
              const eDir = tapXY.y > 0.001 ? 'D' : tapXY.y < -0.001 ? 'U' : '·';
              return (
                <div style={{flexBasis:'100%',marginTop:2,paddingTop:6,borderTop:'1px solid var(--bdr)',display:'flex',gap:14,flexWrap:'wrap'}}>
                  <span style={{color:'var(--dim)'}}>to center: </span>
                  <span><span style={{color:'#4a9eff',fontWeight:700}}>{moaX.toFixed(2)} MOA {wDir}</span><span style={{color:'var(--dim)'}}> · {Math.round(moaX/MOA_PER_CLICK)} clk</span></span>
                  <span><span style={{color:'var(--acc)',fontWeight:700}}>{moaY.toFixed(2)} MOA {eDir}</span><span style={{color:'var(--dim)'}}> · {Math.round(moaY/MOA_PER_CLICK)} clk</span></span>
                </div>
              );
            })()}
          </div>
        );
      })()}
    </div>
  );
}

/* ── ShotEntry with live target preview ── */
function ShotEntry({ num, target, yards, fireMode, priorShots, lastElev, lastWind, lastRing, dopeSource, onBack, onSave, onDone, getShotCount, partners }) {
  const rings = target.rings.map(r=>r.score);
  const defaultRing = rings.includes(lastRing) ? lastRing : (rings[1]||rings[0]);
  const [inputMode, setInputMode] = useState('tap'); // 'tap' | 'classic'
  const [ring, setRing] = useState(defaultRing);
  const [ringPos, setRingPos] = useState(0.5);
  const [h, setH] = useState(12);
  const [m, setM] = useState(0);
  // Tap-mode coordinates (inches from center; +x right, +y up)
  const [tapXY, setTapXY]   = useState(null); // actual impact
  const [callXY, setCallXY] = useState(null); // sights at trigger break
  const [holdTrace, setHoldTrace] = useState([]); // freehand wobble path
  const [tapStep, setTapStep] = useState('hold'); // 'hold' | 'call' | 'shot'
  const [tracing, setTracing] = useState(false);
  const [elev, setElev] = useState(lastElev);
  const [wind, setWind] = useState(lastWind);
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [showWindCall, setShowWindCall] = useState(false);
  const [windCallMoa, setWindCallMoa] = useState('');
  const [windCallDir, setWindCallDir] = useState('R'); // predicted hold direction
  const [perShotWind, setPerShotWind] = useState('');
  const [perShotWindDir, setPerShotWindDir] = useState(null);
  const [isSighter, setIsSighter] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [lastSavedIdx, setLastSavedIdx] = useState(null);
  const faceRef = useRef(null);
  const tapSvgRef = useRef(null);

  const FACE = 136;
  const angle = ((h%12)+m/60)*30;
  const curRingColor = ringColor(target, ring);

  function getRingRadius(tgt, score, pos) {
    const idx = tgt.rings.findIndex(r=>r.score===score);
    if (idx<0) return 2;
    const oR = tgt.rings[idx].diam/2;
    const iR = idx>0 ? tgt.rings[idx-1].diam/2 : 0;
    return iR + pos*(oR-iR);
  }

  function ringBounds(tgt, score) {
    const idx = tgt.rings.findIndex(r=>r.score===score);
    if (idx<0) return {inner:'center',outer:'edge',iR:'0.00',oR:'0.00'};
    const oR = tgt.rings[idx].diam/2;
    const iR = idx>0 ? tgt.rings[idx-1].diam/2 : 0;
    const prevScore = idx>0 ? tgt.rings[idx-1].score : 'center';
    return {
      inner: idx===0 ? 'center' : `${prevScore}/${score}`,
      outer: idx===tgt.rings.length-1 ? 'outer edge' : `${score}/${tgt.rings[idx+1]?.score}`,
      iR: iR.toFixed(2), oR: oR.toFixed(2)
    };
  }

  function angleFromEvent(e, el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width/2;
    const cy = rect.top + rect.height/2;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - cx, dy = clientY - cy;
    let deg = Math.atan2(dx, -dy) * 180/Math.PI;
    if (deg<0) deg+=360;
    const totalMins = deg/0.5;
    const newH = Math.floor(totalMins/60)%12 || 12;
    const rawM = Math.round((totalMins%60)/5)*5;
    return { h:newH, m:rawM>=60?55:rawM };
  }

  function startDrag(e) { e.preventDefault(); setDragging(true); const p=angleFromEvent(e,faceRef.current); setH(p.h); setM(p.m); }
  function onDrag(e) { if(!dragging) return; e.preventDefault(); const p=angleFromEvent(e,faceRef.current); setH(p.h); setM(p.m); }
  function endDrag() { setDragging(false); }

  function doSave(andNext) {
    let shot;
    if (inputMode === 'tap' && tapXY) {
      const derived = xyToRing(target, tapXY.x, tapXY.y);
      shot = {
        id: uid(),
        ring: derived.ring,
        ringPos: derived.ringPos,
        clockH: derived.clockH,
        clockM: derived.clockM,
        xy: { x: tapXY.x, y: tapXY.y },
        elev, wind, notes, isSighter, ts: Date.now(),
      };
      if (callXY) shot.callXY = { x: callXY.x, y: callXY.y };
      if (holdTrace.length > 1) shot.holdTrace = holdTrace.slice();
    } else {
      shot = {
        id: uid(), ring, ringPos, clockH: h, clockM: m,
        elev, wind, notes, isSighter, ts: Date.now(),
      };
    }
    if (windCallMoa !== '' && !isNaN(parseFloat(windCallMoa))) {
      shot.windCallMoa = parseFloat(windCallMoa);
      shot.windCallDir = windCallDir;
    }
    if (perShotWind !== '' && !isNaN(parseFloat(perShotWind))) {
      shot.perShotWind = parseFloat(perShotWind);
      if (perShotWindDir !== null) shot.perShotWindDir = perShotWindDir;
    }
    onSave(shot);
    if (andNext) {
      setLastSavedIdx((priorShots||[]).length);
      setRingPos(0.5);
      setH(12); setM(0);
      setTapXY(null);
      setCallXY(null);
      setHoldTrace([]);
      setTapStep('hold');
      setNotes('');
      setShowNotes(false);
      setWindCallMoa('');
      setShowWindCall(false);
      // Keep per-shot wind across shots since wind doesn't change between shots seconds apart
      // but reset on Done. If shooter wants different wind, they edit it.
      setIsSighter(false);
    } else {
      onDone();
    }
  }

  const bounds = ringBounds(target, ring);
  const midR = getRingRadius(target, ring, ringPos);
  const ticks = Array.from({length:12},(_,i)=>i*30);

  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="hdr">
          <button className="bback" onClick={onBack}>← back</button>
          <div style={{fontFamily:'var(--fh)',fontSize:15,fontWeight:700}}>
            {(() => {
              const sc = (priorShots||[]).filter(s=>s.isSighter).length + (isSighter?1:0);
              const rc = (priorShots||[]).filter(s=>!s.isSighter).length + (isSighter?0:1);
              return isSighter
                ? `Sighter ${String.fromCharCode(64+sc)}`
                : `Shot ${rc}`;
            })()}
          </div>
          <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)'}}>
            E{fmtMoaSigned(elev)} / W{fmtMoaSigned(wind)} MOA
          </div>
        </div>

        <div className="content" style={{paddingBottom:86}}>

          {/* Input mode toggle — zone (shape) targets are tap-only; ring+clock
              coordinates have no meaningful mapping onto non-concentric zones. */}
          <div style={{padding:'10px 13px 4px',display:'flex',gap:5}}>
            {(target.zones?.length
              ? [['tap','Tap to place','Tap target to place hold/call/shot']]
              : [
                ['tap','Tap to place','Tap target to place hold/call/shot'],
                ['classic','Ring + clock','Pick ring & clock direction'],
              ]).map(([m,lbl,sub]) => (
              <button key={m}
                onClick={()=>setInputMode(m)}
                style={{
                  flex:1,padding:'7px 9px',borderRadius:5,
                  border:`1.5px solid ${inputMode===m?'var(--acc)':'var(--bdr)'}`,
                  background: inputMode===m?'var(--acc)22':'none',
                  color: inputMode===m?'var(--acc)':'var(--dim)',
                  fontFamily:'var(--fm)',fontSize:10,fontWeight:700,
                  cursor:'pointer',textAlign:'left',
                }}>
                <div style={{fontSize:10}}>{lbl}</div>
                <div style={{fontSize:8,fontWeight:400,opacity:0.8,marginTop:1}}>{sub}</div>
              </button>
            ))}
          </div>

          {/* Tap-to-place input */}
          {inputMode === 'tap' && (
            <div style={{padding:'8px 13px 4px'}}>
              <TapInput
                target={target}
                yards={yards}
                fireMode={fireMode}
                priorShots={priorShots || []}
                tapXY={tapXY} setTapXY={setTapXY}
                callXY={callXY} setCallXY={setCallXY}
                holdTrace={holdTrace} setHoldTrace={setHoldTrace}
                step={tapStep} setStep={setTapStep}
                tracing={tracing} setTracing={setTracing}
                isSighter={isSighter}
                partners={partners}
              />
            </div>
          )}

          {/* Classic ring + clock inputs */}
          {inputMode === 'classic' && <>

          {/* Ring selector */}
          <div style={{padding:'12px 13px 4px'}}>
            <div className="lbl" style={{marginBottom:8}}>Ring</div>
            <div className="scoresel">
              {rings.map(r=>{
                const col = ringColor(target, r);
                const textCol = isLightColor(col) ? col : 'var(--ink)';
                return (
                  <button key={r}
                    className={`sbtn ${ring===r?'on':''}`}
                    style={{
                      color: textCol,
                      borderColor: ring===r ? (isLightColor(col) ? col : 'var(--ink)') : 'var(--bdr)',
                      boxShadow: ring===r ? `0 0 0 1px ${isLightColor(col) ? col : 'var(--ink)'}` : 'none',
                      borderLeft: `4px solid ${col}`,
                    }}
                    onClick={()=>{ setRing(r); setRingPos(0.5); }}
                  >{r}</button>
                );
              })}
            </div>
          </div>

          {/* Sub-ring placement */}
          <div style={{padding:'6px 13px 10px'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <div className="lbl">Placement within ring</div>
              <div style={{fontFamily:'var(--fm)',fontSize:11,color:'var(--acc)',fontWeight:700}}>{midR.toFixed(3)}" · {inchesToMoa(midR,100).toFixed(2)} MOA/100yd</div>
            </div>
            <input type="range" min={0} max={1} step={0.01} value={ringPos}
              onChange={e=>setRingPos(+e.target.value)}
              style={{width:'100%',accentColor: isLightColor(curRingColor) ? curRingColor : 'var(--acc)'}}/>
            <div style={{display:'flex',justifyContent:'space-between',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',marginTop:3}}>
              <span>← {bounds.inner} (r={bounds.iR}")</span>
              <span>{bounds.outer} (r={bounds.oR}") →</span>
            </div>
          </div>

          {/* Clock face — classic mode only */}
          <div style={{padding:'4px 13px 10px',display:'flex',gap:16,alignItems:'flex-start'}}>

            {/* Clock */}
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:5,flexShrink:0}}>
              <div className="lbl" style={{alignSelf:'flex-start'}}>Direction</div>
              <div
                ref={faceRef}
                className="ckface"
                style={{
                  width:FACE, height:FACE, cursor:'crosshair',
                  userSelect:'none', WebkitUserSelect:'none', touchAction:'none',
                  boxShadow: dragging ? '0 0 0 2.5px var(--acc)' : 'none',
                  transition:'box-shadow .1s'
                }}
                onMouseDown={startDrag} onMouseMove={onDrag} onMouseUp={endDrag} onMouseLeave={endDrag}
                onTouchStart={startDrag} onTouchMove={onDrag} onTouchEnd={endDrag}
              >
                <svg width={FACE} height={FACE} style={{position:'absolute',inset:0,pointerEvents:'none'}}>
                  {ticks.map(deg => {
                    const isCardinal = deg % 90 === 0;
                    const isHour    = deg % 30 === 0;
                    const len  = isCardinal ? 9 : isHour ? 6 : 4;
                    const r1   = FACE/2 - 3;
                    const r2   = r1 - len;
                    const rad  = (deg - 90) * Math.PI / 180;
                    const cx   = FACE/2, cy = FACE/2;
                    return (
                      <line key={deg}
                        x1={cx + r1*Math.cos(rad)} y1={cy + r1*Math.sin(rad)}
                        x2={cx + r2*Math.cos(rad)} y2={cy + r2*Math.sin(rad)}
                        stroke={isCardinal ? 'var(--ink)' : 'var(--bdr)'}
                        strokeWidth={isCardinal ? 1.5 : 0.8}
                        strokeLinecap="round"
                      />
                    );
                  })}
                  {/* Hour number labels at 12, 3, 6, 9 */}
                  {[{lh:12,deg:0},{lh:3,deg:90},{lh:6,deg:180},{lh:9,deg:270}].map(({lh,deg})=>{
                    const rad = (deg - 90) * Math.PI / 180;
                    const r   = FACE/2 - 17;
                    return (
                      <text key={lh}
                        x={FACE/2 + r*Math.cos(rad)}
                        y={FACE/2 + r*Math.sin(rad) + 3.5}
                        textAnchor="middle"
                        fill="var(--dim)"
                        fontSize={9}
                        fontFamily="Space Mono,monospace"
                      >{lh}</text>
                    );
                  })}
                  {/* Hand */}
                  <line
                    x1={FACE/2} y1={FACE/2}
                    x2={FACE/2 + (FACE/2-14)*Math.sin(angle*Math.PI/180)}
                    y2={FACE/2 - (FACE/2-14)*Math.cos(angle*Math.PI/180)}
                    stroke="var(--acc)" strokeWidth={2} strokeLinecap="round"
                  />
                  <circle cx={FACE/2} cy={FACE/2} r={3} fill="var(--acc)"/>
                </svg>
              </div>
              {/* Compact dropdowns */}
              <div style={{display:'flex',gap:5,alignItems:'center'}}>
                <select style={{fontFamily:'var(--fm)',fontSize:11,background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:4,padding:'3px 4px',color:'var(--ink)',cursor:'pointer'}}
                  value={h} onChange={e=>setH(+e.target.value)}>
                  {[12,1,2,3,4,5,6,7,8,9,10,11].map(v=><option key={v} value={v}>{v}</option>)}
                </select>
                <span style={{fontFamily:'var(--fm)',fontSize:11,color:'var(--dim)'}}>:</span>
                <select style={{fontFamily:'var(--fm)',fontSize:11,background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:4,padding:'3px 4px',color:'var(--ink)',cursor:'pointer'}}
                  value={m} onChange={e=>setM(+e.target.value)}>
                  {[0,5,10,15,20,25,30,35,40,45,50,55].map(v=><option key={v} value={v}>{String(v).padStart(2,'0')}</option>)}
                </select>
              </div>
              <div style={{fontFamily:'var(--fm)',fontSize:12,color:'var(--acc)',fontWeight:700}}>{h}:{String(m).padStart(2,'0')}</div>
            </div>
          </div>

          {/* Live target preview — classic mode only */}
          <div style={{padding:'0 13px 8px'}}>
            <div className="lbl" style={{marginBottom:6}}>Live preview</div>
            <TargetPreview
              target={target}
              yards={yards}
              ring={ring}
              ringPos={ringPos}
              clockH={h}
              clockM={m}
              priorShots={priorShots || []}
              lastSavedIdx={lastSavedIdx}
              isSighter={isSighter}
              partners={partners}
            />
          </div>

          </>}

          {/* Shared inputs: elevation/windage/sighter/notes/wind-call (both modes) */}
          <div style={{padding:'4px 13px 10px',display:'flex',flexDirection:'column',gap:10}}>

            {/* Sight adjustment pad — 4 directional buttons + center readout */}
            <div>
              {/* DOPE provenance — only on shot #1 when the starting dial came
                  from a prior confirmed zero, so a nonzero start is explained
                  rather than a silent surprise. Disappears once any shot is
                  saved (the in-session last shot becomes the source). */}
              {dopeSource && (elev === lastElev && wind === lastWind
                ? <div style={{
                    marginBottom:6,padding:'6px 9px',borderRadius:5,
                    background:'#00708c14',border:'1px solid #00708c55',
                    fontFamily:'var(--fm)',fontSize:9,color:'#00708c',lineHeight:1.5,
                  }}>
                    Starting dial from DOPE: E{fmtMoaSigned(dopeSource.elev)} / W{fmtMoaSigned(dopeSource.wind)} MOA
                    {dopeSource.date ? ` · confirmed ${dopeSource.date}` : ''}. Adjust below if conditions differ.
                  </div>
                : <div style={{
                    marginBottom:6,padding:'5px 9px',borderRadius:5,
                    background:'var(--surf2)',border:'1px dashed var(--bdr)',
                    fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',lineHeight:1.5,
                  }}>
                    Adjusted from DOPE start (was E{fmtMoaSigned(dopeSource.elev)} / W{fmtMoaSigned(dopeSource.wind)}).
                  </div>
              )}
              <div className="lbl" style={{marginBottom:5,display:'flex',justifyContent:'space-between',alignItems:'baseline'}}>
                <span>Sight adjustment</span>
                <span style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',textTransform:'none',letterSpacing:0}}>tap to bump</span>
              </div>
              <div style={{
                display:'grid',
                gridTemplateColumns:'1fr 1fr 1fr',
                gridTemplateRows:'42px 42px 42px',
                gap:4,
                background:'var(--surf2)',
                border:'1px solid var(--bdr)',
                borderRadius:7,
                padding:5,
              }}>
                <div/>
                <button
                  onClick={()=>setElev(e=>e+1)}
                  style={{
                    background:'var(--surf)',
                    border:'1.5px solid var(--bdr)',
                    borderRadius:5,
                    color:'var(--ink)',
                    fontFamily:'var(--fh)',fontSize:14,fontWeight:700,
                    cursor:'pointer',
                    display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:0,
                  }}>
                  <span style={{fontSize:18,lineHeight:1}}>↑</span>
                  <span style={{fontSize:8,color:'var(--dim)',fontFamily:'var(--fm)',letterSpacing:'.05em'}}>UP</span>
                </button>
                <div/>
                <button
                  onClick={()=>setWind(w=>w-1)}
                  style={{
                    background:'var(--surf)',
                    border:'1.5px solid var(--bdr)',
                    borderRadius:5,
                    color:'var(--ink)',
                    fontFamily:'var(--fh)',fontSize:14,fontWeight:700,
                    cursor:'pointer',
                    display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:0,
                  }}>
                  <span style={{fontSize:18,lineHeight:1}}>←</span>
                  <span style={{fontSize:8,color:'var(--dim)',fontFamily:'var(--fm)',letterSpacing:'.05em'}}>L</span>
                </button>
                <div style={{
                  background:'var(--bg)',
                  border:'1px solid var(--bdr)',
                  borderRadius:5,
                  display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
                  fontFamily:'var(--fm)',fontSize:10,color:'var(--ink)',
                }}>
                  <div style={{color:'var(--acc)',fontWeight:700}}>E{fmtMoaSigned(elev)}</div>
                  <div style={{color:'#4a9eff',fontWeight:700,marginTop:1}}>W{fmtMoaSigned(wind)}</div>
                  <div style={{color:'var(--dim)',fontSize:7,letterSpacing:'.08em',marginTop:1}}>MOA</div>
                </div>
                <button
                  onClick={()=>setWind(w=>w+1)}
                  style={{
                    background:'var(--surf)',
                    border:'1.5px solid var(--bdr)',
                    borderRadius:5,
                    color:'var(--ink)',
                    fontFamily:'var(--fh)',fontSize:14,fontWeight:700,
                    cursor:'pointer',
                    display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:0,
                  }}>
                  <span style={{fontSize:18,lineHeight:1}}>→</span>
                  <span style={{fontSize:8,color:'var(--dim)',fontFamily:'var(--fm)',letterSpacing:'.05em'}}>R</span>
                </button>
                <div/>
                <button
                  onClick={()=>setElev(e=>e-1)}
                  style={{
                    background:'var(--surf)',
                    border:'1.5px solid var(--bdr)',
                    borderRadius:5,
                    color:'var(--ink)',
                    fontFamily:'var(--fh)',fontSize:14,fontWeight:700,
                    cursor:'pointer',
                    display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:0,
                  }}>
                  <span style={{fontSize:18,lineHeight:1}}>↓</span>
                  <span style={{fontSize:8,color:'var(--dim)',fontFamily:'var(--fm)',letterSpacing:'.05em'}}>DOWN</span>
                </button>
                <div/>
              </div>
              {/* Reset / multi-click options */}
              <div style={{display:'flex',gap:5,marginTop:5}}>
                <button onClick={()=>{setElev(0);setWind(0);}}
                  style={{flex:1,background:'none',border:'1px solid var(--bdr)',borderRadius:4,padding:'4px',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer'}}>
                  zero
                </button>
                {dopeSource && (
                  <button onClick={()=>{setElev(dopeSource.elev);setWind(dopeSource.wind);}}
                    style={{flex:1,background:'none',border:'1px solid #00708c88',borderRadius:4,padding:'4px',fontFamily:'var(--fm)',fontSize:9,color:'#00708c',cursor:'pointer'}}>
                    dope
                  </button>
                )}
                <button onClick={()=>{setElev(e=>e+4);}} style={{flex:1,background:'none',border:'1px solid var(--bdr)',borderRadius:4,padding:'4px',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer'}}>+1↑</button>
                <button onClick={()=>{setElev(e=>e-4);}} style={{flex:1,background:'none',border:'1px solid var(--bdr)',borderRadius:4,padding:'4px',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer'}}>+1↓</button>
                <button onClick={()=>{setWind(w=>w-4);}} style={{flex:1,background:'none',border:'1px solid var(--bdr)',borderRadius:4,padding:'4px',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer'}}>+1←</button>
                <button onClick={()=>{setWind(w=>w+4);}} style={{flex:1,background:'none',border:'1px solid var(--bdr)',borderRadius:4,padding:'4px',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer'}}>+1→</button>
              </div>
            </div>

            {/* Streamlined wind: single row with speed + clock direction + collapsible hold call */}
            {fireMode !== 'Rapid' && (
            <div>
              <div className="lbl" style={{marginBottom:5,display:'flex',justifyContent:'space-between',alignItems:'baseline'}}>
                <span>Wind <span style={{textTransform:'none',letterSpacing:0,color:'var(--dim)',fontWeight:400}}>· clock = direction FROM</span></span>
                <span style={{fontFamily:'var(--fm)',fontSize:9,color:perShotWind!==''&&perShotWindDir!==null?'#4a9eff':'var(--dim)',textTransform:'none',letterSpacing:0,fontWeight:700}}>
                  {perShotWind!=='' && perShotWindDir!==null
                    ? `${perShotWind}mph @ ${perShotWindDir}`
                    : 'tap to set'}
                </span>
              </div>

              {/* Flag angle presets — visual representation of how shooters actually read wind at the line */}
              <div style={{display:'flex',gap:4,marginBottom:5,flexWrap:'wrap'}}>
                {[
                  {v:'0',  angle:0,   lbl:'limp'},
                  {v:'3',  angle:30,  lbl:'3'},
                  {v:'5',  angle:45,  lbl:'5'},
                  {v:'8',  angle:60,  lbl:'8'},
                  {v:'10', angle:75,  lbl:'10'},
                  {v:'15', angle:90,  lbl:'15+'},
                ].map(p => {
                  const sel = String(perShotWind) === p.v;
                  // Flag pivots at top of pole, angle measured from vertical (down).
                  // angle=0 means flag hangs straight down. angle=90 means horizontal.
                  const rad = (p.angle) * Math.PI / 180;
                  // Pole top at (8, 4), flag extends in -y direction (down) when limp
                  const flagLen = 11;
                  const tipX = 8 + flagLen * Math.sin(rad);
                  const tipY = 4 + flagLen * Math.cos(rad);
                  // Triangle flag: tip, plus two base points along the pole
                  const baseAY = 4 + 1;
                  const baseBY = 4 + 5;
                  return (
                    <button key={p.v} onClick={()=>setPerShotWind(p.v)}
                      title={`Flag at ${p.angle}° ≈ ${p.v} mph`}
                      style={{
                        flex:1,minWidth:0,
                        padding:'5px 4px 4px',
                        borderRadius:5,
                        border:`1.5px solid ${sel?'#4a9eff':'var(--bdr)'}`,
                        background: sel?'#4a9eff22':'var(--surf2)',
                        color: sel?'#4a9eff':'var(--dim)',
                        fontFamily:'var(--fm)',fontSize:8,fontWeight:700,
                        cursor:'pointer',
                        display:'flex',flexDirection:'column',alignItems:'center',gap:2,
                      }}>
                      <svg viewBox="0 0 24 22" width={22} height={20} style={{display:'block'}}>
                        {/* Pole */}
                        <line x1={8} y1={2} x2={8} y2={20} stroke={sel?'#4a9eff':'var(--dim)'} strokeWidth={1.2} strokeLinecap="round"/>
                        {/* Flag triangle */}
                        <path d={`M 8 ${baseAY} L ${tipX.toFixed(1)} ${tipY.toFixed(1)} L 8 ${baseBY} Z`}
                          fill={sel?'#4a9eff':'var(--ink)'}
                          opacity={p.angle===0?0.5:0.9}/>
                      </svg>
                      <span>{p.lbl}</span>
                    </button>
                  );
                })}
              </div>

              {/* Speed preset chips — one tap to set band, with a custom field for outliers */}
              <div style={{display:'flex',gap:4,marginBottom:6,flexWrap:'wrap'}}>
                {[
                  {v:'0',  lbl:'calm'},
                  {v:'3',  lbl:'3'},
                  {v:'5',  lbl:'5'},
                  {v:'8',  lbl:'8'},
                  {v:'10', lbl:'10'},
                  {v:'15', lbl:'15'},
                  {v:'20', lbl:'20'},
                ].map(p => {
                  const sel = String(perShotWind) === p.v;
                  return (
                    <button key={p.v} onClick={()=>setPerShotWind(p.v)}
                      style={{
                        flex:1,minWidth:0,
                        padding:'8px 4px',
                        borderRadius:5,
                        border:`1.5px solid ${sel?'#4a9eff':'var(--bdr)'}`,
                        background: sel?'#4a9eff22':'var(--surf2)',
                        color: sel?'#4a9eff':'var(--ink)',
                        fontFamily:'var(--fm)',fontSize:10,fontWeight:700,
                        cursor:'pointer',
                      }}>
                      {p.lbl}
                    </button>
                  );
                })}
                <input type="number" min="0" step="0.5"
                  value={['0','3','5','8','10','15','20'].includes(String(perShotWind)) ? '' : perShotWind}
                  onChange={e=>setPerShotWind(e.target.value)}
                  placeholder="·"
                  style={{
                    width:42,
                    padding:'8px 6px',
                    borderRadius:5,
                    border:`1.5px solid ${perShotWind && !['0','3','5','8','10','15','20'].includes(String(perShotWind)) ? '#4a9eff' : 'var(--bdr)'}`,
                    background:'var(--surf2)',
                    color: perShotWind && !['0','3','5','8','10','15','20'].includes(String(perShotWind)) ? '#4a9eff' : 'var(--ink)',
                    fontFamily:'var(--fm)',fontSize:10,fontWeight:700,
                    textAlign:'center',outline:'none',
                  }}/>
              </div>

              {/* Direction clock — single SVG, click anywhere to set */}
              <div style={{
                display:'flex',gap:8,alignItems:'center',
                background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:7,padding:'7px 9px',
              }}>
                <div style={{flex:1,display:'flex',justifyContent:'center'}}>
                  <svg viewBox="0 0 60 60" width={64} height={64} style={{cursor:'pointer'}}
                    onClick={(e)=>{
                      const rect = e.currentTarget.getBoundingClientRect();
                      const cx = rect.left + rect.width/2;
                      const cy = rect.top + rect.height/2;
                      const dx = e.clientX - cx;
                      const dy = e.clientY - cy;
                      const ang = Math.atan2(dx, -dy) * 180/Math.PI;
                      const a = ((ang % 360) + 360) % 360;
                      let h = Math.round(a / 30);
                      if (h === 0) h = 12;
                      setPerShotWindDir(h);
                    }}>
                    <circle cx={30} cy={30} r={26} fill="var(--bg)" stroke="var(--bdr)" strokeWidth={1}/>
                    {Array.from({length:12},(_,i)=>{
                      const deg = i*30;
                      const isCardinal = i%3===0;
                      const len = isCardinal ? 5 : 3;
                      const r1 = 25;
                      const r2 = r1 - len;
                      const rad = (deg-90) * Math.PI/180;
                      return (
                        <line key={i}
                          x1={30 + r1*Math.cos(rad)} y1={30 + r1*Math.sin(rad)}
                          x2={30 + r2*Math.cos(rad)} y2={30 + r2*Math.sin(rad)}
                          stroke={isCardinal ? 'var(--ink)' : 'var(--bdr)'}
                          strokeWidth={isCardinal ? 1.2 : 0.6}/>
                      );
                    })}
                    {[{lh:12,deg:0},{lh:3,deg:90},{lh:6,deg:180},{lh:9,deg:270}].map(({lh,deg})=>{
                      const rad = (deg-90)*Math.PI/180;
                      const r = 12;
                      return (
                        <text key={lh}
                          x={30 + r*Math.cos(rad)}
                          y={30 + r*Math.sin(rad) + 2.5}
                          textAnchor="middle"
                          fill="var(--dim)"
                          fontSize={6}
                          fontFamily="Space Mono,monospace">{lh}</text>
                      );
                    })}
                    {perShotWindDir !== null && (() => {
                      const ang = perShotWindDir * 30;
                      const rad = (ang - 90) * Math.PI/180;
                      return (
                        <>
                          <line x1={30} y1={30}
                            x2={30 + 22*Math.cos(rad)} y2={30 + 22*Math.sin(rad)}
                            stroke="#4a9eff" strokeWidth={1.8} strokeLinecap="round"/>
                          <circle cx={30} cy={30} r={2.5} fill="#4a9eff"/>
                        </>
                      );
                    })()}
                  </svg>
                </div>

                {/* Quick cardinals for one-tap direction without aiming at the clock.
                    Convention (matches the clock and every wind chart): the hour
                    is the direction the wind is FROM, shooter facing 12. So a
                    3 o'clock wind comes from the right and pushes shots LEFT.
                    Pre-Perry these labels had the arrows backwards ("3 R→"),
                    implying blow-direction instead of from-direction. */}
                <div style={{flex:1,display:'grid',gridTemplateColumns:'1fr 1fr',gap:3}}>
                  {[
                    {h:12, lbl:'12 head'},
                    {h:3,  lbl:'3 R→L'},
                    {h:9,  lbl:'9 L→R'},
                    {h:6,  lbl:'6 tail'},
                  ].map(({h, lbl})=>{
                    const sel = perShotWindDir === h;
                    return (
                      <button key={h} onClick={()=>setPerShotWindDir(h)}
                        style={{
                          padding:'7px 4px',borderRadius:4,
                          border:`1.5px solid ${sel?'#4a9eff':'var(--bdr)'}`,
                          background: sel?'#4a9eff22':'var(--surf)',
                          color: sel?'#4a9eff':'var(--dim)',
                          fontFamily:'var(--fm)',fontSize:9,fontWeight:700,
                          cursor:'pointer',
                        }}>{lbl}</button>
                    );
                  })}
                </div>

                {/* Clear button */}
                {(perShotWind !== '' || perShotWindDir !== null) && (
                  <button onClick={()=>{setPerShotWind('');setPerShotWindDir(null);}}
                    style={{
                      flex:'0 0 auto',background:'none',border:'1px solid var(--bdr)',borderRadius:4,
                      padding:'4px 7px',
                      fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer',
                    }}>×</button>
                )}
              </div>

              {/* Hold call expander, inline below */}
              <button onClick={()=>setShowWindCall(v=>!v)}
                style={{
                  width:'100%',marginTop:5,
                  background:'none',
                  border:`1px dashed ${showWindCall||windCallMoa?'#4a9eff':'var(--bdr)'}`,
                  borderRadius:5,padding:'5px 9px',
                  fontFamily:'var(--fm)',fontSize:9,
                  color:showWindCall||windCallMoa?'#4a9eff':'var(--dim)',
                  cursor:'pointer',textAlign:'left',
                }}>
                {showWindCall
                  ? '− hold call'
                  : (windCallMoa
                      ? `✓ hold: ${windCallMoa} MOA ${windCallDir}`
                      : '+ predicted hold (optional)')}
              </button>
              {showWindCall && (
                <div style={{
                  background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:5,
                  padding:'7px 9px',marginTop:4,
                  display:'flex',gap:6,alignItems:'center',
                }}>
                  <input type="number" step="0.1" value={windCallMoa}
                    onChange={e=>setWindCallMoa(e.target.value)}
                    placeholder="0.0"
                    style={{
                      flex:1,background:'transparent',border:'none',
                      fontFamily:'var(--fm)',fontSize:12,color:'var(--ink)',
                      outline:'none',padding:'2px 4px',
                    }}
                    autoFocus/>
                  <span style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>MOA</span>
                  <div style={{display:'flex',gap:3}}>
                    {['L','R'].map(d=>(
                      <button key={d} onClick={()=>setWindCallDir(d)}
                        style={{
                          padding:'4px 10px',borderRadius:4,
                          border:`1.5px solid ${windCallDir===d?'#4a9eff':'var(--bdr)'}`,
                          background:windCallDir===d?'#4a9eff22':'none',
                          color:windCallDir===d?'#4a9eff':'var(--dim)',
                          fontFamily:'var(--fm)',fontSize:10,fontWeight:700,cursor:'pointer',
                        }}>{d}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            )}

            <div style={{display:'flex',gap:6}}>
              <button onClick={()=>setIsSighter(v=>!v)}
                style={{
                  flex:1,
                  border:`1.5px solid ${isSighter?'#4a9eff':'var(--bdr)'}`,
                  borderRadius:5,padding:'7px 10px',
                  fontFamily:'var(--fm)',fontSize:10,
                  color:isSighter?'#4a9eff':'var(--dim)',
                  cursor:'pointer',textAlign:'center',
                  background:isSighter?'#4a9eff18':'none',
                }}>
                {isSighter ? '● Sighter' : '○ Sighter'}
              </button>
              <button onClick={()=>setShowNotes(v=>!v)}
                style={{flex:1,background:'none',border:'1px dashed var(--bdr)',borderRadius:5,padding:'7px 10px',fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)',cursor:'pointer',textAlign:'left'}}>
                {showNotes ? '− note' : '+ note'}
              </button>
            </div>
            {showNotes && (
              <input className="inp" value={notes} onChange={e=>setNotes(e.target.value)}
                placeholder="call, hold, wind..." style={{fontSize:12}} autoFocus/>
            )}
          </div>

        </div>

        {/* Sticky bottom action bar */}
        <div className="shotbar">
          <button className="bgreen" style={{flex:2,fontSize:14}} onClick={()=>doSave(true)}>
            Log &amp; next →
          </button>
          <button className="bprim" style={{flex:1,fontSize:12}} onClick={()=>doSave(false)}>
            Log &amp; done
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Analytics ── */

// Stable colour assignment per position name. Returns CSS colour string.
const POSITION_COLORS = {
  'Prone':       '#3db87a', // green — most stable position visually mirrors low-spread expectation
  'Sitting':     '#4a9eff', // blue
  'Kneeling':    '#b87adb', // purple
  'Standing':    '#e8943a', // amber — the high-variance offhand line is the "headline"
  'Two-hand':    '#2e8a9e', // teal — was #3db87a, identical to Prone; distinct hue+lightness from all others here
  'Strong-hand': '#a0685c', // brown — was #e8943a, identical to Standing
  'Weak-hand':   '#f06060',
  'Bench':       '#8d9aaa', // grey-blue (rested = baseline)
  'Unsupported': '#d4af37',
  'Unspecified': '#7a7f96', // dim
};
function positionColor(p) { return POSITION_COLORS[p] || '#7a7f96'; }

// Course-of-fire ordering (stability order), not alphabetical: prone → sitting →
// kneeling → standing for rifle, then pistol holds, then rests, unspecified last.
const POSITION_ORDER = ['Prone','Sitting','Kneeling','Standing','Two-hand','Strong-hand','Weak-hand','Bench','Unsupported','Unspecified'];
function posRank(p) { const i = POSITION_ORDER.indexOf(p); return i === -1 ? POSITION_ORDER.length : i; }

/* Look up the confirmed zero (last record shot's elev/wind) for a given
 * firearm × range location × distance × position, across all sessions. Uses
 * the exact same grouping key as the DOPE tab so "what DOPE tab shows for
 * this slot" and "what a new session gets pre-filled with" never disagree.
 * Used to default a session's first shot's sight setting to the zero you
 * already converged to, instead of always starting from a blank 0/0 and
 * making the shooter re-dial from scratch every session.
 * Returns null if there's no prior match, or the match has nothing dialed
 * (all-zero elev/wind — "no dope logged") worth carrying forward.
 */
function findConfirmedZero(sessions, { rifleId, location, yards, position }, excludeSessionId) {
  const loc = (location||'').trim() || 'Unspecified location';
  const pos = (position||'').trim() || 'Unspecified';
  const matches = (sessions||[])
    .filter(s => s.id !== excludeSessionId)
    .filter(s => (s.rifleId||'') === (rifleId||''))
    .filter(s => ((s.rangeLocation||'').trim() || 'Unspecified location') === loc)
    .filter(s => (Number(s.rangeYards)||0) === (Number(yards)||0))
    .filter(s => ((s.position||'').trim() || 'Unspecified') === pos)
    .filter(s => (s.shots?.length||0) >= 1)
    .sort((a,b) => (b.ts||0) - (a.ts||0)); // newest first
  if (!matches.length) return null;
  const s = matches[0];
  const rec = (s.shots||[]).filter(sh=>!sh.isSighter);
  const pool = rec.length ? rec : s.shots; // fall back to sighters if that's all there is
  const last = pool[pool.length-1];
  if (!last) return null;
  if (!(last.elev||0) && !(last.wind||0)) return null; // nothing dialed — blank start is the honest default
  return { elev: last.elev||0, wind: last.wind||0, date: s.date||'', name: s.name||'' };
}

/* DOPE tab — persistent confirmed-zero table: the dialed sight setting per
 * firearm × range location × distance, with prior zeros for drift tracking.
 *
 * "Confirmed zero" for a session = the LAST record shot's elev/wind. That's the
 * setting you converged to (you adjust toward zero; the final dial is the come-up
 * that produced your last group). Settings are stored as integer turret CLICKS
 * and displayed as MOA via the global MOA_PER_CLICK (0.25). There is no
 * per-firearm click value yet — if a 1/8-MOA optic ever enters the stable,
 * that constant must become a firearm field threaded through fmtMoaSigned.
 */
function DopeTab({ sessions, firearms, getTarget }) {
  const [open, setOpen] = useState(() => new Set());
  const [cardText, setCardText] = useState(null);
  const firearmName = id => (firearms.find(f=>f.id===id)?.name) || (id ? 'Unknown firearm' : 'Unspecified firearm');

  // One entry per session that has at least one shot.
  const entries = sessions
    .filter(s => (s.shots?.length||0) >= 1)
    .map(s => {
      const rec = (s.shots||[]).filter(sh=>!sh.isSighter);
      const pool = rec.length ? rec : s.shots;        // fall back to sighters if that's all there is
      const last = pool[pool.length-1] || {};
      const elevs = pool.map(sh=>sh.elev||0), winds = pool.map(sh=>sh.wind||0);
      const moved = (Math.min(...elevs)!==Math.max(...elevs)) || (Math.min(...winds)!==Math.max(...winds));
      const noDope = elevs.every(v=>v===0) && winds.every(v=>v===0);
      const tgt = getTarget(s.targetId);
      const a = (rec.length>=2) ? analytics(s.shots, tgt, s.rangeYards) : null;
      const ammo = (s.ammoDesc||'').trim() || (s.ammoLot ? `lot ${s.ammoLot}` : '');
      return {
        sid: s.id, rifleId: s.rifleId||'', location: (s.rangeLocation||'').trim() || 'Unspecified location',
        position: (s.position||'').trim() || 'Unspecified',
        yards: Number(s.rangeYards)||0, date: s.date||'', ts: s.ts||0,
        elev: last.elev||0, wind: last.wind||0, moved, noDope,
        temp: s.temp||'', lighting: s.lighting||'', ammo,
        mrMoa: a ? a.mrMoa : null, n: rec.length,
      };
    });

  // Group: firearm → location → distance × position. A consistent cant differs
  // by position (offhand canted one way, sitting often the other), so each
  // position is its own zero slot — same distance, different hold, different zero.
  const cells = {};
  entries.forEach(e => {
    const key = `${e.rifleId}|${e.location}|${e.yards}|${e.position}`;
    (cells[key] ||= { rifleId:e.rifleId, location:e.location, yards:e.yards, position:e.position, sessions:[] }).sessions.push(e);
  });
  Object.values(cells).forEach(c => c.sessions.sort((a,b)=>b.ts-a.ts)); // newest first

  // Order cells: firearm name, then location, then distance descending.
  const ordered = Object.entries(cells)
    .map(([key,c]) => ({ key, ...c, fname: firearmName(c.rifleId) }))
    .sort((a,b)=> a.fname.localeCompare(b.fname) || a.location.localeCompare(b.location) || b.yards - a.yards || posRank(a.position) - posRank(b.position));

  // Re-group ordered cells under firearm → location headers for rendering.
  const byFirearm = {};
  ordered.forEach(c => {
    (byFirearm[c.fname] ||= {});
    (byFirearm[c.fname][c.location] ||= []).push(c);
  });

  if (!ordered.length) return (
    <div className="empty">
      <div className="et">No DOPE yet</div>
      <div className="es">Log a session with a firearm, range location, distance, and position — your confirmed zero (last shot's sight setting) lands here, split by position so a canted offhand zero stays separate from sitting or prone.</div>
    </div>
  );

  const Zero = ({ e, faded }) => (
    <span style={{fontFamily:'var(--fm)',fontSize:13,fontWeight:700,opacity:faded?0.6:1}}>
      {e.noDope ? <span style={{color:'var(--dim)',fontWeight:400,fontSize:11}}>no dial logged</span> : <>
        <span style={{color:'var(--acc)'}}>E {fmtMoaSigned(e.elev)}</span>
        <span style={{color:'var(--dim)',fontWeight:400}}> {e.elev>0?'↑':e.elev<0?'↓':'·'}  </span>
        <span style={{color:'#4a9eff'}}>W {fmtMoaSigned(e.wind)}</span>
        <span style={{color:'var(--dim)',fontWeight:400}}> {e.wind>0?'→':e.wind<0?'←':'·'}</span>
      </>}
    </span>
  );

  return (
    <div style={{paddingBottom:20}}>
      <div style={{margin:'12px 13px 4px',display:'flex',alignItems:'flex-start',gap:10}}>
        <div style={{flex:1,fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',lineHeight:1.5}}>
          Confirmed zero = the last shot's dialed sight setting, in <strong style={{color:'var(--ink)'}}>MOA</strong> (up/right positive, ¼ MOA per click).
        </div>
        <button className="badd" style={{fontSize:10,padding:'5px 9px',background:'none',border:'1px solid var(--bdr)',color:'var(--ink)',flexShrink:0}}
          onClick={()=>setCardText(t=>t?null:dopeCardText(byFirearm))}>⤓ card</button>
      </div>
      {cardText && (
        <div style={{margin:'8px 13px 4px',background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:9,overflow:'hidden'}}>
          <div style={{padding:'9px 12px',borderBottom:'1px solid var(--bdr)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--acc)',letterSpacing:'.1em',textTransform:'uppercase'}}>DOPE card · print &amp; tape to stock</div>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <CopyButton text={cardText}/>
              <button onClick={()=>setCardText(null)} style={{background:'none',border:'none',color:'var(--dim)',cursor:'pointer',fontSize:14,lineHeight:1}}>×</button>
            </div>
          </div>
          <textarea readOnly value={cardText} onFocus={e=>e.target.select()}
            style={{width:'100%',minHeight:160,background:'transparent',border:'none',padding:'10px 12px',
              color:'var(--ink)',fontFamily:'var(--fm)',fontSize:10,lineHeight:1.6,resize:'vertical',outline:'none',whiteSpace:'pre'}}/>
        </div>
      )}
      {Object.entries(byFirearm).map(([fname, locs]) => (
        <div key={fname} style={{margin:'14px 13px 0',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,overflow:'hidden'}}>
          <div style={{padding:'9px 12px',borderBottom:'1px solid var(--bdr)',fontFamily:'var(--fh)',fontSize:13,fontWeight:700,color:'var(--ink)'}}>{fname}</div>
          {Object.entries(locs).map(([loc, cs]) => (
            <div key={loc}>
              <div style={{padding:'6px 12px',background:'var(--surf2)',fontFamily:'var(--fm)',fontSize:9,letterSpacing:'.1em',textTransform:'uppercase',color:'var(--dim)'}}>{loc}</div>
              {cs.map(cell => {
                const head = cell.sessions[0];
                const history = cell.sessions.slice(1);
                const isOpen = open.has(cell.key);
                return (
                  <div key={cell.key} style={{borderTop:'1px solid var(--bdr)'}}>
                    <button
                      onClick={()=>history.length && setOpen(p=>{ const n=new Set(p); n.has(cell.key)?n.delete(cell.key):n.add(cell.key); return n; })}
                      style={{width:'100%',background:'none',border:'none',padding:'10px 12px',display:'flex',alignItems:'center',gap:10,cursor:history.length?'pointer':'default',textAlign:'left'}}>
                      <span style={{fontFamily:'var(--fm)',fontSize:14,fontWeight:700,color:'var(--ink)',minWidth:54}}>{cell.yards}<span style={{fontSize:9,color:'var(--dim)'}}> yd</span></span>
                      <span style={{flex:1}}>
                        <div style={{fontFamily:'var(--fm)',fontSize:9,letterSpacing:'.06em',textTransform:'uppercase',color:positionColor(cell.position),fontWeight:700,marginBottom:1}}>{cell.position}</div>
                        <Zero e={head} />
                        <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',marginTop:2}}>
                          {head.date}
                          {head.temp && ` · ${head.temp}°`}
                          {head.lighting && head.lighting!=='Clear' && ` · ${head.lighting}`}
                          {head.ammo && ` · ${head.ammo}`}
                          {head.mrMoa!=null && ` · ${head.mrMoa.toFixed(2)} MOA grp`}
                          {head.moved && ' · adjusted in session'}
                        </div>
                        {(() => {
                          const drift = zeroDriftInfo(cell.sessions);
                          return drift ? (
                            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--acc)',marginTop:2,fontWeight:700}}>
                              ⚠ zero drift: {drift.flagged.map(f=>`${f.axis} ${f.clicks>0?'+':''}${clicksToMoa(f.clicks).toFixed(2)} MOA`).join(' · ')} over {drift.n} sessions — check mount/optic
                            </div>
                          ) : null;
                        })()}
                      </span>
                      {history.length>0 && (
                        <span style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>{isOpen?'▾':`+${history.length}`}</span>
                      )}
                    </button>
                    {isOpen && history.map(h => (
                      <div key={h.sid} style={{padding:'6px 12px 6px 66px',display:'flex',alignItems:'center',gap:10,borderTop:'1px solid var(--bg)'}}>
                        <span style={{flex:1}}>
                          <Zero e={h} faded />
                          <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',marginTop:2}}>
                            {h.date}{h.temp && ` · ${h.temp}°`}{h.ammo && ` · ${h.ammo}`}{h.mrMoa!=null && ` · ${h.mrMoa.toFixed(2)} MOA grp`}
                          </div>
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* Match-from-template screen: pick a course of fire, get the match plus all
 * stage sessions pre-created with the right target/distance/position/fire
 * mode, in firing order. Defaults (firearm, location) seed from the most
 * recent session because that's almost always the same gun and range.
 */
function MatchTemplateForm({ firearms, sessions, ammo, onBack, onCreate }) {
  const recent = [...(sessions||[])].sort((a,b)=>(b.ts||0)-(a.ts||0))[0];
  const [tplId, setTplId] = useState(MATCH_TEMPLATES[0].id);
  const [name, setName] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0,10));
  const [rifleId, setRifleId] = useState(recent?.rifleId || firearms[0]?.id || '');
  const [rangeLocation, setRangeLocation] = useState(recent?.rangeLocation || '');
  // Two ammo slots per the standard XTC pattern: one load for the short line
  // (200/300, mag-length), a different one for 600. Either may stay unset.
  const [ammoShortId, setAmmoShortId] = useState('');
  const [ammoLongId, setAmmoLongId] = useState('');
  const tpl = MATCH_TEMPLATES.find(t=>t.id===tplId) || MATCH_TEMPLATES[0];
  const totalShots = tpl.stages.reduce((s,st)=>s+st.shots,0);
  // Loads usable with the chosen firearm (bound to it, or any-firearm).
  const availAmmo = (ammo||[]).filter(a => !a.rifleId || a.rifleId === rifleId);
  const has600 = tpl.stages.some(st=>st.rangeYards >= 600);

  function onRifleChange(rid) {
    setRifleId(rid);
    // Clear picks that were tied to the previous firearm — same guard as the
    // NewSession picker, so a hidden stale ammoId can't ride into creation.
    const stillOk = id => { const l = (ammo||[]).find(a=>a.id===id); return l && (!l.rifleId || l.rifleId === rid); };
    setAmmoShortId(v => v && stillOk(v) ? v : '');
    setAmmoLongId(v => v && stillOk(v) ? v : '');
  }
  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="hdr">
          <button className="bback" onClick={onBack}>← sessions</button>
          <div style={{fontFamily:'var(--fh)',fontSize:14,fontWeight:700}}>New match</div>
        </div>
        <div className="content">
          <div className="form">
            <div className="field">
              <div className="lbl">Course of fire</div>
              {MATCH_TEMPLATES.map(t => (
                <button key={t.id} onClick={()=>setTplId(t.id)}
                  style={{textAlign:'left',background: t.id===tplId?'var(--surf2)':'var(--surf)',
                    border:`1.5px solid ${t.id===tplId?'var(--acc)':'var(--bdr)'}`,borderRadius:7,
                    padding:'10px 12px',cursor:'pointer',marginBottom:6,width:'100%'}}>
                  <div style={{fontFamily:'var(--fh)',fontSize:13,fontWeight:700,color:'var(--ink)'}}>{t.name}</div>
                  <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',marginTop:2}}>
                    {t.stages.map(s=>`${s.shots}@${s.rangeYards}`).join(' · ')}
                  </div>
                </button>
              ))}
            </div>
            <div className="field">
              <div className="lbl">Stages ({totalShots} record shots)</div>
              <div style={{background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:7,overflow:'hidden'}}>
                {tpl.stages.map((st,i)=>(
                  <div key={i} style={{display:'flex',gap:8,alignItems:'baseline',padding:'7px 11px',borderBottom: i<tpl.stages.length-1?'1px solid var(--bdr)44':'none'}}>
                    <span style={{fontFamily:'var(--fm)',fontSize:10,fontWeight:700,color:positionColor(st.position),minWidth:64}}>{st.position}</span>
                    <span style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--ink)',flex:1}}>{st.fireMode} · {st.rangeYards}yd</span>
                    <span style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>{st.shots} rds</span>
                  </div>
                ))}
              </div>
              <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',lineHeight:1.5,marginTop:4}}>
                Rapid pairs log as one session per stage. Tag sighters as usual. Verify COF against the current rulebook for sanctioned matches.
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <div className="lbl">Match name</div>
                <input className="inp" value={name} onChange={e=>setName(e.target.value)} placeholder={tpl.name}/>
              </div>
              <div className="field">
                <div className="lbl">Date</div>
                <input className="inp" type="date" value={date} onChange={e=>setDate(e.target.value)}/>
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <div className="lbl">Firearm</div>
                <select className="inp" value={rifleId} onChange={e=>onRifleChange(e.target.value)}>
                  <option value="">—</option>
                  {firearms.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
              <div className="field">
                <div className="lbl">Location</div>
                <input className="inp" value={rangeLocation} onChange={e=>setRangeLocation(e.target.value)} placeholder="range name"/>
              </div>
            </div>
            {/* Ammo per line — short line (200/300) and 600 assigned separately,
                since the standard pattern is a mag-length load short and a
                heavier single-load bullet at 600. Hidden when no loads exist
                for this firearm; either slot can stay unset. */}
            {availAmmo.length > 0 && (
              <div className="row2">
                <div className="field">
                  <div className="lbl">Ammo · 200/300</div>
                  <select className="inp" value={ammoShortId} onChange={e=>setAmmoShortId(e.target.value)}>
                    <option value="">—</option>
                    {availAmmo.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                {has600 ? (
                  <div className="field">
                    <div className="lbl">Ammo · 600</div>
                    <select className="inp" value={ammoLongId} onChange={e=>setAmmoLongId(e.target.value)}>
                      <option value="">—</option>
                      {availAmmo.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                ) : <div className="field"/>}
              </div>
            )}
            <button className="bprim" onClick={()=>onCreate(tpl, {
              name, date, rifleId, rangeLocation,
              ammoShort: availAmmo.find(a=>a.id===ammoShortId) || null,
              ammoLong:  availAmmo.find(a=>a.id===ammoLongId)  || null,
            })}>
              Create match + {tpl.stages.length} stage sessions
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* Shot-order card — first-shot effect and within-string drift, per position,
 * from normalized radii pooled across sessions (see shotOrderAnalytics).
 * Renders nothing until a position has ≥4 sessions of ≥5 record shots.
 */
function ShotOrderCard({ sessions, getTarget }) {
  const rows = useMemo(() => shotOrderAnalytics(sessions, getTarget), [sessions, getTarget]);
  if (!rows.length) return null;
  const fmtPct = v => `${v>0?'+':''}${v.toFixed(0)}%`;
  return (
    <>
      <div className="shdr">Shot order</div>
      <div style={{margin:'0 13px 10px',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,padding:'11px 13px'}}>
        {rows.map(r => (
          <div key={r.pos} style={{display:'flex',alignItems:'baseline',gap:10,padding:'4px 0',borderBottom:'1px solid var(--bdr)33'}}>
            <span style={{fontFamily:'var(--fm)',fontSize:10,fontWeight:700,color:positionColor(r.pos),minWidth:72}}>{r.pos}</span>
            <span style={{flex:1,fontFamily:'var(--fm)',fontSize:9}}>
              <span style={{color: r.firstSig ? (r.firstPct>0?'var(--acc)':'var(--green)') : 'var(--dim)',fontWeight: r.firstSig?700:400}}>
                1st shot {fmtPct(r.firstPct)}{r.firstSig ? '' : ' (noise)'}
              </span>
              <span style={{color:'var(--dim)'}}> · </span>
              <span style={{color: r.slopeSig ? (r.slopePct>0?'var(--acc)':'var(--green)') : 'var(--dim)',fontWeight: r.slopeSig?700:400}}>
                drift {fmtPct(r.slopePct)}/shot{r.slopeSig ? '' : ' (noise)'}
              </span>
            </span>
            <span style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>{r.sessions} sess</span>
          </div>
        ))}
        <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',lineHeight:1.5,marginTop:6}}>
          Radial error vs your own session average, pooled per position. 1st shot = cold-position effect; drift = fatigue across the string. “Noise” = not statistically distinguishable yet.
        </div>
      </div>
    </>
  );
}

/* Correction-response card — pooled dial-vs-POI gain and correction sign-flip
 * rate (see correctionAnalytics for the model and sign-convention note).
 */
function CorrectionCard({ sessions, getTarget }) {
  const ca = useMemo(() => correctionAnalytics(sessions, getTarget), [sessions, getTarget]);
  if (!ca.gain && !ca.flip) return null;
  const g = ca.gain, f = ca.flip;
  const gainRead = !g ? null
    : g.mean >= 0.8 && g.mean <= 1.2 ? { txt:'POI moves as dialed — corrections and turret are tracking.', col:'var(--green)' }
    : g.mean < 0.8 ? { txt:'POI moves less than dialed — small corrections are chasing dispersion noise, or the turret isn\u2019t tracking true.', col:'var(--acc)' }
    : { txt:'POI moves more than dialed — check for double-dialing or turret overshoot.', col:'var(--acc)' };
  const flipHigh = f && f.rate > 0.6;
  return (
    <>
      <div className="shdr">Correction response</div>
      <div style={{margin:'0 13px 10px',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,padding:'11px 13px'}}>
        <div style={{display:'flex',gap:18,marginBottom:8}}>
          {g && (
            <div>
              <div style={{fontFamily:'var(--fm)',fontSize:14,fontWeight:700,color:gainRead.col}}>{g.mean.toFixed(2)}×</div>
              <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>dial gain · {g.n} corrections · ±{g.sd.toFixed(2)}</div>
            </div>
          )}
          {f && (
            <div>
              <div style={{fontFamily:'var(--fm)',fontSize:14,fontWeight:700,color: flipHigh ? 'var(--acc)' : 'var(--green)'}}>{(f.rate*100).toFixed(0)}%</div>
              <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>sign flips · {f.n} pairs</div>
            </div>
          )}
        </div>
        <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',lineHeight:1.5}}>
          {g && gainRead.txt}
          {g && f && ' '}
          {f && (flipHigh
            ? 'Corrections alternate direction more than chance — likely correcting off single shots. Correct off the group center instead.'
            : 'Correction directions look independent — no shot-chasing signature.')}
        </div>
        <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',lineHeight:1.5,marginTop:5,opacity:0.75}}>
          Gain = actual POI shift projected onto the dialed change (1.00 = perfect). Only dial changes ≥ 0.5 MOA with shots on both sides count. Assumes +elev = up, +wind = right.
        </div>
      </div>
    </>
  );
}

/* Classification pace card — rolling percentage over the most recent
 * match-linked record shots (≤240, NRA reclassification window). Explicitly
 * framed as pace, not an official classification: NRA classifies from
 * approved-tournament scores only, and only whole tournament aggregates.
 */
function ClassificationCard({ sessions, matches }) {
  const pace = useMemo(() => classificationPace(sessions, matches), [sessions, matches]);
  if (!pace) return null;
  return (
    <div style={{margin:'14px 13px 0',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,padding:'11px 13px'}}>
      <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.1em',textTransform:'uppercase',marginBottom:6}}>Classification pace · last {pace.shots} match shots</div>
      <div style={{display:'flex',gap:18,alignItems:'baseline'}}>
        <div>
          <div style={{fontFamily:'var(--fm)',fontSize:18,color:'var(--acc)',fontWeight:700}}>{pace.pct.toFixed(2)}%</div>
          <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>{pace.points} / {pace.shots*10}</div>
        </div>
        <div>
          <div style={{fontFamily:'var(--fm)',fontSize:14,color:'var(--ink)',fontWeight:700}}>{pace.band}</div>
          {pace.next && (
            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>
              {pace.next.ptsPer50} pts/50-shot match short of {pace.next.name}
            </div>
          )}
        </div>
      </div>
      <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',lineHeight:1.5,marginTop:6,opacity:0.75}}>
        Conventional HP bands (HM 97 · MA 94 · EX 89 · SS 84), from match-linked sessions only. Pace, not an official NRA classification.
      </div>
    </div>
  );
}

/* Season points budget — seasonBudget() ranked by loss rate, split into
 * dispersion vs offset per 10 shots. This is the training-time allocator:
 * the top row is where practice buys the most points back.
 */
function SeasonBudgetCard({ sessions, getTarget }) {
  const rows = useMemo(() => seasonBudget(sessions, getTarget), [sessions, getTarget]);
  if (!rows.length) return null;
  const maxTotal = Math.max(...rows.map(r=>r.totalPer10), 0.1);
  return (
    <>
      <div className="shdr">Season points budget · per 10 shots</div>
      <div style={{margin:'0 13px 10px',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,padding:'11px 13px'}}>
        {rows.map(r => (
          <div key={`${r.pos}|${r.yards}`} style={{padding:'5px 0',borderBottom:'1px solid var(--bdr)33'}}>
            <div style={{display:'flex',alignItems:'baseline',gap:8}}>
              <span style={{fontFamily:'var(--fm)',fontSize:10,fontWeight:700,color:positionColor(r.pos),flex:1}}>{r.pos} · {r.yards}yd</span>
              <span style={{fontFamily:'var(--fm)',fontSize:11,fontWeight:700,color:'var(--ink)'}}>−{r.totalPer10.toFixed(1)}</span>
              <span style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>{r.sessions} sess</span>
            </div>
            <div style={{display:'flex',height:4,borderRadius:2,overflow:'hidden',marginTop:3,background:'var(--bg)'}}>
              <div style={{width:`${(r.dPer10/maxTotal)*100}%`,background:'#4a9eff'}}/>
              <div style={{width:`${(r.oPer10/maxTotal)*100}%`,background:'var(--acc)'}}/>
            </div>
            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',marginTop:2}}>
              <span style={{color:'#4a9eff'}}>dispersion −{r.dPer10.toFixed(1)}</span>
              <span> · </span>
              <span style={{color:'var(--acc)'}}>offset −{r.oPer10.toFixed(1)}</span>
            </div>
          </div>
        ))}
        <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',lineHeight:1.5,marginTop:6,opacity:0.75}}>
          Simulated from each session's fitted group (5+ record shots). Top row = highest-value training target. Blue leaks need smaller groups; orange leaks need zero/NPOA work.
        </div>
      </div>
    </>
  );
}

/* ── Leaderboard ──────────────────────────────────────────────────────────
 * Everyone's published entries, filtered to a comparable class. Ranking
 * across different positions/distances/shot-counts would be meaningless, so
 * the filters are not optional garnish -- they define the comparison.
 */
function LeaderboardCard({ core }) {
  const [rows, setRows] = useState(null);      // null = not loaded
  const [err, setErr] = useState(null);
  const [pos, setPos] = useState('Standing');
  const [dist, setDist] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true); setErr(null);
    const q = ['select=*', 'order=score.desc', 'limit=200'];
    if (pos) q.push(`position=eq.${encodeURIComponent(pos)}`);
    if (dist) q.push(`distance_yd=eq.${encodeURIComponent(dist)}`);
    const r = await core.leaderboard(q.slice(1).join('&'));
    setBusy(false);
    if (!r.ok) { setErr('Could not load the leaderboard.'); setRows([]); return; }
    setRows(r.data || []);
  }

  const lbl = { fontFamily:'var(--fm)', fontSize:9, color:'var(--dim)',
                letterSpacing:'.1em', textTransform:'uppercase' };
  const sel = { background:'var(--surf2)', border:'1px solid var(--bdr)', borderRadius:5,
                padding:'6px 8px', color:'var(--ink)', fontFamily:'var(--fm)', fontSize:10 };

  if (!core || !core.isSignedIn()) return null;

  // Rank within the filtered class: score desc, then X count, then tighter MR.
  const ranked = (rows || []).slice().sort((a, b) =>
    (b.score - a.score) || (b.x_count - a.x_count) || ((a.mr_moa ?? 9e9) - (b.mr_moa ?? 9e9)));
  const me = core.getUser()?.id;

  return (
    <div className="tcard" style={{padding:'11px 13px'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        <div style={lbl}>Leaderboard</div>
        <button className="badd" style={{fontSize:9,padding:'4px 9px',opacity:busy?0.5:1}}
          disabled={busy} onClick={load}>{busy?'…':(rows?'refresh':'load')}</button>
      </div>
      <div style={{display:'flex',gap:6,marginBottom:8}}>
        <select style={{...sel,flex:1}} value={pos} onChange={e=>setPos(e.target.value)}>
          <option value="">Any position</option>
          {POSITIONS.map(p=><option key={p} value={p}>{p}</option>)}
        </select>
        <input style={{...sel,width:96}} type="number" value={dist}
          onChange={e=>setDist(e.target.value)} placeholder="yards"/>
      </div>

      {err && <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--red)'}}>{err}</div>}
      {rows === null && !err && (
        <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',lineHeight:1.5}}>
          Published sessions from everyone using this app. Pick a class and load.
        </div>)}
      {rows && rows.length === 0 && !err && (
        <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)'}}>Nothing published in that class yet.</div>)}

      {ranked.length > 0 && (
        <table style={{width:'100%',borderCollapse:'collapse',fontFamily:'var(--fm)',fontSize:10}}>
          <thead><tr style={{color:'var(--dim)',fontSize:8,textTransform:'uppercase',letterSpacing:'.08em'}}>
            <th style={{textAlign:'left',padding:'3px 4px 5px',fontWeight:400}}>#</th>
            <th style={{textAlign:'left',padding:'3px 4px 5px',fontWeight:400}}>Shooter</th>
            <th style={{textAlign:'right',padding:'3px 4px 5px',fontWeight:400}}>Score</th>
            <th style={{textAlign:'right',padding:'3px 4px 5px',fontWeight:400}}>MR</th>
            <th style={{textAlign:'right',padding:'3px 4px 5px',fontWeight:400}}>Shots</th>
          </tr></thead>
          <tbody>
            {ranked.map((r,i) => (
              <tr key={r.id} style={{borderTop:'1px solid var(--bdr)',
                    background: r.user_id === me ? 'rgba(232,148,58,0.08)' : 'transparent'}}>
                <td style={{padding:'5px 4px',color:'var(--dim)'}}>{i+1}</td>
                <td style={{padding:'5px 4px',color:'var(--ink)',maxWidth:110,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {r.handle}{r.user_id === me && <span style={{color:'var(--acc)',fontSize:8}}> you</span>}</td>
                <td style={{padding:'5px 4px',textAlign:'right',color:'var(--acc)',fontWeight:700}}>{r.score}<span style={{fontSize:8,color:'var(--dim)'}}>–{r.x_count}X</span></td>
                <td style={{padding:'5px 4px',textAlign:'right'}}>{r.mr_moa!=null?(+r.mr_moa).toFixed(2):'—'}</td>
                <td style={{padding:'5px 4px',textAlign:'right',color:'var(--dim)'}}>{r.shot_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{fontFamily:'var(--fm)',fontSize:8.5,color:'var(--dim)',marginTop:6,lineHeight:1.5}}>
        Ranked by score, then X count, then mean radius. Scores are self-reported —
        this is a scoreboard among people who know each other, not a verified record.
        Only sessions you explicitly publish appear; everything else stays private.
      </div>
    </div>
  );
}

function AnalyticsTab({ sessions, getTarget, firearms, matches }) {
  // Per-session entries with everything we need downstream
  const data = sessions
    .filter(s=>(s.shots?.length||0)>=2)
    .map(s=>{
      const tgt=getTarget(s.targetId);
      const a=analytics(s.shots,tgt,s.rangeYards);
      return a && a.n >= 2 ? {
        date:s.date,
        ts:s.ts,
        label:`${tgt.name}@${s.rangeYards}`,
        range:s.rangeYards,
        location:s.rangeLocation || '',
        es:a.esMoa, mr:a.mrMoa,
        score:a.score, xs:a.xs,
        rifleId:s.rifleId,
        position: s.position || 'Unspecified',
        n:a.n,
        // 90% CI on pooled σ in MOA — same-bucket sessions share range, so
        // these are directly comparable for the noise-vs-real Δ flag.
        sigLo: a.sigmaLoIn != null && s.rangeYards > 0 ? inchesToMoa(a.sigmaLoIn, s.rangeYards) : null,
        sigHi: a.sigmaHiIn != null && s.rangeYards > 0 ? inchesToMoa(a.sigmaHiIn, s.rangeYards) : null,
      } : null;
    })
    .filter(Boolean)
    .sort((a,b)=>a.ts - b.ts);

  // Aggregate wind-call accuracy across all sessions
  const allWindItems = [];
  sessions.forEach(s => {
    const tgt = getTarget(s.targetId);
    const wa = windCallAnalytics(s.shots||[], tgt, s.rangeYards);
    if (wa) allWindItems.push(...wa.items);
  });
  const rollingWindAcc = allWindItems.length >= 3 ? {
    n: allWindItems.length,
    absMean: allWindItems.reduce((s,i)=>s+Math.abs(i.errMoa),0)/allWindItems.length,
    signedMean: allWindItems.reduce((s,i)=>s+i.errMoa,0)/allWindItems.length,
  } : null;

  // Group sessions by position x distance — 600yd prone and 300yd prone are
  // different problems (different hold, different target subtension), so each
  // (position, distance) pair is its own series. Bucket key = position|range.
  const byBucket = {};
  data.forEach(d => {
    const key = `${d.position}|${d.range}`;
    (byBucket[key] ||= { key, position: d.position, range: d.range, items: [] }).items.push(d);
  });
  const bucketSeries = Object.values(byBucket)
    .map(b => ({ ...b, count: b.items.length, label: `${b.position} · ${b.range}yd` }))
    .sort((a,b) => posRank(a.position) - posRank(b.position) || b.range - a.range);

  // Distances that share a position also share its color; a dash pattern keeps
  // them distinguishable (longest distance solid, shorter ones progressively dashed).
  const distancesByPos = {};
  bucketSeries.forEach(b => { (distancesByPos[b.position] ||= new Set()).add(b.range); });
  const DASHES = ['', '5 3', '2 3', '7 3 2 3', '1 3'];
  const dashFor = (position, range) => {
    const ds = [...(distancesByPos[position] || [])].sort((a,b)=>b-a);
    return DASHES[Math.min(Math.max(ds.indexOf(range), 0), DASHES.length-1)];
  };

  // Renderable series have at least 2 points
  const renderable = bucketSeries.filter(s => s.count >= 2);

  const WindCard = rollingWindAcc && (
    <div style={{margin:'14px 13px 0',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,padding:'11px 13px'}}>
      <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.1em',textTransform:'uppercase',marginBottom:6}}>Lifetime wind call · {rollingWindAcc.n} shots</div>
      <div style={{display:'flex',gap:18}}>
        <div>
          <div style={{fontFamily:'var(--fm)',fontSize:14,color:'#4a9eff',fontWeight:700}}>{rollingWindAcc.absMean.toFixed(2)}</div>
          <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>MOA avg error</div>
        </div>
        <div>
          <div style={{fontFamily:'var(--fm)',fontSize:14,color: Math.abs(rollingWindAcc.signedMean)<0.1?'var(--green)':'var(--acc)',fontWeight:700}}>
            {Math.abs(rollingWindAcc.signedMean)<0.1 ? 'neutral' : `${Math.abs(rollingWindAcc.signedMean).toFixed(2)} ${rollingWindAcc.signedMean>0?'R':'L'}`}
          </div>
          <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>lifetime bias</div>
        </div>
      </div>
    </div>
  );

  if (data.length < 2) return (
    <div>
      <ClassificationCard sessions={sessions} matches={matches} />
      {WindCard}
      <div className="empty"><div className="et">Not enough data</div><div className="es">Log at least 2 sessions with 2+ shots each to see trends.</div></div>
    </div>
  );

  // Chart geometry
  const W=330,H=160,PL=32,PR=10,PT=10,PB=28;
  const pw=W-PL-PR, ph=H-PT-PB;

  // Compute global y-axis max using ONLY renderable position series so a single
  // outlier session in an unrenderable position doesn't squish the visible lines.
  const renderablePoints = renderable.flatMap(s => s.items.map(i => i.es));
  const fallbackPoints = data.map(d=>d.es);
  const yPool = renderablePoints.length ? renderablePoints : fallbackPoints;
  const maxES = Math.max(...yPool) * 1.18 || 1;

  // X-axis: index across the union of renderable sessions, ordered by timestamp.
  // Each session sits at its global chronological index regardless of position.
  const allIndexed = data.map((d, i) => ({ ...d, _i: i }));
  const indexById = {};
  allIndexed.forEach((d, i) => { indexById[d.ts + '::' + d.label] = i; });

  const gx = i => (data.length < 2 ? PL+pw/2 : PL + (i/(data.length-1))*pw).toFixed(1);
  const gy = v => (PT + (1 - v/maxES) * ph).toFixed(1);

  return (
    <div>
      <ClassificationCard sessions={sessions} matches={matches} />
      {WindCard}

      <div className="shdr">Group size by position &amp; distance</div>
      <div style={{margin:'0 13px',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,overflow:'hidden'}}>

        {/* Header strip + legend */}
        <div style={{padding:'9px 12px 6px',display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8,fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.1em'}}>
          <span>ES MOA · position &amp; distance</span>
        </div>
        <div style={{padding:'0 12px 8px',display:'flex',flexWrap:'wrap',gap:'4px 12px'}}>
          {renderable.map(s => (
            <div key={s.key} style={{display:'flex',alignItems:'center',gap:5,fontFamily:'var(--fm)',fontSize:9}}>
              <svg width={16} height={4} style={{display:'block',flexShrink:0}}><line x1={0} y1={2} x2={16} y2={2} stroke={positionColor(s.position)} strokeWidth={2} strokeDasharray={dashFor(s.position,s.range)||undefined}/></svg>
              <span style={{color:positionColor(s.position),fontWeight:700}}>{s.position}</span>
              <span style={{color:'var(--dim)'}}>{s.range}yd · {s.count}</span>
            </div>
          ))}
          {bucketSeries.filter(s=>s.count<2).length > 0 && (
            <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>
              ({bucketSeries.filter(s=>s.count<2).map(s=>s.label).join(', ')} need 2+ to chart)
            </div>
          )}
        </div>

        {renderable.length === 0 ? (
          <div style={{padding:'20px 12px',fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)',textAlign:'center'}}>
            No position &amp; distance has 2+ sessions yet. Log more under the same position and distance to see trends.
          </div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',display:'block',background:'#1a1d27'}}>
            {/* Y gridlines */}
            {[0,.25,.5,.75,1].map(f=>{
              const y=gy(f*maxES);
              return (
                <g key={f}>
                  <line x1={PL} y1={y} x2={W-PR} y2={y} stroke="#ffffff10" strokeWidth={1}/>
                  <text x={PL-3} y={+y+3} textAnchor="end" fill="#7a7f96" fontSize={7} fontFamily="Space Mono,monospace">{(f*maxES).toFixed(1)}</text>
                </g>
              );
            })}

            {/* One polyline per position x distance */}
            {renderable.map(series => {
              const col = positionColor(series.position);
              const dash = dashFor(series.position, series.range);
              // items are the same object refs that live in `data`, so indexOf
              // gives the global chronological x-index directly.
              const points = series.items.map(item => {
                const xi = data.indexOf(item);
                return { x: gx(xi >= 0 ? xi : 0), y: gy(item.es), item };
              });
              const path = points.map((p,i) => `${i?'L':'M'}${p.x},${p.y}`).join(' ');
              return (
                <g key={series.key}>
                  <path d={path} fill="none" stroke={col} strokeWidth={1.8} opacity={0.9} strokeDasharray={dash||undefined}/>
                  {points.map((p,i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={2.8} fill={col}/>
                  ))}
                </g>
              );
            })}

            {/* X-axis date ticks (sparse) */}
            {data.map((d,i)=>(i%(Math.max(1,Math.floor(data.length/4)))===0)&&(
              <text key={i} x={gx(i)} y={H-4} textAnchor="middle" fill="#7a7f96" fontSize={7} fontFamily="Space Mono,monospace">{d.date.slice(5)}</text>
            ))}
          </svg>
        )}
      </div>

      {/* Per-position summary cards */}
      {renderable.length > 0 && (
        <>
          <div className="shdr">Position &amp; distance summary</div>
          {renderable.map(s => {
            const avgES = s.items.reduce((sum,i)=>sum+i.es,0)/s.items.length;
            const recent = s.items[s.items.length-1].es;
            const earlier = s.items[0].es;
            const delta = recent - earlier;
            const deltaPct = earlier > 0 ? (delta/earlier)*100 : 0;
            // Noise flag: compare the first and last sessions' 90% σ CIs.
            // Overlapping bands → the Δ is inside sampling variance (this is
            // slightly conservative vs a formal F-test, which is the right
            // direction to err — better to under-claim change than chase it).
            const fst = s.items[0], lst = s.items[s.items.length-1];
            const ciFlag = (fst.sigLo != null && lst.sigLo != null)
              ? !(fst.sigHi < lst.sigLo || lst.sigHi < fst.sigLo) ? 'noise' : 'real'
              : null;
            return (
              <div key={s.key} style={{margin:'0 13px 10px',background:'var(--surf)',border:'1px solid var(--bdr)',borderLeft:`3px solid ${positionColor(s.position)}`,borderRadius:7,padding:'10px 12px'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}>
                  <div style={{fontFamily:'var(--fh)',fontSize:13,fontWeight:700,color:positionColor(s.position)}}>{s.label}</div>
                  <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>{s.count} sessions</div>
                </div>
                <div style={{display:'flex',gap:14,fontFamily:'var(--fm)',fontSize:10}}>
                  <div>
                    <span style={{color:'var(--dim)'}}>avg </span>
                    <span style={{color:'var(--ink)',fontWeight:700}}>{avgES.toFixed(2)} MOA</span>
                  </div>
                  <div>
                    <span style={{color:'var(--dim)'}}>last </span>
                    <span style={{color:'var(--ink)',fontWeight:700}}>{recent.toFixed(2)}</span>
                  </div>
                  {s.count >= 2 && (
                    <div>
                      <span style={{color:'var(--dim)'}}>Δ </span>
                      <span style={{color: delta < 0 ? 'var(--green)' : delta > 0 ? 'var(--red)' : 'var(--dim)',fontWeight:700}}>
                        {delta > 0 ? '+' : ''}{delta.toFixed(2)} ({deltaPct>0?'+':''}{deltaPct.toFixed(0)}%)
                      </span>
                    </div>
                  )}
                </div>
                {ciFlag && (
                  <div style={{fontFamily:'var(--fm)',fontSize:8,marginTop:4,lineHeight:1.4,
                    color: ciFlag==='noise' ? 'var(--dim)' : delta < 0 ? 'var(--green)' : 'var(--acc)'}}>
                    {ciFlag==='noise'
                      ? 'Δ within sampling noise — 90% CIs overlap. Not evidence of change.'
                      : `Δ exceeds sampling noise — this ${delta < 0 ? 'improvement' : 'regression'} is likely real.`}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      <SeasonBudgetCard sessions={sessions} getTarget={getTarget} />
      <ShotOrderCard sessions={sessions} getTarget={getTarget} />
      <CorrectionCard sessions={sessions} getTarget={getTarget} />

      <div className="shdr">All sessions</div>
      {[...data].reverse().map((d,i)=>(
        <div key={i} style={{display:'flex',padding:'9px 13px',borderBottom:'1px solid var(--bdr)44',alignItems:'center',gap:10}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontFamily:'var(--fh)',fontSize:13,fontWeight:700}}>{d.label}</div>
            <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
              <span>{d.date}</span>
              <span>·</span>
              <span style={{color:'var(--acc)'}}>{d.range}yd</span>
              {d.position !== 'Unspecified' && (
                <>
                  <span>·</span>
                  <span style={{color:positionColor(d.position)}}>{d.position}</span>
                </>
              )}
              {d.location && (
                <>
                  <span>·</span>
                  <span>{d.location}</span>
                </>
              )}
            </div>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{fontFamily:'var(--fm)',fontSize:13,color:'var(--acc)'}}>{d.es.toFixed(2)} MOA</div>
            <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>{d.score}–{d.xs}X</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function GroupPlot({ pts, target, shots, yards, partners }) {
  if (!pts||pts.length<1) return null;
  const SZ=220, c=SZ/2;

  // A partner's relayed string, drawn over the same target in their firing
  // point's colour. Hollow, so it never reads as one of your own impacts —
  // this is context, not your group, and the analytics below ignore it.
  const others = (partners || []).filter(o => o.stats.pts.length);

  // Stable stepped view radius — no whiplash on outliers. Partner points are
  // included so their string cannot silently fall outside the frame.
  const viewR = steppedViewRadius(target,
    others.length ? pts.concat(others.flatMap(o => o.stats.pts)) : pts,
    { pad: 0.6, minStepIdx: 1 });
  const sc = (SZ*0.88)/(viewR*2);

  // 95% dispersion ellipse over RECORD shots only (match mean-radius population).
  const recPts = pts.filter((_,i)=>!shots[i]?.isSighter);
  const ell = recPts.length >= ELLIPSE_MIN_SHOTS ? dispersionEllipse(recPts) : null;
  // Screen transform is (x,y)→(c+x·sc, c−y·sc): the y-flip turns a math-CCW
  // rotation of θ into a screen rotation of −θ.
  const ellScreen = ell ? {
    ecx: c + ell.cx*sc, ecy: c - ell.cy*sc,
    erx: ell.ax*sc, ery: ell.ay*sc, rot: -ell.thetaDeg,
  } : null;
  const moa = v => (yards ? inchesToMoa(v, yards) : null);
  const aspectEll = ell ? ell.ax/Math.max(1e-6, ell.ay) : 0;   // ellipse elongation (eigenvalue ratio)
  const dominant = !ell ? '' : (
    aspectEll < 1.6 ? 'round'
    : ell.sigmaY > ell.sigmaX*1.15 ? 'vertical'
    : ell.sigmaX > ell.sigmaY*1.15 ? 'horizontal'
    : 'diagonal');                                              // elongated but marginals equal ⇒ ~45° tilt

  return (
    <div className="plotwrap">
      <div className="plothdr">Shot group · {target.name}</div>
      <svg viewBox={`0 0 ${SZ} ${SZ}`} style={{width:'100%',display:'block',background:'#1a1d27'}}>
        {(() => {
          const outermost = target.rings[target.rings.length-1];
          const col = outermost.color || DEFAULT_RING_COLORS[outermost.score] || '#aaa';
          return <rect x={0} y={0} width={SZ} height={SZ} fill={col}/>;
        })()}
        {[...target.rings].reverse().map((r, revIdx) => {
          const fwdIdx = target.rings.length - 1 - revIdx;
          const col = r.color || DEFAULT_RING_COLORS[r.score] || '#aaa';
          const outerCol = fwdIdx < target.rings.length - 1
            ? (target.rings[fwdIdx+1].color || DEFAULT_RING_COLORS[target.rings[fwdIdx+1].score] || '#aaa')
            : '#0f1117';
          const ringW = fwdIdx > 0
            ? (r.diam/2 - target.rings[fwdIdx-1].diam/2) * sc
            : r.diam/2*sc;
          const sw = Math.min(1.5, Math.max(0.6, ringW * 0.06));
          return (
            <circle key={r.score} cx={c} cy={c}
              r={r.diam/2*sc}
              fill={col}
              stroke={ringBorderColor(col, outerCol)}
              strokeWidth={sw}
            />
          );
        })}
        <line x1={c-7} y1={c} x2={c+7} y2={c} stroke="#ffffff18" strokeWidth={.5}/>
        <line x1={c} y1={c-7} x2={c} y2={c+7} stroke="#ffffff18" strokeWidth={.5}/>
        {ellScreen && (
          <g>
            <ellipse cx={ellScreen.ecx} cy={ellScreen.ecy} rx={ellScreen.erx} ry={ellScreen.ery}
              transform={`rotate(${ellScreen.rot.toFixed(2)} ${ellScreen.ecx} ${ellScreen.ecy})`}
              fill="#e8c84016" stroke="#e8c840" strokeWidth={1} strokeDasharray="3 2"/>
            <circle cx={ellScreen.ecx} cy={ellScreen.ecy} r={1.6} fill="#e8c840"/>
          </g>
        )}
        {others.flatMap(o => o.stats.pts.map((pt, i) => (
          <g key={'p'+o.slot+'-'+i} opacity={0.9}>
            <circle className="relayed" cx={c+pt.x*sc} cy={c-pt.y*sc} r={4}
              fill="none" stroke={o.color} strokeWidth={1.6} strokeDasharray="3 1.5"/>
            <text x={c+pt.x*sc} y={c-pt.y*sc+2} textAnchor="middle" fill={o.color}
              fontSize={4.5} fontFamily="Space Mono,monospace" fontWeight="700">{i+1}</text>
          </g>
        )))}
        {pts.map((pt,i)=>{
          const sh = shots[i];
          const ri = sh ? target.rings.findIndex(r=>r.score===sh.ring) : -1;
          const ringFill = ri>=0 ? (target.rings[ri].color||DEFAULT_RING_COLORS[sh.ring]||'#aaa') : '#1a1d27';
          const isSighter = sh?.isSighter;
          const DOT_COLOR = isSighter ? '#4a9eff' : '#e91e63';
          const outline = isLightColor(ringFill) ? '#0a0a0a' : '#ffffff';
          return (
            <g key={i} opacity={isSighter ? 0.55 : 1}>
              <circle cx={c+pt.x*sc} cy={c-pt.y*sc} r={4}
                fill={isSighter?'none':DOT_COLOR}
                stroke={isSighter?'#4a9eff':outline}
                strokeWidth={isSighter?1.5:1.4}
                strokeDasharray={isSighter?'2 1':undefined}/>
              <text x={c+pt.x*sc} y={c-pt.y*sc+2} textAnchor="middle" fill={isSighter?'#4a9eff':'#ffffff'} fontSize={4.5} fontFamily="Space Mono,monospace" fontWeight="700">{shotLabel(shots,i)}</text>
            </g>
          );
        })}
      </svg>
      {others.length > 0 && (
        <div style={{padding:'6px 12px',borderTop:'1px solid var(--bdr)',display:'flex',gap:12,flexWrap:'wrap'}}>
          {others.map(o => (
            <div key={o.slot} style={{display:'flex',alignItems:'center',gap:5,
              fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>
              <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="none"
                stroke={o.color} strokeWidth="1.6" strokeDasharray="3 1.5"/></svg>
              <span style={{color:o.color}}>{o.name}</span>
              <span>{o.stats.score}–{o.stats.xs}X</span>
            </div>
          ))}
          <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',flexBasis:'100%'}}>
            Dashed rings are relayed from your partner. They are not part of your group
            statistics.
          </div>
        </div>
      )}
      {ell && (
        <div style={{padding:'8px 12px',borderTop:'1px solid var(--bdr)',display:'flex',gap:16,alignItems:'center',flexWrap:'wrap'}}>
          <div>
            <div style={{fontFamily:'var(--fm)',fontSize:13,fontWeight:700,color:'#e8c840'}}>
              {moa(ell.sigmaX)!==null ? moa(ell.sigmaX).toFixed(2) : ell.sigmaX.toFixed(2)}
              <span style={{color:'var(--dim)',fontSize:9,fontWeight:400}}> {moa(ell.sigmaX)!==null?'MOA':'in'} ↔</span>
            </div>
            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>horizontal σ</div>
          </div>
          <div>
            <div style={{fontFamily:'var(--fm)',fontSize:13,fontWeight:700,color:'#e8c840'}}>
              {moa(ell.sigmaY)!==null ? moa(ell.sigmaY).toFixed(2) : ell.sigmaY.toFixed(2)}
              <span style={{color:'var(--dim)',fontSize:9,fontWeight:400}}> {moa(ell.sigmaY)!==null?'MOA':'in'} ↕</span>
            </div>
            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)'}}>vertical σ</div>
          </div>
          <div style={{flex:1,minWidth:120}}>
            <div style={{fontFamily:'var(--fm)',fontSize:11,fontWeight:700,
              color: dominant==='vertical'?'var(--acc)':dominant==='horizontal'?'#4a9eff':dominant==='diagonal'?'#e8c840':'var(--green)'}}>
              {dominant==='round' ? 'round group' : `${dominant} ${aspectEll.toFixed(1)}:1`}
            </div>
            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',lineHeight:1.4}}>
              {dominant==='vertical' ? 'elevation — breathing / NPA / ammo ES'
                : dominant==='horizontal' ? 'windage — wind read / trigger'
                : dominant==='diagonal' ? 'tilted — recoil management / cant'
                : `95% ellipse · ${ell.n} shots`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Expected-score decomposition card — where the points actually go.
 * Monte Carlo from the fitted covariance against exact ring geometry, run
 * twice: at the actual group centroid and re-centered on target center.
 *   lost to dispersion = what the group shape drops even perfectly centered
 *   lost to offset     = the extra cost of the centroid sitting off center
 * Offset-dominated → zero/NPOA problem. Dispersion-dominated → fundamentals/
 * ammo; dialing won't buy points. Seeded PRNG keeps numbers render-stable.
 * The covariance itself is estimated from few shots, so the split is
 * approximate — hence the caveat line and the ELLIPSE_MIN_SHOTS gate.
 */
function ScoreDecomposition({ session, target, shots }) {
  const yards = +session.rangeYards || 0;
  const dec = useMemo(
    () => scoreDecomposition(shots, target, yards, session.id),
    [shots, target, yards, session.id]
  );
  if (!dec) return null;
  const lostOff = Math.max(0, dec.lostOffset);
  const offsetDominant = lostOff > dec.lostDispersion * 1.25 && lostOff >= 0.5;
  const dispersionDominant = dec.lostDispersion > lostOff * 1.25 && dec.lostDispersion >= 0.5;
  const verdict = offsetDominant
    ? `POI offset is the bigger leak — centroid sits ${dec.offsetMoa!=null ? dec.offsetMoa.toFixed(2)+' MOA' : dec.offsetIn.toFixed(1)+'"'} from center. Check zero / NPOA before working the group smaller.`
    : dispersionDominant
      ? 'Dispersion-limited — the group is roughly centered; points are going to group size, not zero. Dialing won\u2019t buy these back.'
      : 'Offset and dispersion cost about the same here — or the losses are too small to split reliably.';
  return (
    <>
      <div className="shdr">Score decomposition · simulated</div>
      <div style={{margin:'0 13px 8px',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,padding:'11px 13px'}}>
        <div style={{display:'flex',justifyContent:'space-between',gap:12,marginBottom:8}}>
          <div style={{flex:1}}>
            <div style={{fontFamily:'var(--fm)',fontSize:12,color:'#4a9eff',fontWeight:700}}>−{dec.lostDispersion.toFixed(1)}</div>
            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',letterSpacing:'.06em'}}>to dispersion</div>
          </div>
          <div style={{flex:1}}>
            <div style={{fontFamily:'var(--fm)',fontSize:12,color:'var(--acc)',fontWeight:700}}>−{lostOff.toFixed(1)}</div>
            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',letterSpacing:'.06em'}}>to POI offset</div>
          </div>
          <div style={{flex:1}}>
            <div style={{fontFamily:'var(--fm)',fontSize:12,color:'var(--ink)',fontWeight:700}}>{dec.expActualTotal.toFixed(1)}<span style={{color:'var(--dim)',fontWeight:400}}> / {dec.possible}</span></div>
            <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',letterSpacing:'.06em'}}>expected (shot {dec.actual})</div>
          </div>
        </div>
        <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',lineHeight:1.5}}>{verdict}</div>
        <div style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--dim)',lineHeight:1.5,marginTop:5,opacity:0.75}}>
          Fitted from {dec.n} shots — the split is approximate at this n; trust the direction, not the decimals.
        </div>
      </div>
    </>
  );
}

function SightChart({ shots }) {
  if (shots.length < 2) return null;
  const W=320, H=80, PL=32, PR=8, PT=8, PB=20;
  const elevs=shots.map(s=>clicksToMoa(s.elev)), winds=shots.map(s=>clicksToMoa(s.wind));
  const allVals=[...elevs,...winds];
  const mn=Math.min(...allVals), mx=Math.max(...allVals);
  const rng=mx-mn||0;
  const yMin = rng===0 ? mn-0.5 : mn;
  const yMax = rng===0 ? mx+0.5 : mx;
  const rngAdj = yMax - yMin;
  const gx=i=>(PL+(i/(shots.length-1||1))*(W-PL-PR)).toFixed(1);
  const gy=v=>(PT+(1-(v-yMin)/rngAdj)*(H-PT-PB)).toFixed(1);
  const ep=elevs.map((v,i)=>`${i?'L':'M'}${gx(i)},${gy(v)}`).join(' ');
  const wp=winds.map((v,i)=>`${i?'L':'M'}${gx(i)},${gy(v)}`).join(' ');
  return (
    <div style={{background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,overflow:'hidden'}}>
      <div style={{padding:'8px 12px',borderBottom:'1px solid var(--bdr)',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.1em',display:'flex',justifyContent:'space-between'}}>
        <span>Sight settings per shot · MOA</span>
        <span><span style={{color:'var(--acc)'}}>— elev</span>  <span style={{color:'#3db87a'}}>-- wind</span></span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',display:'block',background:'#1a1d27'}}>
        {[yMin, (yMin+yMax)/2, yMax].map((v,i)=>{
          const y=gy(v);
          return <g key={i}>
            <line x1={PL} y1={y} x2={W-PR} y2={y} stroke="#ffffff10" strokeWidth={1}/>
            <text x={PL-3} y={+y+3} textAnchor="end" fill="#7a7f96" fontSize={7} fontFamily="Space Mono,monospace">{v.toFixed(2)}</text>
          </g>;
        })}
        <path d={ep} fill="none" stroke="var(--acc)" strokeWidth={1.8}/>
        {elevs.map((v,i)=><circle key={i} cx={gx(i)} cy={gy(v)} r={3} fill="var(--acc)"/>)}
        <path d={wp} fill="none" stroke="#3db87a" strokeWidth={1.5} strokeDasharray="4 2"/>
        {winds.map((v,i)=><circle key={i} cx={gx(i)} cy={gy(v)} r={2.5} fill="#3db87a"/>)}
        {shots.map((sh,i)=>(i%(Math.max(1,Math.floor(shots.length/5)))===0)&&(
          <text key={i} x={gx(i)} y={H-3} textAnchor="middle" fill="#7a7f96" fontSize={7} fontFamily="Space Mono,monospace">{shotLabel(shots,i)}</text>
        ))}
      </svg>
    </div>
  );
}

/* ── Color picker component ── */
function RingColorPicker({ color, onChange }) {
  return (
    <div className="colorpicker-wrap">
      {COLOR_PRESETS.map(c => (
        <div
          key={c}
          className={`colorpatch ${color===c?'on':''}`}
          style={{
            background: c,
            border: c==='#ffffff' ? '2px solid var(--bdr)' : (color===c ? '2px solid var(--ink)' : '2px solid transparent'),
          }}
          onClick={()=>onChange(c)}
        />
      ))}
      {/* Custom color swatch */}
      <div
        className="colorpatch colorpatch-custom"
        style={{
          background: COLOR_PRESETS.includes(color) ? 'conic-gradient(red,yellow,green,blue,red)' : color,
          border: !COLOR_PRESETS.includes(color) ? '2px solid var(--ink)' : '2px solid var(--bdr)',
        }}
        title="Custom color"
      >
        <input type="color" value={color} onChange={e=>onChange(e.target.value)} />
      </div>
    </div>
  );
}

/* ── Targets tab ── */
function TargetsTab({ customTargets, onSave, deletedBuiltins, onDeleteBuiltin, onRestoreBuiltin }) {
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);

  if (adding) {
    return <AddTargetForm
      onBack={()=>setAdding(false)}
      onSave={t=>{ onSave([...customTargets, t]); setAdding(false); }}
    />;
  }

  const visibleBuiltins = BUILTIN_TARGETS.filter(t => !deletedBuiltins.includes(t.id));
  const hiddenBuiltins = BUILTIN_TARGETS.filter(t => deletedBuiltins.includes(t.id));
  const allVisible = [...visibleBuiltins, ...customTargets];

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 13px 5px'}}>
        <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.14em',textTransform:'uppercase'}}>Target library</div>
        <button className="badd" onClick={()=>setAdding(true)} style={{fontSize:11,padding:'5px 11px'}}>+ target</button>
      </div>

      {allVisible.map(t=>(
        <div className="tcard" key={t.id}>
          <div className="tch" onClick={()=>setOpen(open===t.id?null:t.id)}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div style={{display:'flex',gap:2}}>
                {t.rings.map(r=>(
                  <div key={r.score} style={{
                    width:8, height:18, borderRadius:2,
                    background: r.color || DEFAULT_RING_COLORS[r.score] || '#aaa',
                    border: '1px solid var(--bdr)',
                  }}/>
                ))}
              </div>
              <div>
                <div className="tcn">
                  {t.name}
                  {!t.builtin && <span style={{fontFamily:'var(--fm)',fontSize:8,color:'var(--acc)',marginLeft:7,background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:3,padding:'1px 5px'}}>custom</span>}
                </div>
                <div className="tcd">{t.desc}</div>
              </div>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              {confirmDel === t.id ? (
                <div style={{display:'flex',gap:5,alignItems:'center'}} onClick={e=>e.stopPropagation()}>
                  <button style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--red)',background:'none',border:'1px solid var(--red)',borderRadius:4,padding:'3px 8px',cursor:'pointer'}}
                    onClick={()=>{
                      if (t.builtin) onDeleteBuiltin(t.id);
                      else onSave(customTargets.filter(c=>c.id!==t.id));
                      if (open===t.id) setOpen(null);
                      setConfirmDel(null);
                    }}>yes</button>
                  <button style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',background:'none',border:'1px solid var(--bdr)',borderRadius:4,padding:'3px 8px',cursor:'pointer'}}
                    onClick={()=>setConfirmDel(null)}>no</button>
                </div>
              ) : (
                <button className="bdel" style={{fontSize:9}} onClick={e=>{e.stopPropagation();setConfirmDel(t.id);}}>remove</button>
              )}
              <div style={{color:'var(--dim)',fontSize:12}}>{open===t.id?'▲':'▼'}</div>
            </div>
          </div>
          {open===t.id && (
            <table className="rt">
              <thead><tr><th>Ring</th><th>Color</th><th>Outer Ø (in)</th><th>Mid radius</th></tr></thead>
              <tbody>
                {t.rings.map((r,i)=>{
                  const iR=i>0?t.rings[i-1].diam/2:0;
                  const oR=r.diam/2;
                  const col = r.color || DEFAULT_RING_COLORS[r.score] || '#aaa';
                  return (
                    <tr key={r.score}>
                      <td style={{fontFamily:'var(--fh)',fontWeight:700,fontSize:14,
                        color: isLightColor(col) ? col : 'var(--ink)'
                      }}>{r.score}</td>
                      <td>
                        <div style={{width:16,height:16,borderRadius:3,background:col,border:'1px solid var(--bdr)',display:'inline-block',verticalAlign:'middle'}}/>
                      </td>
                      <td>{r.diam.toFixed(3)}"</td>
                      <td>{((iR+oR)/2).toFixed(3)}"</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}

      {hiddenBuiltins.length > 0 && (
        <>
          <div className="shdr" style={{marginTop:8}}>Removed presets</div>
          {hiddenBuiltins.map(t=>(
            <div key={t.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'9px 13px',margin:'0 13px 6px',background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:7,opacity:0.65}}>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <div style={{display:'flex',gap:2}}>
                  {t.rings.map(r=>(
                    <div key={r.score} style={{width:6,height:14,borderRadius:2,background:r.color||'#aaa',border:'1px solid var(--bdr)'}}/>
                  ))}
                </div>
                <div>
                  <div style={{fontFamily:'var(--fh)',fontSize:13,fontWeight:700}}>{t.name}</div>
                  <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>{t.desc}</div>
                </div>
              </div>
              <button style={{background:'none',border:'1px solid var(--bdr)',borderRadius:4,padding:'4px 10px',fontFamily:'var(--fm)',fontSize:9,color:'var(--acc)',cursor:'pointer'}}
                onClick={()=>onRestoreBuiltin(t.id)}>restore</button>
            </div>
          ))}
        </>
      )}

      <div className="tnote">
        NRA HP ring dimensions are approximate. Verify against current rulebook before competition use.<br/>
        1 MOA = 1.0472" per 100 yards.
      </div>
    </div>
  );
}

/* ── Firearms tab: round-count tracking + barrel life + per-firearm group trend ── */
function FirearmsTab({ firearms, sessions, getTarget, onSave, ammo, onSaveAmmo, core }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);

  if (adding) {
    return <AddFirearmForm
      onBack={()=>setAdding(false)}
      onSave={r => { onSave([...firearms, r]); setAdding(false); }}
    />;
  }
  if (editing) {
    const r = firearms.find(x=>x.id===editing);
    if (r) return <AddFirearmForm
      initial={r}
      onBack={()=>setEditing(null)}
      onSave={upd => { onSave(firearms.map(x=>x.id===editing?upd:x)); setEditing(null); }}
    />;
  }

  if (firearms.length === 0) {
    return (
      <div>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 13px 5px'}}>
          <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.14em',textTransform:'uppercase'}}>Firearms</div>
          <button className="badd" onClick={()=>setAdding(true)} style={{fontSize:11,padding:'5px 11px'}}>+ firearm</button>
        </div>
        <div className="empty">
          <div className="et">No firearms yet</div>
          <div className="es">Add a firearm to track round count against barrel life and see per-firearm group trends.</div>
        </div>
        <AmmoSection ammo={ammo} firearms={firearms} sessions={sessions} getTarget={getTarget} onSaveAmmo={onSaveAmmo} core={core} />
      </div>
    );
  }

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 13px 5px'}}>
        <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.14em',textTransform:'uppercase'}}>Firearms</div>
        <button className="badd" onClick={()=>setAdding(true)} style={{fontSize:11,padding:'5px 11px'}}>+ firearm</button>
      </div>

      {firearms.map(r => {
        const status = firearmBarrelLifeStatus(r, sessions);
        const count = firearmRoundCount(r, sessions);
        const firearmSessions = sessions.filter(s => s.rifleId === r.id);
        const isOpen = open === r.id;
        return (
          <div className="tcard" key={r.id}>
            <div className="tch" onClick={()=>setOpen(isOpen?null:r.id)}>
              <div style={{flex:1,minWidth:0}}>
                <div className="tcn">{r.name}</div>
                <div className="tcd">
                  {r.caliber||'—'}{r.caliber&&' · '}<span style={{color:'var(--acc)',fontWeight:700}}>{count.toLocaleString()} rds</span>
                  {status && <> · <span style={{color:'var(--dim)'}}>of {status.life.toLocaleString()}</span></>}
                </div>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                {confirmDel === r.id ? (
                  <div style={{display:'flex',gap:4,alignItems:'center',flexShrink:0}} onClick={e=>e.stopPropagation()}>
                    <button style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--red)',background:'none',border:'1px solid var(--red)',borderRadius:3,padding:'2px 7px',cursor:'pointer'}}
                      onClick={()=>{ onSave(firearms.filter(x=>x.id!==r.id)); setConfirmDel(null); }}>delete</button>
                    <button style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',background:'none',border:'1px solid var(--bdr)',borderRadius:3,padding:'2px 7px',cursor:'pointer'}}
                      onClick={()=>setConfirmDel(null)}>×</button>
                  </div>
                ) : (
                  <>
                    <button onClick={e=>{e.stopPropagation();setEditing(r.id);}}
                      style={{background:'none',border:'1px solid var(--bdr)',borderRadius:3,padding:'2px 7px',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer'}}>edit</button>
                    <button onClick={e=>{e.stopPropagation();setConfirmDel(r.id);}}
                      style={{background:'none',border:'none',color:'var(--dim)',cursor:'pointer',fontSize:15,padding:'0 4px'}}>×</button>
                  </>
                )}
                <div style={{color:'var(--dim)',fontSize:11}}>{isOpen?'▾':'▸'}</div>
              </div>
            </div>

            {isOpen && (
              <div style={{padding:'4px 13px 12px'}}>
                {/* Round count panel — counting UP from start, not down from threshold */}
                <div style={{marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:6}}>
                    <div>
                      <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.1em',textTransform:'uppercase'}}>Rounds fired</div>
                      <div style={{fontFamily:'var(--fh)',fontSize:22,fontWeight:700,color: status && status.pct >= 0.85 ? 'var(--red)' : 'var(--acc)',lineHeight:1.1,marginTop:2}}>
                        {count.toLocaleString()}
                      </div>
                    </div>
                    {status && (
                      <div style={{textAlign:'right'}}>
                        <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.1em',textTransform:'uppercase'}}>of barrel life</div>
                        <div style={{fontFamily:'var(--fm)',fontSize:11,color:'var(--ink)',marginTop:2}}>
                          {status.life.toLocaleString()} <span style={{color: status.pct >= 0.85 ? 'var(--red)' : status.pct >= 0.6 ? 'var(--acc)' : 'var(--green)'}}>· {(status.pct*100).toFixed(0)}%</span>
                        </div>
                      </div>
                    )}
                  </div>
                  {status && (
                    <>
                      <div style={{height:6,background:'var(--surf2)',borderRadius:3,overflow:'hidden'}}>
                        <div style={{
                          height:'100%',width:`${Math.min(100,status.pct*100)}%`,
                          background: status.pct >= 0.85 ? 'var(--red)' : status.pct >= 0.6 ? 'var(--acc)' : 'var(--green)',
                          transition:'width .3s',
                        }}/>
                      </div>
                      {r.roundsAtStart > 0 && (
                        <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',marginTop:4}}>
                          Started at {(+r.roundsAtStart).toLocaleString()} rds · {(count - (+r.roundsAtStart || 0)).toLocaleString()} logged in this app
                        </div>
                      )}
                      {status.pct >= 0.85 && (
                        <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--red)',marginTop:5}}>
                          ⚠ Approaching end of accurate barrel life. Watch group size for degradation.
                        </div>
                      )}
                    </>
                  )}
                  {!status && r.roundsAtStart > 0 && (
                    <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',marginTop:4}}>
                      Started at {(+r.roundsAtStart).toLocaleString()} rds · {(count - (+r.roundsAtStart || 0)).toLocaleString()} logged in this app
                    </div>
                  )}
                </div>

                <FirearmGroupTrend sessions={firearmSessions} firearm={r} getTarget={getTarget} />

                {r.notes && (
                  <div style={{marginTop:10,padding:'8px 10px',background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:5,fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)',lineHeight:1.5}}>
                    {r.notes}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="tnote">
        Round count includes starting round count plus all shots logged in sessions that reference this firearm. Barrel life is a shooter-set threshold; actual accurate life varies by chambering, powder, and cleaning regimen.
      </div>

      <AmmoSection ammo={ammo} firearms={firearms} sessions={sessions} getTarget={getTarget} onSaveAmmo={onSaveAmmo} />
    </div>
  );
}

/* Ammunition loads — handload tracking. Each load: name, optional firearm
 * binding, and load data (bullet / powder / charge / OAL). Sessions reference
 * loads by ammoId; the analytics table aggregates per-session MR/ES via
 * ammoStats (per-session groups about their own centers, shot-weighted MR —
 * see ammoStats for why raw cross-session pooling would be wrong).
 */
function AmmoSection({ ammo, firearms, sessions, getTarget, onSaveAmmo, core }) {
  const [form, setForm] = useState(null); // null | {id?, name, rifleId, bullet, powder, charge, oal, notes}
  const [confirmDel, setConfirmDel] = useState(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [profiles, setProfiles] = useState(null);   // null=loading, []=empty, [rows]
  const [pickErr, setPickErr] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(null);
  const linkedCount = ammo.filter(a => a.batchId).length;

  async function openPicker() {
    setPickOpen(true); setProfiles(null); setPickErr(null);
    const r = await core.ballisticProfiles('quarantined=eq.false&order=loaded_on.desc');
    if (!r.ok) { setPickErr('Could not reach the Bench backend.'); setProfiles([]); return; }
    setProfiles(r.data || []);
  }

  function importBatch(p) {
    if (ammo.some(a => a.batchId === p.batch_id)) return;
    onSaveAmmo([...ammo, ammoFromProfile(p, Date.now())]);
  }

  async function refreshNow() {
    setRefreshing(true);
    const next = await refreshLinkedBatches(core, ammo, Date.now());
    setRefreshing(false);
    if (next) onSaveAmmo(next);
    setRefreshed(next ? 'updated' : 'current');
    setTimeout(() => setRefreshed(null), 2500);
  }
  const blank = { name:'', rifleId:'', bullet:'', powder:'', charge:'', oal:'', notes:'' };
  const fname = id => firearms.find(f=>f.id===id)?.name || '';

  function saveForm() {
    if (!form.name.trim()) return;
    const rec = { ...form, name: form.name.trim(), ts: form.ts || Date.now() };
    if (rec.id) onSaveAmmo(ammo.map(a=>a.id===rec.id?rec:a));
    else onSaveAmmo([...ammo, { ...rec, id: uid() }]);
    setForm(null);
  }

  // Stats rows for loads with at least one qualifying session
  const stats = ammo
    .map(a => ({ a, s: ammoStats(sessions, a.id, getTarget) }))
    .filter(r => r.s);

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'18px 13px 5px'}}>
        <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.14em',textTransform:'uppercase'}}>Ammunition</div>
        {!form && (
          <div style={{display:'flex',gap:6}}>
            {core && core.isSignedIn() && linkedCount > 0 && (
              <button className="badd" onClick={refreshNow} disabled={refreshing}
                title="Re-read every linked batch from Bench"
                style={{fontSize:11,padding:'5px 9px',background:'none',border:'1px solid var(--bdr)',color:'var(--dim)',opacity:refreshing?0.5:1}}>
                {refreshing ? '…' : refreshed === 'updated' ? '✓ updated' : refreshed === 'current' ? '✓ current' : '⟳'}</button>
            )}
            {core && core.isSignedIn() && (
              <button className="badd" onClick={openPicker}
                style={{fontSize:11,padding:'5px 11px',background:'none',border:'1px solid var(--bdr)',color:'var(--ink)'}}>⇣ Bench</button>
            )}
            <button className="badd" onClick={()=>setForm({...blank})} style={{fontSize:11,padding:'5px 11px'}}>+ load</button>
          </div>
        )}
      </div>

      {pickOpen && (
        <div className="tcard" style={{padding:'11px 13px'}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
            <div className="lbl">Batches from Bench</div>
            <button onClick={()=>setPickOpen(false)} style={{background:'none',border:'none',color:'var(--dim)',cursor:'pointer',fontSize:14,padding:0}}>×</button>
          </div>
          {profiles === null && <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)'}}>loading…</div>}
          {pickErr && <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--red)'}}>{pickErr}</div>}
          {profiles && !pickErr && profiles.length === 0 && (
            <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)'}}>No live batches in Bench.</div>)}
          {profiles && profiles.map(p => {
            const linkedAlready = ammo.some(a => a.batchId === p.batch_id);
            return (
              <div key={p.batch_id} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 0',borderTop:'1px solid var(--bdr)'}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontFamily:'var(--fm)',fontSize:11,color:'var(--ink)'}}>{p.serial}
                    {p.untested && <span style={{color:'var(--acc)',fontSize:8,marginLeft:6}}>UNTESTED</span>}
                    {p.over_published_max && <span style={{color:'var(--red)',fontSize:8,marginLeft:6}}>OVER MAX</span>}
                  </div>
                  <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {[p.load_name, p.cartridge,
                      p.powder_name && `${p.charge_actual_gr ?? p.charge_gr ?? '?'}gr ${p.powder_name}`,
                      p.muzzle_velocity_fps && `${Math.round(p.muzzle_velocity_fps)}fps`,
                      p.qty_remaining!=null?`${p.qty_remaining} rds`:null].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <button className="badd" disabled={linkedAlready} onClick={()=>importBatch(p)}
                  style={{fontSize:9,padding:'4px 9px',opacity:linkedAlready?0.35:1}}>{linkedAlready?'linked':'import'}</button>
              </div>
            );
          })}
        </div>
      )}

      {form && (
        <div className="tcard" style={{padding:'11px 13px'}}>
          <div className="lbl" style={{marginBottom:8}}>{form.id ? 'Edit load' : 'New load'}</div>
          <div style={{display:'flex',flexDirection:'column',gap:7}}>
            <input className="inp" value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))}
              placeholder="Load name (e.g. 77gr SMK · 23.5 Varget)" autoFocus/>
            <select className="inp" value={form.rifleId} onChange={e=>setForm(p=>({...p,rifleId:e.target.value}))}>
              <option value="">Any firearm</option>
              {firearms.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:7}}>
              <input className="inp" value={form.bullet} onChange={e=>setForm(p=>({...p,bullet:e.target.value}))} placeholder="Bullet (77gr SMK)"/>
              <input className="inp" value={form.powder} onChange={e=>setForm(p=>({...p,powder:e.target.value}))} placeholder="Powder (Varget)"/>
              <input className="inp" type="number" step="0.1" value={form.charge} onChange={e=>setForm(p=>({...p,charge:e.target.value}))} placeholder="Charge (gr)"/>
              <input className="inp" type="number" step="0.001" value={form.oal} onChange={e=>setForm(p=>({...p,oal:e.target.value}))} placeholder="OAL (in)"/>
            </div>
            <input className="inp" value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} placeholder="Notes (primer, brass, lot...)"/>
            <div style={{display:'flex',gap:6}}>
              <button className="badd" onClick={saveForm} style={{flex:1,opacity:form.name.trim()?1:0.4}}>save</button>
              <button onClick={()=>setForm(null)} style={{flex:1,background:'none',border:'1px solid var(--bdr)',borderRadius:5,fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)',cursor:'pointer'}}>cancel</button>
            </div>
          </div>
        </div>
      )}

      {ammo.length === 0 && !form && (
        <div className="empty">
          <div className="et" style={{fontSize:14}}>No loads yet</div>
          <div className="es">Add a load to track handload groups — pick it when creating a session and per-load ES/MR lands in the table here.</div>
        </div>
      )}

      {ammo.map(a => (
        <div className="tcard" key={a.id}>
          <div className="tch" style={{cursor:'default'}}>
            <div style={{flex:1,minWidth:0}}>
              <div className="tcn">{a.name}</div>
              <div className="tcd">
                {[a.batchSerial && `⛓ ${a.batchSerial}`, a.bullet, a.powder && `${a.charge?a.charge+'gr ':''}${a.powder}`, a.oal && `OAL ${a.oal}"`, a.rifleId && fname(a.rifleId)]
                  .filter(Boolean).join(' · ') || '—'}
              </div>
              {a.notes && <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',marginTop:2}}>{a.notes}</div>}
            </div>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              {confirmDel === a.id ? (
                <div style={{display:'flex',gap:4,alignItems:'center',flexShrink:0}}>
                  <button style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--red)',background:'none',border:'1px solid var(--red)',borderRadius:3,padding:'2px 7px',cursor:'pointer'}}
                    onClick={()=>{ onSaveAmmo(ammo.filter(x=>x.id!==a.id)); setConfirmDel(null); }}>delete</button>
                  <button style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',background:'none',border:'1px solid var(--bdr)',borderRadius:3,padding:'2px 7px',cursor:'pointer'}}
                    onClick={()=>setConfirmDel(null)}>×</button>
                </div>
              ) : (
                <>
                  <button onClick={()=>setForm({...blank, ...a})}
                    style={{background:'none',border:'1px solid var(--bdr)',borderRadius:3,padding:'2px 7px',fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer'}}>edit</button>
                  <button onClick={()=>setConfirmDel(a.id)}
                    style={{background:'none',border:'none',color:'var(--dim)',cursor:'pointer',fontSize:15,padding:'0 4px'}}>×</button>
                </>
              )}
            </div>
          </div>
          <BatchFacts a={a}/>
        </div>
      ))}

      {stats.length > 0 && (
        <div className="tcard" style={{padding:'11px 13px'}}>
          <div className="lbl" style={{marginBottom:7}}>Load performance</div>
          <table style={{width:'100%',borderCollapse:'collapse',fontFamily:'var(--fm)',fontSize:10}}>
            <thead>
              <tr style={{color:'var(--dim)',fontSize:8,textTransform:'uppercase',letterSpacing:'.08em'}}>
                <th style={{textAlign:'left',padding:'3px 4px 5px',fontWeight:400}}>Load</th>
                <th style={{textAlign:'right',padding:'3px 4px 5px',fontWeight:400}}>MR MOA</th>
                <th style={{textAlign:'right',padding:'3px 4px 5px',fontWeight:400}}>ES MOA</th>
                <th style={{textAlign:'right',padding:'3px 4px 5px',fontWeight:400}}>Shots</th>
              </tr>
            </thead>
            <tbody>
              {[...stats].sort((x,y)=>x.s.mrMoa - y.s.mrMoa).map(({a,s}) => (
                <tr key={a.id} style={{borderTop:'1px solid var(--bdr)'}}>
                  <td style={{padding:'5px 4px',color:'var(--ink)',maxWidth:130,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{a.name}</td>
                  <td style={{padding:'5px 4px',textAlign:'right',color:'var(--acc)',fontWeight:700}}>{s.mrMoa.toFixed(2)}</td>
                  <td style={{padding:'5px 4px',textAlign:'right',color:'var(--ink)'}}>{s.esMoa.toFixed(2)}</td>
                  <td style={{padding:'5px 4px',textAlign:'right',color:'var(--dim)'}}>{s.shots}<span style={{fontSize:8}}> / {s.sessions}s</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{fontFamily:'var(--fm)',fontSize:8.5,color:'var(--dim)',marginTop:6,lineHeight:1.5}}>
            MR is shot-weighted across sessions (each group measured about its own center). ES is the per-session average — it grows with shots per session, so compare loads with similar counts. Sessions under 3 record shots excluded.
          </div>
        </div>
      )}
    </div>
  );
}

/* Small inline chart: shows ES MOA over sessions for one firearm, correlated with round count */
function FirearmGroupTrend({ sessions, firearm, getTarget }) {
  const data = sessions
    .map(s => {
      const t = getTarget(s.targetId);
      const a = analytics(s.shots||[], t, s.rangeYards);
      if (!a || a.n < 2) return null;
      return { date: s.date, es: a.esMoa, n: (s.shots||[]).length, ts: s.ts };
    })
    .filter(Boolean)
    .sort((a,b)=>a.ts-b.ts);

  if (data.length < 2) {
    return (
      <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--dim)',padding:'10px 0',textAlign:'center'}}>
        Log 2+ sessions with this firearm to see group trend.
      </div>
    );
  }

  // Running cumulative round count at each session
  let cum = +firearm.roundsAtStart || 0;
  const withCount = data.map(d => {
    cum += d.n;
    return { ...d, cum };
  });

  const W=320, H=110, PL=34, PR=10, PT=8, PB=20;
  const maxES = Math.max(...withCount.map(d=>d.es))*1.15 || 1;
  const minC = withCount[0].cum - (withCount[0].n || 0);
  const maxC = withCount[withCount.length-1].cum;
  const rngC = maxC - minC || 1;
  const gx = c => (PL + ((c-minC)/rngC)*(W-PL-PR)).toFixed(1);
  const gy = es => (PT + (1-(es/maxES))*(H-PT-PB)).toFixed(1);

  const path = withCount.map((d,i) => `${i?'L':'M'} ${gx(d.cum)} ${gy(d.es)}`).join(' ');

  return (
    <div>
      <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:4}}>
        Group size vs round count
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',background:'var(--surf2)',borderRadius:5}}>
        {[0, maxES/2, maxES].map((v,i)=>(
          <g key={i}>
            <line x1={PL} y1={gy(v)} x2={W-PR} y2={gy(v)} stroke="#ffffff10" strokeWidth={1}/>
            <text x={PL-3} y={+gy(v)+3} textAnchor="end" fill="var(--dim)" fontSize={7} fontFamily="Space Mono,monospace">{v.toFixed(1)}</text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--acc)" strokeWidth={1.8}/>
        {withCount.map((d,i)=>(
          <circle key={i} cx={gx(d.cum)} cy={gy(d.es)} r={3} fill="var(--acc)"/>
        ))}
        <text x={PL} y={H-5} fill="var(--dim)" fontSize={7} fontFamily="Space Mono,monospace">{minC}</text>
        <text x={W-PR} y={H-5} textAnchor="end" fill="var(--dim)" fontSize={7} fontFamily="Space Mono,monospace">{maxC} rds</text>
        <text x={PL-3} y={PT+4} textAnchor="end" fill="var(--dim)" fontSize={7} fontFamily="Space Mono,monospace">MOA</text>
      </svg>
    </div>
  );
}

/* ── Add/edit firearm form ── */
function AddFirearmForm({ initial, onBack, onSave }) {
  const [name, setName] = useState(initial?.name || '');
  const [caliber, setCaliber] = useState(initial?.caliber || '');
  const [barrelLife, setBarrelLife] = useState(initial?.barrelLife ? String(initial.barrelLife) : '');
  const [roundsAtStart, setRoundsAtStart] = useState(initial?.roundsAtStart ? String(initial.roundsAtStart) : '0');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [error, setError] = useState('');

  function doSave() {
    if (!name.trim()) { setError('Firearm needs a name.'); return; }
    const bl = parseInt(barrelLife, 10);
    const rs = parseInt(roundsAtStart, 10);
    if (barrelLife && (isNaN(bl) || bl <= 0)) { setError('Barrel life must be a positive integer.'); return; }
    if (roundsAtStart && (isNaN(rs) || rs < 0)) { setError('Starting round count must be zero or positive.'); return; }
    setError('');
    onSave({
      id: initial?.id || uid(),
      name: name.trim(),
      caliber: caliber.trim(),
      barrelLife: barrelLife ? bl : null,
      roundsAtStart: roundsAtStart ? rs : 0,
      notes: notes.trim(),
      ts: initial?.ts || Date.now(),
    });
  }

  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="hdr">
          <button className="bback" onClick={onBack}>← back</button>
          <div style={{fontFamily:'var(--fh)',fontSize:15,fontWeight:700}}>{initial?'Edit firearm':'New firearm'}</div>
          <div style={{width:48}}/>
        </div>
        <div className="content">
          <div className="form">
            <div className="field">
              <div className="lbl">Name</div>
              <input className="inp" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Service Rifle, Glock 17, etc." autoFocus/>
            </div>
            <div className="field">
              <div className="lbl">Caliber / chambering</div>
              <input className="inp" value={caliber} onChange={e=>setCaliber(e.target.value)} placeholder="e.g. .223 Wylde, 6mm Creedmoor"/>
            </div>
            <div className="row2">
              <div className="field">
                <div className="lbl">Barrel life (rds)</div>
                <input className="inp" type="number" value={barrelLife} onChange={e=>setBarrelLife(e.target.value)} placeholder="e.g. 5000"/>
              </div>
              <div className="field">
                <div className="lbl">Starting round count</div>
                <input className="inp" type="number" value={roundsAtStart} onChange={e=>setRoundsAtStart(e.target.value)} placeholder="0"/>
              </div>
            </div>
            <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',lineHeight:1.5,padding:'2px 0',marginTop:-4}}>
              Set <strong style={{color:'var(--ink)'}}>starting round count</strong> if this barrel already has rounds through it before you started logging here. The app will count up from this value as you log shots in sessions.
            </div>
            <div className="field">
              <div className="lbl">Notes</div>
              <textarea className="inp" value={notes} onChange={e=>setNotes(e.target.value)}
                rows={3}
                placeholder="Twist rate, gunsmith notes, load data..."
                style={{resize:'vertical',fontFamily:'var(--fm)',fontSize:11}}/>
            </div>
            <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',lineHeight:1.5,padding:'4px 0'}}>
              Typical match barrel life estimates — rifles: .223 ~5,000 · 6mm/6.5mm ~2,500–3,500 · .308 ~3,000–4,000 · magnums ~1,200–2,000 rds. Pistols: 9mm ~50,000+ · .40 ~30,000 · .45 ACP ~30,000+. Numbers vary widely by chambering, pressure, and load.
            </div>
            {error && (
              <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--red)',background:'#f0606022',border:'1px solid var(--red)',borderRadius:5,padding:'8px 11px'}}>
                {error}
              </div>
            )}
            <button className="bprim" onClick={doSave}>{initial?'Save changes':'Save firearm'}</button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Add custom target form with color picker ── */
function AddTargetForm({ onBack, onSave }) {
  const [mode, setMode] = useState('rings'); // rings | quick | plate
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [rings, setRings] = useState([
    {score:'X',  diam:'', color: DEFAULT_RING_COLORS['X']},
    {score:'10', diam:'', color: DEFAULT_RING_COLORS['10']},
    {score:'9',  diam:'', color: DEFAULT_RING_COLORS['9']},
    {score:'8',  diam:'', color: DEFAULT_RING_COLORS['8']},
  ]);
  const [expandedColorPicker, setExpandedColorPicker] = useState(null);
  const [error, setError] = useState('');
  // Quick-create: auto-spaced rings from three numbers, then drops into the
  // rings editor for tweaks — generation is a starting point, not a commit.
  const [qOuter, setQOuter] = useState('');
  const [qCount, setQCount] = useState('5');
  const [qX, setQX] = useState(true);
  // Plate: parametric hit/miss (or point-valued) steel.
  const [pShape, setPShape] = useState('circle'); // circle | square | rect
  const [pW, setPW] = useState(''); const [pH, setPH] = useState('');
  const [pScore, setPScore] = useState('1');

  function genQuickRings() {
    const outer = parseFloat(qOuter), n = parseInt(qCount);
    if (isNaN(outer) || outer<=0 || isNaN(n) || n<2 || n>12) { setError('Quick create needs outer diameter and 2–12 rings.'); return; }
    const scores = [];
    if (qX) scores.push('X');
    for (let s=10; scores.length<n; s--) scores.push(String(s));
    const defColors = ['#e8943a','#f0f2f8','#3db87a','#7a7f96','#4a5068','#3a7abf','#9a2e1e','#2e8a7a','#b0aba0','#6b3a9a','#c47a3a','#dddddd'];
    setRings(scores.map((s,i)=>({ score:s, diam:(outer*(i+1)/n).toFixed(2), color: DEFAULT_RING_COLORS[s]||defColors[i]||'#888888' })));
    setError(''); setMode('rings');
  }
  function saveZoneTarget(zones, fallbackName, fallbackDesc) {
    if (!zones.length) { setError('No zones defined.'); return; }
    onSave({
      id: uid(), name: name.trim() || fallbackName, desc: desc.trim() || fallbackDesc,
      zones, rings: synthRingsFromZones(zones), builtin: false,
    });
  }
  function savePlate() {
    const w = parseFloat(pW), h = pShape==='rect' ? parseFloat(pH) : parseFloat(pW);
    if (isNaN(w) || w<=0 || (pShape==='rect' && (isNaN(h)||h<=0))) { setError('Plate needs positive dimensions in inches.'); return; }
    const shape = pShape==='circle' ? {kind:'circle', d:w} : {kind:'rect', w, h, rx: 0.25};
    const score = (pScore.trim()||'1');
    const dims = pShape==='circle' ? `${w}" round` : `${w}"×${h}"`;
    saveZoneTarget([{ score, color:'#7a7f96', shape }], `${dims} plate`, `Steel plate · hit=${score}`);
  }

  function setRingField(i, field, val) {
    setRings(prev=>prev.map((r,idx)=>idx===i?{...r,[field]:val}:r));
  }
  function addRing() {
    const defaults = ['X','10','9','8','7'];
    const defColors = Object.values(DEFAULT_RING_COLORS);
    const i = rings.length;
    setRings(prev=>[...prev,{score:defaults[i]||'',diam:'',color:defColors[i]||'#888888'}]);
  }
  function removeRing(i) { if(rings.length<=1) return; setRings(prev=>prev.filter((_,idx)=>idx!==i)); }

  function doSave() {
    if (!name.trim()) { setError('Target needs a name.'); return; }
    const parsed = rings.map(r=>({score:r.score.trim(), diam:parseFloat(r.diam), color:r.color||'#888888'}));
    if (parsed.some(r=>!r.score||isNaN(r.diam)||r.diam<=0)) {
      setError('All rings need a score label and a positive outer diameter in inches.');
      return;
    }
    setError('');
    parsed.sort((a,b)=>a.diam-b.diam);
    onSave({id:uid(), name:name.trim(), desc:desc.trim()||name.trim(), builtin:false, rings:parsed});
  }

  return (
    <>
      <style>{S}</style>
      <div className="app">
        <div className="hdr">
          <button className="bback" onClick={onBack}>← library</button>
          <div style={{fontFamily:'var(--fh)',fontSize:15,fontWeight:700}}>New target</div>
          <div style={{width:56}}/>
        </div>
        <div className="content">
          <div className="form">
            {/* Creation mode */}
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              {[['rings','Rings'],['quick','Quick rings'],['plate','Plate']].map(([m,lbl])=>(
                <button key={m} onClick={()=>{setMode(m);setError('');}} style={{
                  padding:'5px 10px',borderRadius:5,border:'1.5px solid',cursor:'pointer',
                  fontFamily:'var(--fm)',fontSize:10,
                  borderColor:mode===m?'var(--acc)':'var(--bdr)',
                  background:mode===m?'var(--surf2)':'transparent',
                  color:mode===m?'var(--acc)':'var(--dim)',
                }}>{lbl}</button>
              ))}
            </div>

            {mode==='quick' && (
              <div style={{background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:7,padding:'11px 12px',display:'flex',flexDirection:'column',gap:8}}>
                <div className="lbl">Quick rings — auto-spaced, then edit</div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:7}}>
                  <input className="inp" type="number" step="0.1" value={qOuter} onChange={e=>setQOuter(e.target.value)} placeholder='Outer diam (in)'/>
                  <input className="inp" type="number" value={qCount} onChange={e=>setQCount(e.target.value)} placeholder='Ring count'/>
                </div>
                <label style={{display:'flex',gap:7,alignItems:'center',fontFamily:'var(--fm)',fontSize:10,color:'var(--ink)'}}>
                  <input type="checkbox" checked={qX} onChange={e=>setQX(e.target.checked)}/> innermost ring is X
                </label>
                <button className="badd" onClick={genQuickRings}>generate → edit rings</button>
                <div style={{fontFamily:'var(--fm)',fontSize:8.5,color:'var(--dim)'}}>Diameters spaced evenly to the outer edge. Adjust any of them in the Rings editor before saving.</div>
              </div>
            )}

            {mode==='plate' && (
              <div style={{background:'var(--surf2)',border:'1px solid var(--bdr)',borderRadius:7,padding:'11px 12px',display:'flex',flexDirection:'column',gap:8}}>
                <div className="lbl">Steel plate — hit/miss</div>
                <div style={{display:'flex',gap:5}}>
                  {[['circle','Round'],['square','Square'],['rect','Rectangle']].map(([s,lbl])=>(
                    <button key={s} onClick={()=>setPShape(s)} style={{flex:1,padding:'5px',borderRadius:5,border:`1.5px solid ${pShape===s?'var(--acc)':'var(--bdr)'}`,background:'none',color:pShape===s?'var(--acc)':'var(--dim)',fontFamily:'var(--fm)',fontSize:10,cursor:'pointer'}}>{lbl}</button>
                  ))}
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:7}}>
                  <input className="inp" type="number" step="0.5" value={pW} onChange={e=>setPW(e.target.value)} placeholder={pShape==='circle'?'Diameter (in)':'Width (in)'}/>
                  {pShape==='rect'
                    ? <input className="inp" type="number" step="0.5" value={pH} onChange={e=>setPH(e.target.value)} placeholder='Height (in)'/>
                    : <input className="inp" value={pScore} onChange={e=>setPScore(e.target.value)} placeholder='Hit value (1)'/>}
                </div>
                {pShape==='rect' && <input className="inp" value={pScore} onChange={e=>setPScore(e.target.value)} placeholder='Hit value (1)'/>}
                <button className="badd" onClick={savePlate}>create plate target</button>
              </div>
            )}


            <div className="row2">
              <div className="field" style={{flex:'0 0 90px'}}>
                <div className="lbl">Short name</div>
                <input className="inp" value={name} onChange={e=>setName(e.target.value)} placeholder="MR-31" maxLength={10}/>
              </div>
              <div className="field" style={{flex:1}}>
                <div className="lbl">Description</div>
                <input className="inp" value={desc} onChange={e=>setDesc(e.target.value)} placeholder="e.g. 200yd prone slow fire"/>
              </div>
            </div>

            {/* Preview + ring editor + save: rings mode only. Quick-create
                switches back to this mode after generating; plate mode saves
                from its own button. */}
            {mode==='rings' && <>
            {rings.some(r=>parseFloat(r.diam)>0) && (
              <div>
                <div className="lbl" style={{marginBottom:5}}>Preview</div>
                <TargetPreviewStatic rings={rings.filter(r=>parseFloat(r.diam)>0).map(r=>({...r,diam:parseFloat(r.diam)})).sort((a,b)=>a.diam-b.diam)} />
              </div>
            )}

            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                <div className="lbl">Scoring rings</div>
                <button onClick={addRing} style={{background:'none',border:'1px solid var(--bdr)',borderRadius:4,padding:'4px 10px',fontFamily:'var(--fm)',fontSize:10,color:'var(--acc)',cursor:'pointer'}}>+ ring</button>
              </div>

              {rings.map((r,i)=>(
                <div key={i} style={{background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:7,padding:'9px 11px',marginBottom:8}}>
                  <div style={{display:'grid',gridTemplateColumns:'70px 1fr 28px',gap:7,alignItems:'center',marginBottom: expandedColorPicker===i ? 8 : 0}}>
                    <input className="ringinp" value={r.score}
                      onChange={e=>setRingField(i,'score',e.target.value)}
                      placeholder={['X','10','9','8','7'][i]||'label'}
                      style={{color: isLightColor(r.color||'#888') ? (r.color||'var(--ink)') : 'var(--ink)', fontWeight:700}}
                    />
                    <input className="ringinp" type="number" step="0.001" min="0.001"
                      value={r.diam}
                      onChange={e=>setRingField(i,'diam',e.target.value)}
                      placeholder="outer Ø (inches)"/>
                    <button onClick={()=>removeRing(i)} style={{background:'none',border:'none',color:'var(--dim)',cursor:'pointer',fontSize:16,lineHeight:1,padding:'0 2px'}}>×</button>
                  </div>

                  {/* Color row */}
                  <div style={{display:'flex',alignItems:'center',gap:8,marginTop:6}}>
                    <div className="lbl" style={{flexShrink:0}}>Ring color</div>
                    <div
                      style={{width:22,height:22,borderRadius:4,background:r.color||'#888',border:'1.5px solid var(--bdr)',cursor:'pointer',flexShrink:0}}
                      onClick={()=>setExpandedColorPicker(expandedColorPicker===i?null:i)}
                    />
                    {expandedColorPicker===i && (
                      <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)'}}>tap to pick →</div>
                    )}
                    {expandedColorPicker!==i && (
                      <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',cursor:'pointer'}} onClick={()=>setExpandedColorPicker(i)}>
                        {r.color||'#888'} · tap to change
                      </div>
                    )}
                  </div>
                  {expandedColorPicker===i && (
                    <div style={{marginTop:6}}>
                      <RingColorPicker color={r.color||'#888888'} onChange={c=>{ setRingField(i,'color',c); }} />
                    </div>
                  )}
                </div>
              ))}

              <div style={{fontFamily:'var(--fm)',fontSize:9,color:'var(--dim)',lineHeight:1.7,marginTop:4}}>
                Enter the outer diameter of each ring in inches. Rings are auto-sorted smallest → largest on save.
              </div>
            </div>

            {error && (
              <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--red)',background:'#f0606022',border:'1px solid var(--red)',borderRadius:5,padding:'8px 11px'}}>
                {error}
              </div>
            )}
            <button className="bprim" onClick={doSave}>Save target</button>
            </>}
            {mode!=='rings' && error && (
              <div style={{fontFamily:'var(--fm)',fontSize:10,color:'var(--red)',background:'#f0606022',border:'1px solid var(--red)',borderRadius:5,padding:'8px 11px'}}>
                {error}
              </div>
            )}
            <button className="bsec" onClick={onBack}>Cancel</button>
          </div>
        </div>
      </div>
    </>
  );
}

/* Static preview for the target builder (no shot dot) */
function TargetPreviewStatic({ rings }) {
  const SZ = 140;
  const c = SZ / 2;
  const maxR = Math.max(...rings.map(r=>r.diam/2));
  const sc = (SZ * 0.86) / (maxR * 2);
  return (
    <div style={{background:'var(--surf)',border:'1px solid var(--bdr)',borderRadius:9,overflow:'hidden'}}>
      <svg viewBox={`0 0 ${SZ} ${SZ}`} style={{width:'100%',display:'block',background:'#1a1d27',maxHeight:140}}>
        {[...rings].reverse().map((r, revIdx) => {
          const fwdIdx = rings.length - 1 - revIdx;
          const col = r.color||'#aaa';
          const outerCol = fwdIdx < rings.length - 1 ? (rings[fwdIdx+1].color||'#aaa') : '#0f1117';
          const ringW = fwdIdx > 0 ? (r.diam/2 - rings[fwdIdx-1].diam/2) * sc : r.diam/2*sc;
          const sw = Math.min(1.5, Math.max(0.6, ringW * 0.07));
          return (
            <circle key={r.score} cx={c} cy={c} r={r.diam/2*sc}
              fill={col} stroke={ringBorderColor(col, outerCol)} strokeWidth={sw}/>
          );
        })}
        {rings.map((r,i)=>{
          const oR = r.diam/2*sc;
          const iR = i>0 ? rings[i-1].diam/2*sc : 0;
          if (oR - iR < 7) return null;
          const labelR = (iR + oR) / 2;
          const col = r.color||'#aaa';
          const textCol = isLightColor(col) ? '#00000099' : '#ffffff99';
          return (
            <text key={r.score} x={c+labelR} y={c+3.5}
              textAnchor="middle" fill={textCol}
              fontSize={Math.min(10,(oR-iR)*0.55)}
              fontFamily="Space Mono,monospace">{r.score}</text>
          );
        })}
        <line x1={c-4} y1={c} x2={c+4} y2={c} stroke="#ffffff35" strokeWidth={0.5}/>
        <line x1={c} y1={c-4} x2={c} y2={c+4} stroke="#ffffff35" strokeWidth={0.5}/>
      </svg>
    </div>
  );
}
