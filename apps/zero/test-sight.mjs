/* The sight model, tested as arithmetic.
 *
 * Same extraction trick as test-geometry: Zero.jsx is one file with no
 * exports, so the functions are pulled out by name and rebuilt in a sandbox.
 * Brittle on purpose -- rename one and this fails loudly rather than quietly
 * testing nothing.
 *
 * What is actually at stake here is not the arithmetic, which is a
 * multiplication. It is that a stored CLICK is meaningless without the sight
 * it was turned on, and the app has two different right answers to "which
 * sight": the session's snapshot when decoding what was shot, the firearm's
 * current config when telling someone what to dial next. Most of the
 * assertions below exist to pin down which one is used where, because getting
 * that wrong produces numbers that are plausible, unlabelled and wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, 'Zero.jsx'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const section = (s) => console.log('\n' + s);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`test-sight: Zero.jsx has no function ${name} — renamed?`);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error(`test-sight: could not read the body of ${name}`);
};
/* `function f({ a, b })` destructures its parameters, so brace-matching from
 * the first `{` matches the parameter list and stops there. Skip the
 * parentheses first, then read the body. */
const grabDestructured = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`test-sight: Zero.jsx has no function ${name} — renamed?`);
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
  throw new Error(`test-sight: could not read the body of ${name}`);
};
/* Top-level `const NAME = ...;` up to the line's end. Used for the constants
 * the model is built on, so the suite reads the shipped values rather than a
 * second copy of them that can drift. */
const grabConst = (name) => {
  const m = new RegExp(`^const ${name} = .*?;`, 'm').exec(src);
  if (!m) throw new Error(`test-sight: Zero.jsx has no const ${name} — renamed?`);
  return m[0];
};

const CONSTS = ['MOA_PER_MIL', 'SIGHT_LEGACY', 'DRIFT_MIN_MOA', 'UNSPECIFIED_LOCATION'];
const NAMES = ['normSight', 'sightOf', 'sightClick', 'moaPerClick', 'clicksToMoa',
               'moaToUnit', 'unitToMoa', 'moaToClicks', 'sightUnitLabel', 'decOf',
               'dialDecimals', 'fmtDial', 'fmtMoaAsUnit', 'fmtMoaAsUnitAbs', 'sightLabel',
               'clicksPerUnit', 'zeroDriftInfo', 'locationLabel', 'locationKey'];
/* Both of these take a destructured object, so they need the parameter-list
   skipping grab: findConfirmedZero folds its candidates through zeroSlotKey --
   the same key the DOPE tab groups by, so the card and the pre-fill cannot
   disagree about what counts as one zero -- and extracting the caller without
   the callee threw at the first lookup. */
const DESTRUCTURED = ['findConfirmedZero', 'zeroSlotKey'];
const ALL = CONSTS.concat(NAMES, DESTRUCTURED);
const S = new Function(
  CONSTS.map(grabConst).join('\n') + '\n' +
  NAMES.map(grab).join('\n') + '\n' +
  DESTRUCTURED.map(grabDestructured).join('\n') +
  `\nreturn {${ALL.join(',')}};`)();

const QUARTER = { unit: 'moa', clickElev: 0.25, clickWind: 0.25 };
const EIGHTH  = { unit: 'moa', clickElev: 0.125, clickWind: 0.125 };
const HALF    = { unit: 'moa', clickElev: 0.5,  clickWind: 0.5 };
const MIL     = { unit: 'mil', clickElev: 0.1,  clickWind: 0.1 };
/* A match rear sight: half a minute of elevation, a quarter of windage. The
 * case a single click-value field cannot express. */
const SPLIT   = { unit: 'moa', clickElev: 0.5,  clickWind: 0.25 };

section('what a sight defaults to');
ok(S.sightOf(undefined).clickElev === 0.25 && S.sightOf(undefined).unit === 'moa',
   'nothing at all reads as the pre-feature 1/4 MOA');
ok(S.sightOf({}).clickElev === 0.25, 'a firearm with no sight field reads as 1/4 MOA');
ok(S.sightOf({ sight: { unit: 'mil' } }).clickElev === 0.1,
   'a mil sight with no detent stated defaults to 0.1, not to 0.25');
ok(S.normSight({ unit: 'moa', clickElev: 0 }).clickElev === 0.25
   && S.normSight({ unit: 'moa', clickElev: -0.5 }).clickElev === 0.25
   && S.normSight({ unit: 'moa', clickElev: 'half' }).clickElev === 0.25,
   'zero, negative and non-numeric detents fall back rather than dividing by zero later');
ok(S.normSight({ unit: 'furlongs' }).unit === 'moa', 'an unknown unit is MOA, not itself');

section('clicks into minutes');
ok(near(S.clicksToMoa(8, EIGHTH, 'e'), 1.0), 'eight clicks of 1/8 MOA is one minute');
ok(near(S.clicksToMoa(4, QUARTER, 'e'), 1.0), 'four clicks of 1/4 MOA is one minute');
ok(near(S.clicksToMoa(2, HALF, 'e'), 1.0), 'two clicks of 1/2 MOA is one minute');
ok(near(S.clicksToMoa(10, MIL, 'e'), S.MOA_PER_MIL),
   'ten clicks of 0.1 mil is one milliradian, which is 3.4377 MOA and not 1.0');
ok(near(S.MOA_PER_MIL, 180 * 60 / (1000 * Math.PI), 1e-8),
   'the mil constant is the real one (180*60/1000pi), not the 3.6"/100yd shorthand');
ok(S.clicksToMoa(0, MIL, 'e') === 0 && S.clicksToMoa(null, QUARTER, 'e') === 0,
   'no dial is no angle, including when the field is null');

section('the two axes are allowed to disagree');
ok(near(S.clicksToMoa(4, SPLIT, 'e'), 2.0) && near(S.clicksToMoa(4, SPLIT, 'w'), 1.0),
   'four clicks is 2 MOA of elevation and 1 MOA of windage on a split sight');
ok(S.clicksPerUnit(SPLIT, 'e') === 2 && S.clicksPerUnit(SPLIT, 'w') === 4,
   'one whole minute is two elevation clicks and four windage clicks on that sight');
ok(S.clicksPerUnit(MIL, 'e') === 10 && S.clicksPerUnit(EIGHTH, 'e') === 8,
   'one whole unit is ten clicks on a 0.1-mil scope and eight on a 1/8-MOA scope');
ok(S.sightLabel(SPLIT) === '1/2 MOA elev · 1/4 MOA wind',
   'a split sight names both axes rather than averaging them away');
ok(S.sightLabel(QUARTER) === '1/4 MOA/click', 'a matched sight names one');

section('precision follows the detent');
ok(S.dialDecimals(EIGHTH, 'e') === 3, '1/8 MOA prints three decimals, or 0.375 is unrepresentable');
ok(S.dialDecimals(QUARTER, 'e') === 2, '1/4 MOA prints two');
ok(S.dialDecimals(HALF, 'e') === 1 && S.dialDecimals(MIL, 'e') === 1,
   '1/2 MOA and 0.1 mil print one — a second decimal would be a setting no turret has');
ok(S.fmtDial(3, EIGHTH, 'e') === '+0.375', 'three clicks of 1/8 MOA is +0.375');
ok(S.fmtDial(-7, QUARTER, 'e') === '-1.75', 'seven clicks down at 1/4 MOA is -1.75');
ok(S.fmtDial(3, MIL, 'e') === '+0.3',
   'three clicks of 0.1 mil prints +0.3 and not +0.30000000000000004');
ok(S.fmtDial(0, QUARTER, 'e') === '0.00', 'a zeroed turret gets no + sign');

section('display unit is a skin, the angle underneath is one number');
ok(S.sightUnitLabel(MIL) === 'MIL' && S.sightUnitLabel(QUARTER) === 'MOA', 'the label follows the unit');
ok(S.fmtMoaAsUnit(S.MOA_PER_MIL, MIL, 'e') === '+1.0',
   'one milliradian of come-up reads as +1.0 on a mil sight');
ok(S.fmtMoaAsUnit(S.MOA_PER_MIL, QUARTER, 'e') === '+3.44',
   'the same come-up reads as +3.44 on a MOA sight — same angle, two turrets');
ok(near(S.unitToMoa(S.moaToUnit(7.25, MIL), MIL), 7.25),
   'unit conversion round-trips');

section('carrying a zero onto a different sight');
const sess = (id, sight, elev, wind) => ({
  id, ts: 1000, rifleId: 'r1', rangeLocation: 'Ben Avery', rangeYards: 200, position: 'Prone',
  date: '2026-09-01', sight, shots: [{ ring: '10', elev, wind, isSighter: false }],
});
const slot = { rifleId: 'r1', location: 'Ben Avery', yards: 200, position: 'Prone' };
const carriedSame = S.findConfirmedZero([sess('a', QUARTER, 8, -4)], slot, 'x', QUARTER);
ok(carriedSame.elev === 8 && carriedSame.rounded === false,
   'onto the same sight, a zero carries across unchanged');
const carriedHalf = S.findConfirmedZero([sess('a', QUARTER, 8, -4)], slot, 'x', HALF);
ok(carriedHalf.elev === 4 && carriedHalf.wind === -2 && carriedHalf.rounded === false,
   'eight quarter-minute clicks become four half-minute clicks — the ANGLE crosses, not the count');
const carriedOdd = S.findConfirmedZero([sess('a', QUARTER, 7, 0)], slot, 'x', HALF);
ok(carriedOdd.elev === 4 && carriedOdd.rounded === true,
   '1.75 MOA onto a 1/2-MOA turret rounds to 4 clicks and SAYS it rounded');
const carriedMil = S.findConfirmedZero([sess('a', MIL, 10, 0)], slot, 'x', QUARTER);
ok(carriedMil.elev === 14 && near(carriedMil.elevMoa, S.MOA_PER_MIL),
   'one mil carried onto a 1/4-MOA sight is 14 clicks (3.4377 / 0.25 = 13.75)');
ok(S.findConfirmedZero([sess('a', QUARTER, 0, 0)], slot, 'x', QUARTER) === null,
   'a session with nothing dialled carries nothing forward');

section('drift is measured in minutes, because the cell can span an optic change');
const cell = (sight, e) => ({ noDope: false, elevMoa: S.clicksToMoa(e, sight, 'e'),
                              windMoa: 0 });
const walk = (sight, a, b, c) => [cell(sight, a), cell(sight, b), cell(sight, c)]; // newest first
ok(S.zeroDriftInfo(walk(EIGHTH, 6, 4, 3)) === null,
   'three clicks of walk on a 1/8-MOA sight is 0.375 MOA and is not drift');
ok(S.zeroDriftInfo(walk(HALF, 6, 4, 3)) !== null,
   'the same three clicks on a 1/2-MOA sight is 1.5 MOA and is');
ok(S.zeroDriftInfo(walk(QUARTER, 6, 5, 6)) === null, 'a zero that comes back is not drift');
ok(S.zeroDriftInfo(walk(QUARTER, 6, 5, 3)).flagged[0].moa > 0,
   'a zero walking up flags positive, so the message can name a direction');
ok(near(S.DRIFT_MIN_MOA, 0.75), 'the threshold is the 0.75 MOA it was calibrated at');

section('history is frozen, and that is the point');
const oldSession = { id: 'old', shots: [{ elev: 8, wind: 0 }] };          // no snapshot
const rifleNow = { id: 'r1', sight: HALF };                              // rifle changed since
ok(S.sightOf(oldSession).clickElev === 0.25,
   'a session logged before the feature reads at 1/4 MOA even though the rifle is now 1/2');
ok(near(S.clicksToMoa(oldSession.shots[0].elev, S.sightOf(oldSession), 'e'), 2.0),
   'so its +8 stays the 2.00 MOA it was displayed as when it was typed');
ok(near(S.clicksToMoa(oldSession.shots[0].elev, S.sightOf(rifleNow), 'e'), 4.0),
   'reading it through the rifle instead would double it — this is the bug the snapshot prevents');
const stamped = { id: 'new', sight: MIL, shots: [{ elev: 10, wind: 0 }] };
ok(near(S.clicksToMoa(10, S.sightOf(stamped), 'e'), S.MOA_PER_MIL),
   'a stamped session decodes through its own snapshot');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
