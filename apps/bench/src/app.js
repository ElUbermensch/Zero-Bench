/* ============================================================================
 * Bench
 *
 * Navigation rule: every creation form has exactly ONE entry point. Empty
 * states link to that page rather than duplicating the form, so there is never
 * a second route to the same destination.
 *
 * Starts empty. There is no demo data -- a Bench that arrives pre-populated
 * with someone else's loads is a Bench you have to clean out before you can
 * trust it.
 * ==========================================================================*/
'use strict';

/* --------------------------------------------------------------------------
 * Serials. Crockford base32 minus 'Z' = 31 symbols. 31 is prime, so weighted
 * sums live in the field Z/31 and the check character provably catches every
 * single-character substitution and every transposition, at any distance.
 * The prefix is part of the checksummed body, so it must itself be in the
 * alphabet -- 'L' and 'I' are not (Crockford folds them to 1 and 0).
 * ------------------------------------------------------------------------*/
const Serial = (() => {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXY';
  const V = Object.fromEntries([...A].map((c, i) => [c, i]));
  const MONTHS = 'ABCDEFGHJKMN';               // no I, no L

  const normalise = (s) => (s || '').toUpperCase()
    .replace(/[IL]/g, '1').replace(/O/g, '0').replace(/[^0-9A-Y]/g, '');

  function checkChar(body) {
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      if (!(body[i] in V)) return null;
      sum += (i + 2) * V[body[i]];
    }
    return A[((-sum % 31) + 31) % 31];
  }

  const isValid = (full) => {
    const s = normalise(full);
    return s.length >= 2 && checkChar(s.slice(0, -1)) === s.slice(-1);
  };

  const rand = (n) => Array.from({ length: n },
    () => A[Math.floor(Math.random() * 31)]).join('');

  function shortCode(prefix, taken) {
    if (!(prefix in V)) throw new Error(`prefix '${prefix}' is not in the alphabet`);
    for (let i = 0; i < 4000; i++) {
      const body = prefix + rand(2);
      const s = prefix + '-' + body.slice(1) + checkChar(body);
      if (!taken.has(s)) return s;
    }
    return null;
  }

  function batchSerial(date, taken) {
    const d = new Date(date + 'T12:00:00');
    const stem = 'B' + String(d.getFullYear() % 100).padStart(2, '0')
               + MONTHS[d.getMonth()] + String(d.getDate()).padStart(2, '0');
    for (let n = 1; n < 100; n++) {
      const seq = String(n).padStart(2, '0');
      const s = stem + '-' + seq + checkChar(stem + seq);
      if (!taken.has(s)) return s;
    }
    return null;
  }

  return { normalise, checkChar, isValid, shortCode, batchSerial };
})();

/* --------------------------------------------------------------------------
 * Storage. Feature-detected, with a memory fallback so a browser that blocks
 * localStorage degrades instead of crashing. Writes are verified by reading
 * back, because a quota failure in Safari private mode throws on set().
 * ------------------------------------------------------------------------*/
const Store = (() => {
  const KEY = 'reloading.Bench';
  let mem = null, persistent = false;
  try {
    localStorage.setItem(KEY + '.probe', '1');
    persistent = localStorage.getItem(KEY + '.probe') === '1';
    localStorage.removeItem(KEY + '.probe');
  } catch (e) { persistent = false; }

  return {
    get persistent() { return persistent; },
    load() {
      if (!persistent) return mem;
      try { const r = localStorage.getItem(KEY); return r ? JSON.parse(r) : null; }
      catch (e) { return mem; }
    },
    save(db) {
      mem = db;
      if (!persistent) return false;
      try { localStorage.setItem(KEY, JSON.stringify(db)); return true; }
      catch (e) { persistent = false; return false; }   // quota or eviction
    },
    wipe() {
      mem = null;
      if (persistent) { try { localStorage.removeItem(KEY); } catch (e) {} }
    },
  };
})();

/* One zero-core instance per configured backend, or null when Bench is
 * local-only. Everything below has to work with null: local-only is not a
 * degraded mode, it is how the app shipped and how most of it still runs. */
const CORE = (() => {
  try {
    if (!SHARED_SUPABASE?.url || !SHARED_SUPABASE?.anonKey) return null;
    return ZeroCore.create({ url: SHARED_SUPABASE.url, anonKey: SHARED_SUPABASE.anonKey,
                             appId: 'bench' });
  } catch (e) { return null; }
})();

/* --------------------------------------------------------------------------
 * Data model
 * ------------------------------------------------------------------------*/
const SCHEMA = 3;

/* A marking position is either a BAND around the case body, placed by `at`
 * (0 = head end, 1 = neck end), or the CASE HEAD itself — the flat base you
 * write on around the primer. The head is not a point along the body, so it
 * carries no `at` and the placement slider does not apply to it. Positions
 * without a `kind` are bands, which is what every scheme written before this
 * existed contains. */
const DEFAULT_SCHEME = {
  positions: [
    { id: 'neck', label: 'Neck band', hint: 'toward the bullet', at: 0.72, kind: 'band' },
    { id: 'head', label: 'Head band', hint: 'toward the primer', at: 0.26, kind: 'band' },
  ],
  palette: [
    { id: 'R', name: 'Red', hex: '#d92b2b', on: true },
    { id: 'K', name: 'Black', hex: '#15171a', on: true },
    { id: 'B', name: 'Blue', hex: '#1c6fd6', on: true },
    { id: 'G', name: 'Green', hex: '#2f9e44', on: true },
    { id: 'Y', name: 'Yellow', hex: '#e8b923', on: false },
    { id: 'W', name: 'White', hex: '#f1f3f5', on: false },
    { id: 'O', name: 'Orange', hex: '#e8590c', on: false },
    { id: 'P', name: 'Purple', hex: '#8a3ffc', on: false },
  ],
  allowBlank: true,
};

const COLLECTIONS = ['cartridges', 'firearms', 'componentLots',
                     'brassLots', 'recipes', 'batches', 'sessions'];

/* Where this copy of Bench actually lives, for the QR on every box label.
 *
 * This used to be `location.origin`, which was right when Bench sat at the root
 * of the site. It does not any more -- Zero is at `/` because it is the app
 * with existing users, and Bench moved to `/bench/`. An origin-only base URL
 * would print labels pointing at `https://host/#/s/B26H01-01F`, which opens
 * ZERO with a fragment it has never heard of. The label would look right, scan
 * fine, and land on the wrong app, and every box printed until someone noticed
 * would carry it.
 *
 * So the default is the directory this page was served from, which is correct
 * at the root, in a subdirectory, and on a local file:// copy. It is only a
 * DEFAULT -- Settings still lets you type the address of a deployment you want
 * labels to point at, which is what you want when you print at a desk and scan
 * on a phone. */
const defaultBaseUrl = () => {
  if (!location.origin || location.origin === 'null') return '';
  const dir = location.pathname.replace(/[^/]*$/, '');   // strip the filename
  return (location.origin + dir).replace(/\/$/, '');
};

const emptyDb = () => ({
  meta: {
    schema: SCHEMA,
    scheme: JSON.parse(JSON.stringify(DEFAULT_SCHEME)),
    baseUrl: defaultBaseUrl(),
    overheadPerRound: 0,
  },
  cartridges: [], firearms: [], componentLots: [],
  brassLots: [], recipes: [], batches: [], sessions: [],
});

/* Declared here, above loadDb() and migrate(), because both call them.
 *
 * They used to live further down the file. `const` is not hoisted the way a
 * function declaration is -- it sits in the temporal dead zone until its own
 * line runs -- and `let DB = loadDb()` runs at module evaluation, BEFORE those
 * lines. So the moment a stored database was old enough to need migrating,
 * loadDb -> migrate -> uid() threw `Cannot access 'uid' before initialization`
 * at the top level: render() never ran, no listener ever attached, and the app
 * was a blank page. Nothing was saved either, so it re-crashed on every reload
 * -- a permanent brick, and only for users who already had data.
 *
 * Every test passed, because a fresh install has nothing to migrate and the
 * migration test called loadDb() from the console after the script had already
 * finished evaluating. The one thing never exercised was the actual path: a
 * page LOAD with an old database already on disk. */
const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const today = () => new Date().toISOString().slice(0, 10);

/** Forgiving load: fills in anything a older/partial save is missing rather
 *  than discarding records because one key moved. */
function loadDb() {
  const raw = Store.load();
  if (!raw || typeof raw !== 'object') {
    const db = emptyDb();
    Store.save(db);                 // write immediately, so a reload reads this
    return db;
  }
  const db = Object.assign(emptyDb(), raw);
  const was = +(raw.meta || {}).schema || 1;
  db.meta = Object.assign(emptyDb().meta, raw.meta || {});
  db.meta.schema = SCHEMA;
  for (const c of COLLECTIONS) if (!Array.isArray(db[c])) db[c] = [];
  if (!db.meta.scheme || !Array.isArray(db.meta.scheme.positions)) {
    db.meta.scheme = JSON.parse(JSON.stringify(DEFAULT_SCHEME));
  }
  if (was < SCHEMA) migrate(db, was);
  return db;
}

/* Schema 2 -> 3.
 *
 * `remaining` was a stored counter on the batch. It is derived now, from the
 * sessions fired plus a list of rounds otherwise accounted for. A bench that
 * has been in use has counters that the sessions do not explain -- a session
 * logged before this version and then edited, a batch created with a partial
 * count -- and simply deriving would hand those rounds back and silently
 * un-age the brass they were fired through.
 *
 * So the difference is preserved as an opening adjustment. It is visible on
 * the batch, with a reason that says where it came from, and the user can undo
 * any line that was actually a mistake. The alternative -- trusting the
 * derivation and discarding the old counter -- would change numbers on a
 * screen the user has been reading for months, with nothing on screen to
 * explain why.
 *
 * `lastAnneal` was a single overwritten date. It becomes the first entry in a
 * list, with no `at` figure because none was ever recorded.
 */
function migrate(db, from) {
  if (from < 3) {
    for (const b of db.batches) {
      const fired = db.sessions.filter(s => s.batch === b.id)
        .reduce((s, x) => s + Math.max(0, +x.rounds || 0), 0);
      const stored = b.remaining;
      if (stored != null) {
        const unexplained = Math.max(0, (+b.qty || 0) - fired - Math.max(0, +stored));
        if (unexplained > 0) {
          (b.adjust = b.adjust || []).push({ id: uid('aj'), n: unexplained, reason: 'none',
            date: b.date || today(),
            note: 'Carried over from the stored round count when this batch was recorded.' });
        }
      }
      delete b.remaining;
      if (!Array.isArray(b.adjust)) b.adjust = [];
    }
    for (const l of db.brassLots) {
      if (!Array.isArray(l.anneals)) {
        l.anneals = l.lastAnneal ? [{ id: uid('an'), date: l.lastAnneal, note: '', at: 0 }] : [];
      }
      if (l.annealEvery == null) l.annealEvery = 1;
    }
  }
}

let DB = loadDb();
const save = () => Store.save(DB);
const scheme = () => DB.meta.scheme;

/* 41.2 + 0.3 is 41.499999999999996 in binary floating point, and a charge
 * weight printed to fifteen places on a box label is not a charge weight. */
const round3 = (n) => Math.round((+n || 0) * 1000) / 1000;
const byId = (arr, id) => arr.find(x => x.id === id) || null;
const takenSerials = () => new Set([
  ...DB.brassLots.map(x => x.serial),
  ...DB.batches.map(x => x.serial),
  ...DB.componentLots.map(x => x.serial).filter(Boolean),
]);

/* ------------------------------------------------------------- cartridges */
/** Cartridges are user-defined: created by free text, offered as a list
 *  afterwards. Matching is case- and space-insensitive so ".223 Rem" typed
 *  twice does not become two cartridges. */
const cartKey = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function findCartridge(name) {
  const k = cartKey(name);
  return DB.cartridges.find(c => cartKey(c.name) === k) || null;
}

function ensureCartridge(name, geom) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const found = findCartridge(clean);
  /* An existing cartridge keeps its shape. Re-typing a name that already
   * exists is how you REFER to it, not how you redefine it -- silently
   * restyling every brass lot in .303 British because someone picked the
   * default in a hurry is not a thing a text field should be able to do. */
  if (found) return found.id;
  const c = { id: uid('ct'), name: clean,
              shape: caseShape(geom), head: caseHead(geom) };
  DB.cartridges.push(c);
  return c.id;
}

const cartName = (id) => (byId(DB.cartridges, id) || {}).name || '—';

/* ------------------------------------------------------------------ derived */
const recipeOf = (b) => byId(DB.recipes, b.recipe);
const sessionsFor = (id) => DB.sessions.filter(s => s.batch === id);
const isUntested = (b) => sessionsFor(b.id).length === 0;

/* The charge that is actually in the cases.
 *
 * The recipe's `charge` is an intention; `chargeActual` is what came off the
 * scale. Four separate places already reached for "the measured one if there is
 * one" and computed it inline -- and the one place that did NOT was the over-max
 * safety check, which compared the recipe target to the published maximum and
 * never looked at the powder that went in. Load a 41.5 gr recipe against a 42.0
 * gr cited max, throw 43.0 into the cases, and the app reported "98.8% of max",
 * showed no warning chip, and printed a label with no over-max band on it. */
const chargeOf = (b) => {
  const r = recipeOf(b);
  return +b.chargeActual || (r ? +r.charge : 0) || 0;
};

/** Fraction of the published maximum this batch actually represents, or null
 *  when no maximum was cited. Over 1.0 is over max. */
const maxFraction = (b) => {
  const r = recipeOf(b);
  if (!r || !(r.sourceMax > 0)) return null;
  const c = chargeOf(b);
  return c > 0 ? c / r.sourceMax : null;
};

const isOverMax = (b) => {
  const f = maxFraction(b);
  return f != null && f > 1;
};

/** A recipe can be over its own cited maximum before any batch exists. That is
 *  a different claim from "this ammunition is over max" and gets its own name. */
const recipeOverMax = (r) => !!(r && r.sourceMax > 0 && r.charge > r.sourceMax);

const GRAINS_PER_LB = 7000;

/** Per-round cost from the lots actually consumed. Every divisor is guarded:
 *  a lot with zero quantity would otherwise produce Infinity and render as
 *  "$Infinity" rather than an obviously-missing value. */
function costPerRound(b) {
  const r = recipeOf(b);
  const at = (id) => byId(DB.componentLots, id);
  const bl = at(b.bulletLot), pw = at(b.powderLot), pr = at(b.primerLot);
  const br = byId(DB.brassLots, b.brassLot);
  const p = { bullet: 0, powder: 0, primer: 0, brass: 0,
              overhead: +DB.meta.overheadPerRound || 0, known: true };
  if (bl && bl.qty > 0) p.bullet = bl.cost / bl.qty; else if (bl) p.known = false;
  if (pr && pr.qty > 0) p.primer = pr.cost / pr.qty; else if (pr) p.known = false;
  if (pw && pw.qty > 0 && r) {
    p.powder = (pw.cost / (pw.qty * GRAINS_PER_LB)) * chargeOf(b);
  } else if (pw) p.known = false;
  if (br && br.initialQty > 0 && br.expectedFirings > 0) {
    p.brass = br.cost / (br.initialQty * br.expectedFirings);
  }
  p.total = p.bullet + p.powder + p.primer + p.brass + p.overhead;
  return p;
}

/* ==========================================================================
 * STOCK — what a batch actually takes off the shelf.
 *
 * Component lots were created with `remaining = qty` and nothing ever wrote
 * to `remaining` again. The inventory bar therefore read 100% forever, no
 * matter how much you loaded. This is that bug, fixed, and fixed by removing
 * the counter rather than by remembering to decrement it.
 *
 * Stock is DERIVED from the batches, never stored:
 *
 *     left = purchased − Σ (what every batch drew from this lot)
 *
 * A stored counter has to be decremented on create, incremented on delete,
 * and adjusted on edit; miss any one of those and it drifts, silently, with
 * no way to tell that it has. Deriving makes deleting a batch put its
 * components back for free, and makes the number on screen impossible to
 * disagree with the records it came from.
 *
 * Brass is different in kind and is modelled differently. Cases are not
 * consumed, they are COMMITTED: loaded into a batch, then returned to the
 * pool when that batch is fired. So brass tracks how many are sitting loaded
 * rather than how many are gone.
 * ========================================================================*/

/* ── What is left in the box ──────────────────────────────────────────────
 *
 * `remaining` used to be stored on the batch and decremented when a session
 * was logged. It had every fault a stored counter has: type 100 rounds fired
 * instead of 10 and it clamps to zero, permanently, with no session to edit
 * and no way to put it back short of deleting the batch -- which takes its
 * serial and all its other sessions with it. Worse, brassLife() read
 * `qty − remaining` as "rounds fired", so one typo also aged the brass lot by
 * a full extra cycle that could never be undone.
 *
 * So it is derived, exactly like component stock:
 *
 *     left = loaded − fired at recorded sessions − rounds otherwise accounted for
 *
 * Rounds leave a box for reasons other than being shot: pulled down for a
 * component, given to a mate, dropped in the grass. Those are recorded the way
 * culled cases are, as a dated line with a reason, so they reduce the count
 * without pretending anything was fired -- brass wear comes from `roundsFired`
 * alone, and a pulled round put no cycle on its case.
 */
const ROUND_REASONS = {
  pulled: 'Pulled down', given: 'Given away', lost: 'Lost',
  note: 'Other — see note', none: 'No reason given',
};

const roundsFired = (b) => sessionsFor(b.id)
  .reduce((s, x) => s + Math.max(0, +x.rounds || 0), 0);

const roundsAccounted = (b) => (b.adjust || [])
  .reduce((s, a) => s + Math.max(0, +a.n || 0), 0);

const roundsLeft = (b) =>
  Math.max(0, (+b.qty || 0) - roundsFired(b) - roundsAccounted(b));

/** What one batch draws, in natural units. Powder is in grains: the measured
 *  charge if it was weighed, otherwise the recipe's target. */
function batchDraw(b) {
  const r = recipeOf(b);
  const n = Math.max(0, +b.qty || 0);
  const charge = chargeOf(b);
  return { rounds: n, bullets: n, primers: n, powderGr: n * charge, cases: n };
}

/** Convert grains into whatever unit a powder lot was bought in. Powder sold
 *  by weight is the only place the unit actually varies. */
function powderInLotUnit(grains, lot) {
  return lot && lot.unit === 'lb' ? grains / GRAINS_PER_LB : grains;
}

/** Everything drawn from one component lot, in that lot's own unit.
 *  `exceptBatch` lets a form ask "what would be left if this batch changed?" */
function lotUsed(lot, exceptBatch) {
  let used = 0;
  for (const b of DB.batches) {
    if (exceptBatch && b.id === exceptBatch) continue;
    const d = batchDraw(b);
    if (lot.kind === 'bullet' && b.bulletLot === lot.id) used += d.bullets;
    if (lot.kind === 'primer' && b.primerLot === lot.id) used += d.primers;
    if (lot.kind === 'powder' && b.powderLot === lot.id) used += powderInLotUnit(d.powderGr, lot);
  }
  return used;
}

const lotLeft = (lot, exceptBatch) =>
  (+lot.qty || 0) - lotUsed(lot, exceptBatch);

/** Batches that drew on this lot, newest first — so "where did it go?" is one
 *  tap away rather than an inference. */
const batchesUsing = (lot) => DB.batches.filter(b =>
  (lot.kind === 'bullet' && b.bulletLot === lot.id) ||
  (lot.kind === 'powder' && b.powderLot === lot.id) ||
  (lot.kind === 'primer' && b.primerLot === lot.id))
  .slice().sort((a, b) => (a.date < b.date ? 1 : -1));

/* Cases leave a lot: a neck splits, a head separates, one rolls under the
 * bench. They are gone from the count and that is ALL they are -- removing a
 * case does not change how many times the surviving cases have been fired.
 *
 * Which is why the firing average is computed against the population that was
 * in circulation AT THE TIME of each firing, not against today's count. Using
 * today's count would let a cull retroactively rewrite history: lose ten cases
 * and every past firing would silently become a slightly larger fraction of a
 * smaller lot, and the lot would appear to age without anything being fired. */
const casesLost = (l) => (l.culls || []).reduce((s, c) => s + (+c.n || 0), 0);
const brassOnHand = (l) => Math.max(0, (+l.initialQty || 0) - casesLost(l));

/** How many cases were in the lot on a given date. */
function lotPopulationAt(l, date) {
  const gone = (l.culls || [])
    .filter(c => !date || String(c.date || '') <= String(date))
    .reduce((s, c) => s + (+c.n || 0), 0);
  return Math.max(0, (+l.initialQty || 0) - gone);
}

const CULL_REASONS = {
  sep: 'Case separation', lost: 'Lost', note: 'Other — see note', none: 'No reason given',
};

/* ── Brass life, counted as partial firings ───────────────────────────────
 *
 * Cases from one lot get fired, tumbled back together and reloaded as a pool.
 * Once they are mixed there is no way to know which individual case has been
 * fired how many times, so the only honest unit is the MEAN firings per case:
 *
 *     mean = firings before the lot was recorded  +  Σ (rounds fired / lot size)
 *
 * Fire 50 of 100 and the lot is at 0.5 firings, not 1 and not 0. Fire the
 * other 50 and it reaches 1.0.
 *
 * But the mean is not the whole story, and for brass the tail is the part that
 * matters -- a case head separation is a safety event, not a tidiness one. If
 * each cycle draws n of N at random, a given case's count is a sum of
 * Bernoulli(n/N) trials, so:
 *
 *     variance = Σ (n/N)(1 − n/N)
 *
 * which is exactly zero when every batch used the whole lot (n = N) and grows
 * only when partial draws actually mixed things up. `hi` is the ~97.5th
 * percentile: the most-fired case in the lot is probably around there. The UI
 * warns off `hi` and reports `mean`, because retiring on the average means
 * throwing the worst cases one cycle past where they should have gone.
 */
function brassLife(lot) {
  const N = brassOnHand(lot);
  const base = +lot.firings || 0;
  let cycles = 0, varr = 0, fired = 0;
  for (const b of DB.batches) {
    if (b.brassLot !== lot.id) continue;
    // A loaded but unfired batch has put no wear on anything -- and neither
    // has a round that was pulled down rather than shot, which is why this
    // counts rounds FIRED rather than rounds gone.
    const n = roundsFired(b);
    if (!n) continue;
    // The lot as it stood when these were fired, so a later cull cannot
    // rewrite the past.
    const pop = lotPopulationAt(lot, b.date);
    if (pop <= 0) continue;
    fired += n;
    const p = Math.min(1, n / pop);
    cycles += p;
    varr += p * (1 - p);
  }
  const sd = Math.sqrt(varr);
  return { base, N, fired, cycles, sd,
           mean: base + cycles,
           hi: base + cycles + 1.96 * sd };
}

/** Cases sitting in loaded, unfired rounds. They are not gone — firing a
 *  batch returns them to the pool as once-more-fired brass. */
const brassCommitted = (lot, exceptBatch) => DB.batches
  .filter(b => b.brassLot === lot.id && b.id !== exceptBatch)
  .reduce((s, b) => s + roundsLeft(b), 0);

const brassAvailable = (lot, exceptBatch) =>
  brassOnHand(lot) - brassCommitted(lot, exceptBatch);

/** How many more rounds of a given charge the powder on hand will make.
 *  The number a reloader actually wants: "have I enough for Saturday?" */
function roundsLeftFromPowder(lot, chargeGr) {
  const c = +chargeGr;
  if (!lot || !(c > 0)) return null;
  const grLeft = lot.unit === 'lb' ? lotLeft(lot) * GRAINS_PER_LB : lotLeft(lot);
  return Math.max(0, Math.floor(grLeft / c));
}

/** The most rounds the currently-selected lots can actually make. Drives both
 *  the live preview on the batch form and the refusal below. */
function maxRoundsFor(d, exceptBatch) {
  const at = (id) => byId(DB.componentLots, id);
  const r = byId(DB.recipes, d.recipe);
  const charge = +d.chargeActual || (r ? +r.charge : 0) || 0;
  const caps = [];
  const bl = at(d.bulletLot), pr = at(d.primerLot), pw = at(d.powderLot);
  const br = byId(DB.brassLots, d.brassLot);
  if (bl) caps.push({ what: `${bl.name} bullets`, n: Math.floor(lotLeft(bl, exceptBatch)) });
  if (pr) caps.push({ what: `${pr.name} primers`, n: Math.floor(lotLeft(pr, exceptBatch)) });
  if (pw && charge > 0) caps.push({ what: `${pw.name} powder`,
    n: roundsLeftFromPowder(pw, charge) ?? Infinity });
  if (br) caps.push({ what: `${br.serial} cases`, n: Math.floor(brassAvailable(br, exceptBatch)) });
  if (!caps.length) return null;
  const worst = caps.reduce((a, c) => (c.n < a.n ? c : a));
  return { max: Math.max(0, worst.n), limiter: worst.what, caps, charge };
}

/** A consumption line, ready to render, for the live preview. */
function drawPreview(d, exceptBatch) {
  const at = (id) => byId(DB.componentLots, id);
  const r = byId(DB.recipes, d.recipe);
  const n = Math.max(0, +d.qty || 0);
  const charge = +d.chargeActual || (r ? +r.charge : 0) || 0;
  const rows = [];
  const line = (lot, need, unit) => {
    if (!lot) return;
    const left = lotLeft(lot, exceptBatch);
    rows.push({ name: lot.name, need, unit, left, after: left - need, short: need > left + 1e-9 });
  };
  line(at(d.bulletLot), n, 'ea');
  line(at(d.primerLot), n, 'ea');
  const pw = at(d.powderLot);
  if (pw) {
    const grains = n * charge;
    const need = powderInLotUnit(grains, pw);
    const left = lotLeft(pw, exceptBatch);
    rows.push({ name: pw.name, need, unit: pw.unit === 'lb' ? 'lb' : 'gr', left,
                after: left - need, short: need > left + 1e-9, grains });
  }
  const br = byId(DB.brassLots, d.brassLot);
  if (br) {
    const avail = brassAvailable(br, exceptBatch);
    rows.push({ name: `${br.serial} cases`, need: n, unit: 'ea', left: avail,
                after: avail - n, short: n > avail, brass: true });
  }
  return { rows, charge, n };
}

/* ==========================================================================
 * Does the ammunition match the recipe it claims to be?
 *
 * The batch form offers every lot of the right KIND -- every powder you own,
 * every brass lot of any cartridge -- while the recipe names its components as
 * free text. Nothing connected the two, so a "6.5 CM / H4350 / 41.5 gr" batch
 * could be built out of a Varget lot and .223 brass and save without complaint.
 * Powder substitution at an unadjusted charge is the classic way to take the
 * roof off a rifle; H4350 and Varget differ by roughly ten grains at the same
 * pressure in this case.
 *
 * The comparison is free text against free text, so it cannot be exact. It is
 * tokenised instead: case folded, "140gr" split into "140 gr", punctuation
 * dropped, and the words that appear in every product name discarded. Two names
 * match when one's tokens are a subset of the other's, or when they overlap by
 * at least half the shorter name. "Hodgdon H4350" matches "H4350"; it does not
 * match "Varget".
 *
 * Because the match is fuzzy, only the CARTRIDGE -- an id comparison, with no
 * fuzziness in it at all -- is a hard refusal. A component-name mismatch is a
 * loud, persistent warning on the batch and on its label rather than a block,
 * because refusing on a string comparison would eventually refuse something
 * legitimate and the answer to that is never "type it again".
 * ========================================================================*/
const NOISE = new Set(['gr', 'grain', 'grains', 'gn', 'the', 'and',
  'bullet', 'bullets', 'powder', 'primer', 'primers', 'brass', 'case', 'cases',
  'match', 'target', 'competition', 'premium', 'new', 'lot']);

/* The maker is the least informative word in a component name. "Hodgdon H4350"
 * and "Hodgdon Varget" share a token and are ten grains apart at the same
 * pressure; treating that shared word as agreement is exactly the mistake the
 * check exists to catch. Makers are stripped before comparison, and only what
 * is left -- the thing that actually names the product -- is compared. */
const MAKERS = new Set([
  'hodgdon', 'imr', 'alliant', 'reloder', 'vihtavuori', 'vv', 'accurate',
  'ramshot', 'norma', 'winchester', 'win', 'shooters', 'world', 'sw',
  'berger', 'sierra', 'hornady', 'nosler', 'barnes', 'lapua', 'cutting', 'edge',
  'cci', 'federal', 'fed', 'remington', 'rem', 'rws', 'ppu', 'wolf', 'tula',
  'starline', 'peterson', 'adg', 'alpha', 'nammo', 'lehigh', 'speer',
]);

function nameTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(\d)\s*(gr|grain|grains|gn)\b/g, '$1 ')   // 140gr -> 140
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(t => t && !NOISE.has(t));
}

/** The tokens that actually identify the product. Falls back to the full set
 *  when a name is nothing but a maker, so "Lapua" against "Lapua" still
 *  agrees rather than comparing two empty sets. */
function coreTokens(s) {
  const all = nameTokens(s);
  const core = all.filter(t => !MAKERS.has(t));
  return new Set(core.length ? core : all);
}

/** true / false / null, where null means one of the names was blank -- an
 *  unnamed component is an absence, not a mismatch, and saying "mismatch"
 *  about it would be a lie. */
function namesAgree(a, b) {
  const A = coreTokens(a), B = coreTokens(b);
  if (!A.size || !B.size) return null;
  const shared = [...A].filter(t => B.has(t)).length;
  // Strictly more than half, so a 140 gr Hybrid and a 140 gr VLD -- same
  // weight, different bullet, different seating -- do not pass on the weight
  // alone.
  if (shared / Math.min(A.size, B.size) > 0.5) return true;
  // Catalogue numbers run together differently in different catalogues:
  // "GM210M" against "210M". Containment catches those without loosening the
  // token rule for everything else.
  const [x, y] = [[...A].sort().join(''), [...B].sort().join('')];
  return x.includes(y) || y.includes(x);
}

/** Every way this batch contradicts its own recipe. Each entry is
 *  {what, wanted, got, severity} — 'stop' for pressure-relevant, 'warn' else. */
function batchMismatches(b) {
  const r = recipeOf(b);
  if (!r) return [];
  const out = [];
  const pairs = [
    ['powderLot', 'Powder', r.powder, 'stop'],
    ['bulletLot', 'Bullet', r.bullet, 'stop'],
    ['primerLot', 'Primer', r.primer, 'warn'],
  ];
  for (const [key, what, wanted, severity] of pairs) {
    const lot = byId(DB.componentLots, b[key]);
    if (!lot) continue;
    if (namesAgree(wanted, lot.name) === false) {
      out.push({ what, wanted, got: lot.name, severity });
    }
  }
  const brass = byId(DB.brassLots, b.brassLot);
  if (brass && r.cartridge && brass.cartridge && brass.cartridge !== r.cartridge) {
    out.push({ what: 'Cartridge', wanted: cartName(r.cartridge),
               got: cartName(brass.cartridge), severity: 'stop' });
  }
  return out;
}

/* ── Annealing ────────────────────────────────────────────────────────────
 *
 * The old check was `if (!lastAnneal && mean >= 3)`: warn once, and never
 * again for the rest of the lot's life. Log a single anneal at three firings
 * and the lot could reach ten with a years-old date on it and nothing said.
 * Brass work-hardens continuously, so the question is never "has this ever
 * been annealed" but "how many firings since the last time", against the
 * interval the shooter actually works to -- every firing for most people,
 * every two or three for some. `annealEvery: 0` turns it off.
 */
function annealState(l) {
  const every = l.annealEvery == null ? 1 : +l.annealEvery;
  const life = brassLife(l);
  const list = l.anneals || [];
  const last = list.length ? list[list.length - 1] : null;
  // `at` is the lot's mean firings when the anneal was done. Old records have
  // a date and no figure, so fall back to zero -- which errs toward nagging.
  const since = last ? Math.max(0, life.mean - (+last.at || 0)) : life.mean;
  return { every, since, last, ever: list.length > 0,
           due: every > 0 && since >= every };
}

function brassChips(l) {
  const out = [];
  const life = brassLife(l);
  if (l.retired) out.push(['bad', 'Retired']);
  else if (life.mean >= l.expectedFirings) out.push(['bad', 'At life limit']);
  else if (life.hi >= l.expectedFirings) out.push(['warn', 'Some cases at limit']);
  else if (life.mean >= l.expectedFirings - 1) out.push(['warn', 'Near limit']);
  const an = annealState(l);
  if (an.due) out.push(['warn', an.ever ? `Anneal due (${an.since.toFixed(1)} since)` : 'Never annealed']);
  return out;
}

function batchChips(b) {
  const out = [];
  if (b.quarantine) out.push(['bad', 'Quarantined']);
  if (isOverMax(b)) out.push(['bad', 'Over published max']);
  const mm = batchMismatches(b);
  if (mm.some(m => m.severity === 'stop')) out.push(['bad', 'Wrong component']);
  else if (mm.length) out.push(['warn', 'Component mismatch']);
  if (isUntested(b)) out.push(['warn', 'Untested']);
  if (!out.length) out.push(['ok', 'Proven']);
  return out;
}

/* ------------------------------------------------------------------ format */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => '$' + (Number.isFinite(n) ? n : 0).toFixed(3);
const money2 = (n) => '$' + (Number.isFinite(n) ? n : 0).toFixed(2);
const chips = (list) => list.map(([k, t]) => `<span class="chip ${k}">${esc(t)}</span>`).join(' ');
const fmtDate = (s) => s
  ? new Date(s + 'T12:00:00').toLocaleDateString(undefined,
      { year: 'numeric', month: 'short', day: 'numeric' })
  : '—';
const num = (v, d) => (v === '' || v == null || isNaN(+v) ? (d == null ? null : d) : +v);

/* --------------------------------------------------------------- case SVG */
/* The silhouette is drawn from the cartridge, not from one hardcoded shape.
 *
 * It used to be a single path with a flange standing proud of the body at the
 * head -- which is a RIMMED case. Almost nothing a precision shooter loads is
 * rimmed: 6.5 Creedmoor, .308, .223 and every other bottleneck rifle round is
 * rimless, and its head is the same diameter as its body with an extractor
 * groove cut in ahead of it. So the drawing on the Identify screen, on every
 * brass row and on every printed label showed a case shape that none of the
 * user's brass actually has. It still read as "a case", which is why it went
 * unnoticed, but the one place the picture has to be right is the one where
 * you are holding the real thing against it.
 *
 * Two properties, because they are genuinely independent: a case can be
 * bottleneck or straight-walled, and separately rimless, rimmed or belted.
 * .303 British is bottleneck AND rimmed; 9mm is straight and rimless; 7mm Rem
 * Mag is bottleneck and belted. Collapsing them into one "necked or rimmed"
 * choice would make three of the six combinations unrepresentable.
 *
 * Vertical reference, in viewBox units: the body spans y 17..71, the neck
 * 28..60, the extractor groove cuts in to 24..64, a rim flange stands out to
 * 11..77 and a belt to 14..74. */
const CASE_SHAPES = { bottleneck: 'Bottleneck', straight: 'Straight-walled' };
const CASE_HEADS = { rimless: 'Rimless (extractor groove)', rimmed: 'Rimmed', belted: 'Belted' };
const NECK_X = 42;

const caseShape = (c) => (c && CASE_SHAPES[c.shape] ? c.shape : 'bottleneck');
const caseHead = (c) => (c && CASE_HEADS[c.head] ? c.head : 'rimless');

/* Everything the renderer needs for one cartridge: the outline, where the
 * markable body ends, and where the head block is so marks on the case head
 * land on it rather than beside it. */
function caseGeom(cart) {
  const shape = caseShape(cart), head = caseHead(cart);
  const R = 262;                                   // right edge of the drawing
  const T = 17, B = 71;                            // body
  const GT = 24, GB = 64;                          // extractor groove
  const FT = 11, FB = 77;                          // rim flange
  const LT = 14, LB = 74;                          // belt

  let topHead, botHead, bodyEnd, baseX0, baseY0, baseY1, sepAt = null;
  if (head === 'rimmed') {
    bodyEnd = 242; baseX0 = 242; baseY0 = FT; baseY1 = FB; sepAt = 242;
    topHead = `L242,${T} L242,${FT} L${R},${FT}`;
    botHead = `L${R},${FB} L242,${FB} L242,${B}`;
  } else if (head === 'belted') {
    bodyEnd = 208; baseX0 = 238; baseY0 = T; baseY1 = B;
    topHead = `L208,${T} L208,${LT} L224,${LT} L224,${GT} L238,${GT} L238,${T} L${R},${T}`;
    botHead = `L${R},${B} L238,${B} L238,${GB} L224,${GB} L224,${LB} L208,${LB} L208,${B}`;
  } else {
    bodyEnd = 226; baseX0 = 240; baseY0 = T; baseY1 = B;
    topHead = `L226,${T} L226,${GT} L240,${GT} L240,${T} L${R},${T}`;
    botHead = `L${R},${B} L240,${B} L240,${GB} L226,${GB} L226,${B}`;
  }

  const topBody = shape === 'straight' ? `M40,${T}` : `M40,28 L78,28 L100,${T}`;
  const botBody = shape === 'straight' ? `L40,${B} Z` : `L100,${B} L78,60 L40,60 Z`;

  return {
    shape, head, baseX0, baseX1: R, baseY0, baseY1, sepAt,
    /* Marks stop short of whatever the head does: a band painted over an
     * extractor groove or a belt is a band that is not there in life. */
    bandX1: bodyEnd - 4,
    path: `${topBody} ${topHead} ${botHead} ${botBody}`,
  };
}

let svgSeq = 0;

function caseSvg(marks, opts) {
  const o = opts || {}, sc = scheme();
  const uidc = 'cc' + (++svgSeq);
  const heads = sc.positions.filter(isHeadPos);
  const bandPos = sc.positions.filter(p => !isHeadPos(p));
  /* `cart` may be a record or an id, and may be absent -- the Identify screen
   * draws a case before you have said which cartridge you are holding. A
   * rimless bottleneck is the right default: it is what almost everything a
   * precision shooter loads actually is. */
  const cart = typeof o.cart === 'string' ? byId(DB.cartridges, o.cart) : o.cart;
  const g = caseGeom(cart);

  const bandX = (p) => g.bandX1 - (p.at ?? 0.5) * (g.bandX1 - NECK_X);

  const bands = bandPos.map(p => {
    const col = marks && marks[p.id] ? sc.palette.find(c => c.id === marks[p.id]) : null;
    const x = bandX(p);
    const w = o.mini ? 15 : 17;
    return col
      ? `<rect x="${x - w / 2}" y="10" width="${w}" height="70" fill="${col.hex}"/>`
      : `<rect x="${x - w / 2}" y="10" width="${w}" height="70" fill="none" `
        + `stroke="#7a828f" stroke-width="1.4" stroke-dasharray="3 3"/>`;
  }).join('');

  /* The case head is the flat base, drawn as the block at the right of the
   * side view -- the rim on a rimmed case, the head itself on a rimless one.
   * Several head positions split it into stripes rather than overprinting each
   * other: a mark you cannot see is a mark you will not check. */
  const hw = g.baseX1 - g.baseX0, span = (g.baseY1 - g.baseY0) - 4;
  const rim = heads.map((p, i) => {
    const col = marks && marks[p.id] ? sc.palette.find(c => c.id === marks[p.id]) : null;
    const y0 = g.baseY0 + 2 + i * (span / heads.length), h = span / heads.length;
    return col
      ? `<rect x="${g.baseX0}" y="${y0}" width="${hw}" height="${h}" fill="${col.hex}"/>`
      : `<rect x="${g.baseX0 + 0.7}" y="${y0 + 0.7}" width="${hw - 1.4}" height="${h - 1.4}" fill="none" `
        + `stroke="#7a828f" stroke-width="1.4" stroke-dasharray="3 3"/>`;
  }).join('');

  const ticks = o.mini ? '' : bandPos.map(p => {
    const x = bandX(p);
    return `<line x1="${x}" y1="78" x2="${x}" y2="88" stroke="#6c7480" stroke-width="1"/>`
      + `<text x="${x}" y="99" fill="#9aa3b0" font-size="11" text-anchor="middle">${esc(p.label)}</text>`;
  }).join('') + (heads.length && !o.mini
    // Under the head, not beside it: a label centred to the right of the case
    // runs off the edge of the viewBox and gets clipped.
    ? `<line x1="${(g.baseX0 + g.baseX1) / 2}" y1="78" x2="${(g.baseX0 + g.baseX1) / 2}" y2="88" stroke="#6c7480" stroke-width="1"/>`
      + `<text x="${(g.baseX0 + g.baseX1) / 2}" y="99" fill="#9aa3b0" font-size="11" text-anchor="middle">${
          esc(heads.length === 1 ? heads[0].label : 'Case head')}</text>`
    : '');
  return `<svg class="case${o.mini ? ' casemini' : ''}" viewBox="0 0 300 ${o.mini ? 88 : 106}"
      xmlns="http://www.w3.org/2000/svg" role="img" aria-label="case marking"
      data-shape="${g.shape}" data-head="${g.head}">
    <defs><clipPath id="${uidc}"><path d="${g.path}"/></clipPath></defs>
    <path d="${g.path}" fill="#b9a06a" stroke="#8d7844" stroke-width="1.5"/>
    <g clip-path="url(#${uidc})">${bands}</g>
    <g clip-path="url(#${uidc})">${rim}</g>
    <path d="${g.path}" fill="none" stroke="#8d7844" stroke-width="1.5"/>
    ${/* On a rimmed case the flange needs a line where it meets the body, or
         the head marks read as part of the body. A rimless or belted case has
         a groove doing that job in the outline already. */
      g.sepAt ? `<path d="M${g.sepAt},17 L${g.sepAt},71" stroke="#8d7844" stroke-width="1"/>` : ''}
    ${ticks}</svg>`;
}

/* Written this way rather than `p.kind === 'head'` so a scheme saved before
 * kinds existed reads as all-bands, which is what it is. */
const isHeadPos = (p) => p && p.kind === 'head';

const codeOf = (marks) =>
  scheme().positions.map(p => (marks && marks[p.id]) || '—').join('/');
const marksEqual = (a, b) =>
  scheme().positions.every(p => ((a && a[p.id]) || null) === ((b && b[p.id]) || null));
const schemeCapacity = () => {
  const n = scheme().palette.filter(c => c.on).length, p = scheme().positions.length;
  if (!n || !p) return 0;
  return scheme().allowBlank ? Math.pow(n + 1, p) - 1 : Math.pow(n, p);
};

/* ==========================================================================
 * Declarative forms. One renderer and one submit path for every entity, so a
 * new field is a line of data rather than another copy of the same markup.
 * ========================================================================*/
const PENDING = '\u0000new:';
const lotsOf = (kind) => DB.componentLots.filter(c => c.kind === kind);

const FORMS = {
  cartridgeQuick: { title: 'Cartridge', fields: [
    { k: 'name', l: 'Cartridge name', t: 'text', req: true, ph: 'e.g. 6.5 Creedmoor' },
  ]},

  firearm: { title: 'Firearm', fields: [
    { k: 'name', l: 'Name', t: 'text', req: true, ph: 'Bolt gun, 24in' },
    { k: 'cartridge', l: 'Cartridge', t: 'cartridge', req: true },
    { k: 'barrel', l: 'Barrel length (in)', t: 'num', step: '0.1' },
    { k: 'twist', l: 'Twist', t: 'text', ph: '1:8' },
    { k: 'sightHeight', l: 'Sight height (in)', t: 'num', step: '0.01' },
    { k: 'zeroRange', l: 'Zero range (yd)', t: 'num' },
    { k: 'notes', l: 'Notes', t: 'area' },
  ]},

  component: { title: 'Component lot', fields: [
    { k: 'kind', l: 'Type', t: 'select', req: true,
      opts: [['bullet', 'Bullet'], ['powder', 'Powder'], ['primer', 'Primer']] },
    { k: 'name', l: 'Product', t: 'text', req: true, ph: 'Berger 140gr Hybrid' },
    { k: 'lot', l: 'Lot code', t: 'text' },
    { k: 'weightGr', l: 'Bullet weight (gr)', t: 'num', step: '0.1', only: 'bullet' },
    { k: 'bcG1', l: 'BC (G1)', t: 'num', step: '0.001', only: 'bullet' },
    { k: 'bcG7', l: 'BC (G7)', t: 'num', step: '0.001', only: 'bullet' },
    { k: 'qty', l: 'Quantity purchased', t: 'num', req: true, step: '0.001' },
    { k: 'unit', l: 'Unit', t: 'select', opts: [['ea', 'each'], ['lb', 'pounds']] },
    { k: 'cost', l: 'Total cost ($)', t: 'num', step: '0.01' },
    { k: 'vendor', l: 'Vendor', t: 'text' },
  ]},

  recipe: { title: 'Recipe', fields: [
    { k: 'name', l: 'Name', t: 'text', req: true, ph: '6.5CM / 140 Hybrid / H4350' },
    { k: 'cartridge', l: 'Cartridge', t: 'cartridge', req: true },
    { k: 'bullet', l: 'Bullet', t: 'text', req: true, list: () => lotsOf('bullet').map(l => l.name) },
    { k: 'powder', l: 'Powder', t: 'text', req: true, list: () => lotsOf('powder').map(l => l.name) },
    { k: 'primer', l: 'Primer', t: 'text', req: true, list: () => lotsOf('primer').map(l => l.name) },
    { k: 'charge', l: 'Charge (gr)', t: 'num', req: true, step: '0.01' },
    { k: 'coal', l: 'COAL (in)', t: 'num', step: '0.001' },
    { k: 'cbto', l: 'CBTO (in)', t: 'num', step: '0.001' },
    { k: 'source', l: 'Load data source', t: 'text', req: true,
      ph: 'Hodgdon online / Hornady 11th', hint: 'Required. Cite where the load came from.' },
    { k: 'page', l: 'Edition / page', t: 'text' },
    { k: 'sourceMax', l: 'Published max charge (gr)', t: 'num', step: '0.01',
      hint: 'Used to flag over-max loads. Leave blank if not published.' },
    { k: 'notes', l: 'Notes', t: 'area' },
  ]},

  brass: { title: 'Brass lot', fields: [
    { k: 'marks', l: 'Colour code', t: 'marks' },
    { k: 'cartridge', l: 'Cartridge', t: 'cartridge', req: true },
    { k: 'headstamp', l: 'Headstamp', t: 'text', req: true, ph: 'LC 21' },
    { k: 'maker', l: 'Maker', t: 'text' },
    { k: 'initialQty', l: 'Cases', t: 'num', req: true, def: 100 },
    { k: 'firings', l: 'Firings before now', t: 'num', def: 0,
      hint: 'Only what happened before this lot was recorded. Batches loaded here count themselves.' },
    { k: 'expectedFirings', l: 'Expected firings', t: 'num', def: 6 },
    { k: 'annealEvery', l: 'Anneal every (firings)', t: 'num', def: 1, step: '1',
      hint: 'The app nags when the lot is this far past its last anneal. 0 turns it off.' },
    { k: 'trimTo', l: 'Trim-to length (in)', t: 'num', step: '0.001' },
    { k: 'maxLength', l: 'Max case length (in)', t: 'num', step: '0.001',
      hint: 'A case at or over this is a crimped neck waiting to happen.' },
    { k: 'weightSort', l: 'Weight sort band (gr)', t: 'text', ph: '±0.5' },
    { k: 'cost', l: 'Lot cost ($)', t: 'num', step: '0.01', def: 0 },
    { k: 'origin', l: 'Origin', t: 'select',
      opts: [['new', 'New'], ['once-fired', 'Once-fired'], ['range pickup', 'Range pickup']] },
    { k: 'notes', l: 'Notes', t: 'area' },
  ]},

  cull: { title: 'Cases removed', fields: [
    { k: 'n', l: 'Cases removed', t: 'num', req: true, def: 1 },
    { k: 'reason', l: 'Reason', t: 'select', opts: [
      ['sep', 'Case separation'], ['lost', 'Lost'],
      ['note', 'Other — see note'], ['none', 'No reason given']] },
    { k: 'date', l: 'Date', t: 'date' },
    { k: 'note', l: 'Note', t: 'area' },
  ]},

  /* The same shape as a cull, one level up: rounds that left the box without
   * being fired. Kept separate from a session because a pulled round put no
   * cycle on its case, and brass wear counts firings. */
  adjust: { title: 'Rounds accounted for', fields: [
    { k: 'n', l: 'Rounds', t: 'num', req: true, def: 1 },
    { k: 'reason', l: 'Where they went', t: 'select', opts: [
      ['pulled', 'Pulled down'], ['given', 'Given away'], ['lost', 'Lost'],
      ['note', 'Other — see note'], ['none', 'No reason given']] },
    { k: 'date', l: 'Date', t: 'date' },
    { k: 'note', l: 'Note', t: 'area' },
  ]},

  /* A ladder is N batches on one recipe. Building them one at a time meant N
   * trips through the batch form -- or, before batches could carry their own
   * charge, N fully-cited recipes. */
  ladder: { title: 'Ladder', fields: [
    { k: 'brassLot', l: 'Brass lot', t: 'ref', req: true,
      ref: () => DB.brassLots.filter(l => !l.retired),
      label: l => `${l.serial} — ${l.headstamp} (${brassLife(l).mean.toFixed(1)}f, ${brassAvailable(l)} free)` },
    { k: 'bulletLot', l: 'Bullet lot', t: 'ref', req: true, ref: () => lotsOf('bullet'),
      label: l => l.name + (l.lot ? ` — ${l.lot}` : '') },
    { k: 'powderLot', l: 'Powder lot', t: 'ref', req: true, ref: () => lotsOf('powder'),
      label: l => l.name + (l.lot ? ` — ${l.lot}` : '') },
    { k: 'primerLot', l: 'Primer lot', t: 'ref', req: true, ref: () => lotsOf('primer'),
      label: l => l.name + (l.lot ? ` — ${l.lot}` : '') },
    { k: 'date', l: 'Date loaded', t: 'date' },
    { k: 'axis', l: 'Vary', t: 'select', opts: [
      ['charge', 'Charge weight'], ['cbto', 'Seating depth (CBTO)']] },
    { k: 'start', l: 'Start at', t: 'num', req: true, step: '0.001',
      hint: 'Grains for a charge ladder, inches for a seating test.' },
    { k: 'step', l: 'Step', t: 'num', req: true, step: '0.001', def: 0.3 },
    { k: 'steps', l: 'Rungs', t: 'num', req: true, def: 8 },
    { k: 'perStep', l: 'Rounds per rung', t: 'num', req: true, def: 3 },
    { k: 'storage', l: 'Storage', t: 'text' },
  ]},

  anneal: { title: 'Anneal', fields: [
    { k: 'date', l: 'Date annealed', t: 'date' },
    { k: 'note', l: 'Note', t: 'text', ph: 'AMP setting 118 / 6 sec' },
  ]},

  batch: { title: 'Batch', fields: [
    { k: 'recipe', l: 'Recipe', t: 'ref', ref: () => DB.recipes, label: r => r.name,
      req: true, hard: true },
    // Recording WHICH lot went into a batch is the point of the app, so these
    // are required whenever there is a lot to pick. Defaulting them to "none"
    // silently produced zero-cost, untraceable batches.
    { k: 'brassLot', l: 'Brass lot', t: 'ref', req: true,
      ref: () => DB.brassLots.filter(l => !l.retired),
      label: l => `${l.serial} — ${l.headstamp} (${brassLife(l).mean.toFixed(1)}f, ${brassAvailable(l)} free)` },
    { k: 'bulletLot', l: 'Bullet lot', t: 'ref', req: true, ref: () => lotsOf('bullet'),
      label: l => l.name + (l.lot ? ` — ${l.lot}` : '') },
    { k: 'powderLot', l: 'Powder lot', t: 'ref', req: true, ref: () => lotsOf('powder'),
      label: l => l.name + (l.lot ? ` — ${l.lot}` : '') },
    { k: 'primerLot', l: 'Primer lot', t: 'ref', req: true, ref: () => lotsOf('primer'),
      label: l => l.name + (l.lot ? ` — ${l.lot}` : '') },
    { k: 'date', l: 'Date loaded', t: 'date' },
    { k: 'qty', l: 'Rounds loaded', t: 'num', req: true, def: 50 },
    { k: 'chargeActual', l: 'Measured charge (gr)', t: 'num', step: '0.01' },
    { k: 'chargeSd', l: 'Charge SD (gr)', t: 'num', step: '0.01' },
    { k: 'coalMean', l: 'Measured COAL (in)', t: 'num', step: '0.001' },
    { k: 'cbtoMean', l: 'Measured CBTO (in)', t: 'num', step: '0.001',
      hint: 'Base to ogive — the number that actually repeats between bullet lots.' },
    { k: 'runout', l: 'Runout TIR (in)', t: 'num', step: '0.0001' },
    { k: 'bump', l: 'Shoulder bump (in)', t: 'num', step: '0.0005',
      hint: 'Measured off the fired case. This is what decides whether the bolt closes.' },
    { k: 'bushing', l: 'Bushing / neck tension (in)', t: 'text', ph: '.289' },
    { k: 'primerDepth', l: 'Primer seating depth (in)', t: 'num', step: '0.001' },
    { k: 'press', l: 'Press / dies', t: 'text' },
    { k: 'storage', l: 'Storage', t: 'text' },
    { k: 'notes', l: 'Notes', t: 'area' },
  ]},

  session: { title: 'Range session', fields: [
    { k: 'batch', l: 'Batch', t: 'ref', ref: () => DB.batches, label: b => b.serial,
      req: true, hard: true },
    { k: 'firearm', l: 'Firearm', t: 'ref', ref: () => DB.firearms, label: f => f.name },
    { k: 'date', l: 'Date', t: 'date' },
    { k: 'rounds', l: 'Rounds fired', t: 'num', def: 10 },
    { k: 'distance', l: 'Distance (yd)', t: 'num', def: 100 },
    { k: 'vAvg', l: 'Avg velocity (fps)', t: 'num' },
    { k: 'vSd', l: 'Velocity SD (fps)', t: 'num', step: '0.1' },
    { k: 'vEs', l: 'Velocity ES (fps)', t: 'num' },
    { k: 'group', l: 'Group size (in)', t: 'num', step: '0.01' },
    { k: 'temp', l: 'Temperature (°F)', t: 'num' },
    { k: 'pressureSigns', l: 'Pressure signs', t: 'select', opts: [
      ['none', 'None'], ['flattened primers', 'Flattened primers'],
      ['cratered primers', 'Cratered primers'], ['ejector mark', 'Ejector mark'],
      ['stiff bolt lift', 'Stiff bolt lift'], ['case head expansion', 'Case head expansion']] },
    { k: 'notes', l: 'Notes', t: 'area' },
  ]},
};

/* Transient state for form controls that need it between renders. */
const UI = { lookup: {}, marks: {}, formKind: null, toast: null, cartNew: {},
             confirm: null, confirmTimer: null };

/* `rec` is the record being edited, or null when creating. Every control reads
 * its current value from it, so one description of a field serves both. */
function fieldHtml(f, kind, rec) {
  const hint = f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : '';
  const req = f.req ? 'required' : '';
  // A stored null and an absent key both mean "not set"; a stored 0 does not.
  const has = rec && rec[f.k] !== undefined && rec[f.k] !== null && rec[f.k] !== '';
  const val = has ? rec[f.k] : null;
  let ctrl = '';

  switch (f.t) {
    case 'area':
      ctrl = `<textarea name="${f.k}">${has ? esc(String(val)) : ''}</textarea>`; break;

    case 'num':
      ctrl = `<input type="number" inputmode="decimal" name="${f.k}"
        ${f.step ? `step="${f.step}"` : 'step="any"'}
        ${has ? `value="${esc(String(val))}"` : (f.def != null && !rec ? `value="${f.def}"` : '')} ${req}>`; break;

    case 'date':
      ctrl = `<input type="date" name="${f.k}" value="${has ? esc(String(val)) : today()}">`; break;

    case 'select':
      ctrl = `<select name="${f.k}">${f.opts.map(([v, l]) =>
        `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`; break;

    case 'ref': {
      const rows = f.ref();
      if (!rows.length) {
        return `<label class="f"><span>${esc(f.l)}</span>
          <div class="banner warn"><div class="small">None recorded yet.${
            f.req ? ' This is required before you can continue.' : ''}</div></div></label>`;
      }
      ctrl = `<select name="${f.k}" ${req}>${!f.req ? '<option value="">—</option>' : ''}
        ${rows.map(r => `<option value="${r.id}" ${r.id === val ? 'selected' : ''}>${
          esc(f.label(r))}</option>`).join('')}</select>`;
      break;
    }

    /* Cartridges: a list of what you have already, plus free text for a new
     * one. The same control does both, so there is no separate "manage
     * cartridges" screen to keep in sync. */
    case 'cartridge': {
      // With no cartridges recorded the select has nothing to choose but "add
      // new", so the change event never fires and the text field would stay
      // hidden -- a dead end on first run. Open it by default in that case.
      const open = UI.cartNew[f.k] || DB.cartridges.length === 0;
      ctrl = `<select name="${f.k}" data-act="cartsel" data-key="${f.k}" ${req}>
          ${DB.cartridges.length ? '' : '<option value="__new">— add the first cartridge —</option>'}
          ${DB.cartridges.map(c =>
            `<option value="${c.id}" ${!open && c.id === val ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          <option value="__new" ${open ? 'selected' : ''}>+ Add new cartridge…</option>
        </select>
        <input type="text" name="${f.k}__new" class="mt6 ${open ? '' : 'hidden'}"
          placeholder="e.g. 6.5 Creedmoor" autocomplete="off">
        <div class="row g8 mt6 ${open ? '' : 'hidden'}" data-newcase="${f.k}">
          <select name="${f.k}__shape" aria-label="Case shape">
            ${Object.entries(CASE_SHAPES).map(([v, l]) =>
              `<option value="${v}">${esc(l)}</option>`).join('')}
          </select>
          <select name="${f.k}__head" aria-label="Case head">
            ${Object.entries(CASE_HEADS).map(([v, l]) =>
              `<option value="${v}">${esc(l)}</option>`).join('')}
          </select>
        </div>
        <span class="fhint ${open ? '' : 'hidden'}" data-newcase="${f.k}">Shape and head are
          independent: .303 British is bottleneck AND rimmed, 9mm is straight and rimless.
          They only change the drawing you match brass against — rimless is right for almost
          every bottleneck rifle cartridge.</span>`;
      break;
    }

    case 'marks': {
      const sc = scheme();
      const clash = DB.brassLots.find(l => marksEqual(l.marks, UI.marks));
      const pickers = sc.positions.map(p => {
        let sw = sc.allowBlank
          ? `<button type="button" class="sw none ${UI.marks[p.id] == null ? 'on' : ''}"
               data-act="markpick" data-pos="${p.id}" data-val="">none</button>` : '';
        sw += sc.palette.filter(c => c.on).map(c =>
          `<button type="button" class="sw ${UI.marks[p.id] === c.id ? 'on' : ''}"
             style="background:${c.hex}" data-act="markpick" data-pos="${p.id}"
             data-val="${c.id}" title="${esc(c.name)}">${c.id}</button>`).join('');
        return `<div class="pos"><div class="poshdr"><b>${esc(p.label)}</b>
          <span>${esc(p.hint)}</span></div><div class="swatches">${sw}</div></div>`;
      }).join('');
      return `<div class="casewrap mb12">${caseSvg(UI.marks)}</div>${pickers}
        ${clash ? `<div class="banner bad"><div><b>Already used by ${esc(clash.serial)}</b>
          — ${esc(clash.headstamp)}.</div></div>` : ''}`;
    }

    default: {
      const listId = f.list ? `dl_${kind}_${f.k}` : null;
      const items = f.list ? [...new Set(f.list())].filter(Boolean) : [];
      ctrl = `<input type="text" name="${f.k}" ${req} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''}
        ${has ? `value="${esc(String(val))}"` : ''}
        ${listId ? `list="${listId}"` : ''} autocomplete="off">`
        + (listId ? `<datalist id="${listId}">${items.map(i =>
            `<option value="${esc(i)}">`).join('')}</datalist>` : '');
    }
  }
  return `<label class="f"><span>${esc(f.l)}</span>${ctrl}${hint}</label>`;
}

function formHtml(kind, ctx) {
  const spec = FORMS[kind];
  const shown = (ctx && ctx.kindSel) || null;
  const rec = (ctx && ctx.rec) || null;
  // Every field is rendered. Type-specific ones are hidden with a class and
  // toggled on change -- re-rendering the form would reset the <select> to its
  // first option and throw away anything already typed.
  return `<form id="frm" class="card" data-kind="${kind}" ${rec ? `data-edit="${rec.id}"` : ''} novalidate>
    ${spec.fields.map(f => {
      const html = f.only
        ? `<div data-only="${f.only}" class="${f.only === shown ? '' : 'hidden'}">${fieldHtml(f, kind, rec)}</div>`
        : fieldHtml(f, kind, rec);
      // The draw preview sits immediately under "Rounds loaded", not at the
      // foot of the form. It is the consequence of that one number, and a
      // consequence ten fields below the cause is a consequence nobody reads.
      return (kind === 'batch' && f.k === 'qty') ? html + '<div id="drawpv"></div>' : html;
    }).join('')}
    <button class="btn primary wide" type="submit">${rec ? 'Save changes'
      : 'Save ' + esc(spec.title.toLowerCase())}</button>
  </form>`;
}

/* What this batch will take off the shelf, updated as the form is filled in.
 *
 * This is the whole reason the app exists shown at the moment it matters: you
 * are deciding how many to load, and the constraint is how much powder is in
 * the jug. Finding that out by saving and reading an error is a worse app than
 * one that simply tells you while you are typing. */
function drawPreviewHtml(d) {
  const pv = drawPreview(d);
  if (!pv.rows.length) return '';
  const cap = maxRoundsFor(d);
  const dp = (r) => (r.unit === 'lb' ? 3 : 0);
  const rows = pv.rows.map(r => {
    const col = r.short ? 'var(--bad)' : r.after / Math.max(1e-9, r.left) < 0.2 ? 'var(--warn)' : '';
    // When short, say by HOW MUCH. "0 left" hides the size of the problem and
    // makes a 3-round shortfall look identical to a 3000-round one.
    const tail = r.short
      ? `<span style="color:var(--bad)">short ${Math.abs(r.after).toFixed(dp(r))}${r.unit}</span>`
      : `<span class="dim">→ ${r.after.toFixed(dp(r))} left</span>`;
    return `<div class="spread tiny" style="padding:3px 0">
      <span class="dim">${esc(r.name)}${r.brass ? ' <span class="dim">(back when fired)</span>' : ''}</span>
      <span class="mono" ${col ? `style="color:${col}"` : ''}>
        ${r.need.toFixed(dp(r))}${r.unit}${r.grains && r.unit === 'lb' ? ` <span class="dim">(${Math.round(r.grains)}gr)</span>` : ''}
        ${tail}
      </span></div>`;
  }).join('');
  const short = pv.rows.some(r => r.short);
  return `<div class="rowline" style="border:1px solid ${short ? 'var(--bad)' : 'var(--line)'};border-radius:10px;padding:10px 12px;margin:2px 0 14px">
    <div class="spread"><b class="small">This batch will use</b>
      ${cap ? `<button type="button" class="linkish tiny mono" data-act="fillmax" data-arg="${cap.max}"
        ${short ? 'style="color:var(--bad)"' : ''}>max ${cap.max} rounds</button>` : ''}</div>
    <div class="mt6">${rows}</div>
    ${cap && cap.max > 0 && !short
      ? `<div class="tiny dim mt6">Limited by ${esc(cap.limiter)}.</div>` : ''}
    ${short ? `<div class="tiny mt6" style="color:var(--bad)">■ Not enough on hand. Tap
        <b>max ${cap ? cap.max : 0} rounds</b> above to load what you have, or record more stock in Inventory.</div>` : ''}
  </div>`;
}

let lastDrawHtml = null;
function paintDrawPreview() {
  const host = document.getElementById('drawpv');
  const form = document.getElementById('frm');
  if (!host || !form) { lastDrawHtml = null; return; }
  let html = '';
  try { html = drawPreviewHtml(readForm(form, 'batch')); } catch (_) { html = ''; }
  // Only touch the DOM when the numbers actually changed.
  //
  // This is not an optimisation. Tapping "max N rounds" blurs the count field,
  // which fires `change`, which repainted this panel -- destroying the button
  // between mousedown and mouseup, so the click never landed and the tap did
  // nothing. Repainting identical HTML is never worth doing, and here it was
  // actively breaking the control.
  if (html === lastDrawHtml) return;
  lastDrawHtml = html;
  host.innerHTML = html;
}

/** Read a form into a plain object, resolving cartridge and numeric fields. */
function readForm(form, kind) {
  const fd = new FormData(form);
  const out = {};
  const selKind = fd0 => fd0.get('kind');
  for (const f of FORMS[kind].fields) {
    if (f.t === 'marks') { out.marks = Object.assign({}, UI.marks); continue; }
    if (f.only && f.only !== selKind(fd)) { out[f.k] = null; continue; }
    let v = fd.get(f.k);
    if (f.t === 'cartridge') {
      // Resolve, but do NOT create yet: a submit that fails validation must not
      // leave a new cartridge behind. Creation happens after validation passes.
      const fresh = (fd.get(f.k + '__new') || '').trim();
      if (v === '__new' || fresh) {
        const found = findCartridge(fresh);
        out[f.k] = found ? found.id : (fresh ? PENDING + fresh : null);
        // Held beside the pending name, and consumed with it. Creation happens
        // only after validation passes, so these travel the same route.
        out['__case_' + f.k] = { shape: fd.get(f.k + '__shape'), head: fd.get(f.k + '__head') };
      } else {
        out[f.k] = v;
      }
      continue;
    }
    if (f.t === 'num') { out[f.k] = num(v, f.def != null ? f.def : null); continue; }
    out[f.k] = v == null ? '' : String(v).trim();
  }
  return out;
}

/** Returns an error string, or null when the record is acceptable.
 *
 *  `editId` is the record being edited, when there is one. Every check that
 *  asks "does this collide with what already exists?" has to exclude the
 *  record itself, or editing a brass lot without touching its colour code
 *  would fail on the grounds that its own code is taken, and editing a batch
 *  would find the components it already holds unavailable. */
function validate(kind, d, editId) {
  for (const f of FORMS[kind].fields) {
    if (!f.req) continue;
    if (f.only && f.only !== d.kind) continue;
    if (f.t === 'ref' && !f.ref().length) continue;   // nothing to pick yet
    const v = d[f.k];
    if (v === '' || v == null || (f.t === 'num' && !Number.isFinite(v))) {
      return `${f.l} is required.`;
    }
  }
  if (kind === 'brass' && DB.brassLots.some(l => l.id !== editId && marksEqual(l.marks, d.marks))) {
    return 'That colour code is already in use.';
  }
  if (kind === 'component' && d.qty <= 0) return 'Quantity must be greater than zero.';
  if (kind === 'component' && editId) {
    const lot = byId(DB.componentLots, editId);
    // Correcting a purchase quantity downward is legitimate; correcting it
    // below what batches have already drawn is not a correction, it is a
    // negative stock figure.
    const used = lot ? lotUsed(Object.assign({}, lot, { unit: d.unit || lot.unit })) : 0;
    if (d.qty < used) {
      return `Batches have already drawn ${used.toFixed(used % 1 ? 3 : 0)} from this lot. `
        + `Set it to ${Math.ceil(used)} or more, or delete those batches first.`;
    }
  }
  if (kind === 'brass' && editId) {
    const lot = byId(DB.brassLots, editId);
    const gone = lot ? casesLost(lot) : 0;
    const loaded = lot ? brassCommitted(lot) : 0;
    if (d.initialQty < gone + loaded) {
      return `${gone} case${gone === 1 ? '' : 's'} removed and ${loaded} sitting in loaded `
        + `rounds already account for ${gone + loaded}. The lot cannot be smaller than that.`;
    }
  }
  if (kind === 'cull') {
    const l = byId(DB.brassLots, (cur().arg || {}).lot);
    if (!l) return 'That brass lot no longer exists.';
    if (!(d.n > 0)) return 'Removing zero cases would record nothing.';
    const free = brassAvailable(l);
    if (d.n > brassOnHand(l)) {
      return `Only ${brassOnHand(l)} case${brassOnHand(l) === 1 ? '' : 's'} in this lot.`;
    }
    // Cases inside loaded rounds are not on the bench to be culled. Saying so
    // beats letting the free count go negative.
    if (d.n > free) {
      return `Only ${free} case${free === 1 ? '' : 's'} are free — `
        + `${brassCommitted(l)} are inside loaded rounds. Fire or pull those first.`;
    }
  }
  if (kind === 'ladder') {
    const steps = Math.round(+d.steps || 0), per = Math.round(+d.perStep || 0);
    if (steps < 2) return 'A ladder needs at least two rungs.';
    if (steps > 40) return 'Forty rungs is the limit — a ladder that long is a different experiment.';
    if (per < 1) return 'Each rung needs at least one round.';
    if (!(Math.abs(+d.step) > 0)) return 'A step of zero would build the same load N times.';
    // Check the WHOLE ladder against stock, not one rung. Discovering on rung
    // six that the powder ran out leaves five orphan batches and a serial gap.
    const rr = byId(DB.recipes, (cur().arg || {}).recipe);
    const worst = d.axis === 'cbto'
      ? (rr ? +rr.charge : 0)
      : Math.max(+d.start || 0, (+d.start || 0) + (steps - 1) * (+d.step || 0));
    const pv = drawPreview({ recipe: (cur().arg || {}).recipe, brassLot: d.brassLot,
      bulletLot: d.bulletLot, powderLot: d.powderLot, primerLot: d.primerLot,
      qty: steps * per, chargeActual: worst });
    const short = pv.rows.filter(x => x.short);
    if (short.length) {
      const dp = (x) => (x.unit === 'lb' ? 3 : 0);
      return `${steps} rungs of ${per} is ${steps * per} rounds, and there is not enough `
        + short.map(x => `${x.name} (short ${Math.abs(x.after).toFixed(dp(x))}${x.unit})`).join(' or ')
        + '. Nothing was built.';
    }
  }
  if (kind === 'batch' && d.qty <= 0) return 'Rounds loaded must be greater than zero.';
  if (kind === 'batch') {
    // Cartridge is an id comparison with no fuzziness in it, so it is the one
    // component check that refuses outright. Everything else in
    // batchMismatches() is a free-text comparison and warns instead.
    const rr = byId(DB.recipes, d.recipe);
    const bl = byId(DB.brassLots, d.brassLot);
    if (rr && bl && rr.cartridge && bl.cartridge && rr.cartridge !== bl.cartridge) {
      return `${bl.serial} is ${cartName(bl.cartridge)} brass and this recipe is `
        + `${cartName(rr.cartridge)}. Pick a lot in the right cartridge.`;
    }
    // Editing a batch already loaded on this brass is not the moment to
    // refuse: the rounds exist. Only a NEW batch is blocked.
    const brassLot = editId ? null : bl;
    if (brassLot && !brassLot.retired) {
      const life = brassLife(brassLot);
      if (life.mean >= brassLot.expectedFirings && brassLot.expectedFirings > 0) {
        return `${brassLot.serial} is at ${life.mean.toFixed(1)} firings against an `
          + `expected life of ${brassLot.expectedFirings}. Retire the lot, or raise `
          + `its expected life if you have inspected the cases.`;
      }
    }
  }
  if (kind === 'batch') {
    // Refuse rather than go negative. A stock figure that can be negative is
    // not a stock figure, and silently allowing it is how the inventory stops
    // being worth reading.
    const pv = drawPreview(d, editId);
    const short = pv.rows.filter(r => r.short);
    if (short.length) {
      const cap = maxRoundsFor(d, editId);
      const dp = (r) => (r.unit === 'lb' ? 3 : 0);
      return `Not enough ${short.map(r => esc(r.name)).join(' and ')}. `
        + short.map(r => `${r.name}: need ${r.need.toFixed(dp(r))}${r.unit}, `
            + `${Math.max(0, r.left).toFixed(dp(r))}${r.unit} on hand`).join('; ')
        + `. These lots will make ${cap ? cap.max : 0} rounds.`;
    }
  }
  return null;
}

/* ==========================================================================
 * Router. One stack, one render function, one delegated click handler.
 * ========================================================================*/
let stack = [{ v: 'lookup' }];
const cur = () => stack[stack.length - 1];
const go = (v, arg) => { stack.push({ v, arg }); render(); scrollTo(0, 0); };
const back = () => { if (stack.length > 1) stack.pop(); render(); scrollTo(0, 0); };
const reset = (v) => { stack = [{ v }]; render(); scrollTo(0, 0); };
const toast = (m) => { UI.toast = m; };

const TABS = [
  ['lookup', 'Identify', 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4'],
  ['brass', 'Brass', 'M8 3h8v13l-4 5-4-5z M8 8h8'],
  ['ammo', 'Ammo', 'M4 9h16v11H4z M7 9V5a5 5 0 0 1 10 0v4'],
  ['more', 'More', 'M4 7h16 M4 12h16 M4 17h16'],
];

const TITLES = {
  lookup: ['Identify', 'match colours or scan a serial'],
  brass: ['Brass', 'lots and lifecycle'],
  brassDetail: ['Brass lot', ''],
  ammo: ['Ammunition', 'loaded batches'],
  ammoDetail: ['Batch', ''],
  label: ['Label', 'print and cut'],
  more: ['More', ''],
  inventory: ['Inventory', 'component lots'],
  recipes: ['Recipes', 'load specifications'],
  firearms: ['Firearms', ''],
  cartridges: ['Cartridges', 'case shape and head'],
  scanned: ['Scanned label', 'opened in a browser'],
  settings: ['Marking scheme', ''],
  data: ['Data', 'backup and reset'],
  sync: ['Cloud sync', 'shared with Zero'],
  form: ['', ''],
};

function render() {
  const c = cur();
  let [t, s] = TITLES[c.v] || ['', ''];
  if (c.v === 'form') { t = 'New ' + FORMS[c.arg.kind].title.toLowerCase(); s = ''; }
  document.getElementById('title').innerHTML =
    esc(t) + (s ? `<div class="sub">${esc(s)}</div>` : '');
  document.getElementById('back').classList.toggle('hidden', stack.length < 2);
  paintSyncChip();
  const warn = Store.persistent ? '' : `<div class="banner bad noprint"><div>
      <b>Not saving to this device.</b><span class="small">This browser is blocking
      local storage, so records live in memory and vanish when the page reloads.
      Sandboxed previews always do this. Download the file and open it directly,
      or deploy it, and saving works normally. Export from More &rsaquo; Data to
      keep anything you enter here.</span></div></div>`;
  document.getElementById('view').innerHTML =
    warn + (VIEWS[c.v] || (() => '<div class="empty">Not found</div>'))(c.arg);
  document.getElementById('tabs').innerHTML = TABS.map(([v, label, icon]) => `
    <button data-act="tab" data-arg="${v}" class="${c.v === v ? 'on' : ''}"
      aria-current="${c.v === v ? 'page' : 'false'}">
      <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="${icon}"/></svg>
      <span>${label}</span></button>`).join('');

  if (c.v === 'form' && c.arg && c.arg.kind === 'batch') paintDrawPreview();

  /* An armed delete, painted after the view rather than inside it: the views
   * do not know about confirmation, and should not have to. Every destructive
   * button in the app gets this behaviour by existing. */
  if (UI.confirm) {
    const [act, arg] = [UI.confirm.slice(0, UI.confirm.indexOf(':')),
                        UI.confirm.slice(UI.confirm.indexOf(':') + 1)];
    const sel = `[data-act="${act}"]` + (arg ? `[data-arg="${arg}"]` : '');
    const btn = document.querySelector(sel);
    if (btn) {
      btn.textContent = 'Tap again';
      btn.classList.add('danger', 'armed');
      btn.setAttribute('aria-label', 'Tap again to confirm deletion');
    } else {
      UI.confirm = null;              // the button is not on this screen any more
    }
  }

  if (UI.toast) {
    const d = document.createElement('div');
    d.className = 'toast';
    d.setAttribute('role', 'status');
    d.textContent = UI.toast;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2800);
    UI.toast = null;
  }
}

/* The header chip. Short label, long aria-label: the visible text has to fit
 * beside a title on a phone, but a screen reader gets the whole sentence.
 *
 * The chip navigates; it never syncs. A control that fires a network write
 * from a spot the thumb rests on while scrolling is a control that fires by
 * accident, and this one is present on every screen. */
function paintSyncChip() {
  const el = document.getElementById('syncchip');
  if (!el) return;
  if (!CORE) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const st = UI.sync || {};
  const pending = CORE.isSignedIn() ? CORE.pendingCount() : 0;
  let text, label, cls;
  if (!CORE.isSignedIn()) {
    text = 'Sign in'; label = 'Not signed in — set up cloud sync with Zero'; cls = 'act';
  } else if (st.busy) {
    text = '⇅'; label = 'Syncing'; cls = 'busy';
  } else if (pending) {
    text = '⇅ ' + pending; label = `${pending} record${pending === 1 ? '' : 's'} waiting to send`; cls = 'wait';
  } else {
    text = '⇅'; label = 'Signed in — everything sent'; cls = '';
  }
  el.textContent = text;
  el.setAttribute('aria-label', label);
  el.className = 'syncchip' + (cls ? ' ' + cls : '');
}

/** Empty state with a single call to action pointing at the ONE page that
 *  owns creating this kind of record. */
const empty = (msg, cta) => `<div class="empty"><p>${msg}</p>${
  cta ? `<button class="btn" data-act="${cta[0]}" data-arg="${cta[1] || ''}">${cta[2]}</button>` : ''}</div>`;

const VIEWS = {};

/* --------------------------------------------------------------- Identify */
VIEWS.lookup = () => {
  const sc = scheme(), st = UI.lookup;
  sc.positions.forEach(p => { if (!(p.id in st)) st[p.id] = '?'; });
  const preview = {};
  sc.positions.forEach(p => { preview[p.id] = st[p.id] === '?' ? null : st[p.id]; });

  const pickers = sc.positions.map(p => {
    let sw = `<button class="sw any ${st[p.id] === '?' ? 'on' : ''}"
      data-act="pick" data-pos="${p.id}" data-val="?">?</button>`;
    if (sc.allowBlank) sw += `<button class="sw none ${st[p.id] === null ? 'on' : ''}"
      data-act="pick" data-pos="${p.id}" data-val="">none</button>`;
    sw += sc.palette.filter(c => c.on).map(c =>
      `<button class="sw ${st[p.id] === c.id ? 'on' : ''}" style="background:${c.hex}"
        data-act="pick" data-pos="${p.id}" data-val="${c.id}" title="${esc(c.name)}">${c.id}</button>`).join('');
    return `<div class="pos"><div class="poshdr"><b>${esc(p.label)}</b>
      <span>${esc(p.hint)}</span></div><div class="swatches">${sw}</div></div>`;
  }).join('');

  const matches = DB.brassLots.filter(l =>
    sc.positions.every(p => st[p.id] === '?' || (l.marks[p.id] || null) === st[p.id]));
  const any = sc.positions.some(p => st[p.id] !== '?');

  let result = '';
  if (!DB.brassLots.length) {
    result = empty('No brass lots recorded yet.', ['nav', 'brass', 'Go to Brass']);
  } else if (!any) {
    result = `<div class="empty"><p>Tap the colours you can see on the case.
      Leave a position on <b>?</b> if the paint has worn off.</p></div>`;
  } else if (!matches.length) {
    result = `<div class="banner bad"><div><b>No lot matches that combination.</b>
      <span class="small">Either it isn't issued yet, or a mark has worn. Set the
      doubtful position back to <b>?</b> to widen the search.</span></div></div>`;
  } else {
    result = matches.map(brassRow).join('');
  }

  /* Signed out, the sign-in block sits ABOVE the tool: it is the one thing a
   * new user has to do once, and burying it is what made "where is the sync
   * button" a question in the first place. Signed in, it drops below the tool
   * as a status readout with the sync button on it. */
  const signedOut = !!CORE && !CORE.isSignedIn();

  return `${signedOut ? syncCard() : ''}
  <div class="card">
    <div class="casewrap mb12">${caseSvg(preview, { cart: identifyCart() })}</div>
    ${pickers}
    <div class="row spread">
      <span class="tiny dim">${matches.length} of ${DB.brassLots.length} match</span>
      <button class="btn sm" data-act="clearpick">Reset</button>
    </div>
  </div>
  ${result}
  <div class="card">
    <h2>By serial</h2>
    <p class="small muted">Scan the QR on a box label with your phone camera, or type
      the serial. The check character catches typos before you reach a wrong record.</p>
    <div class="serialbox">
      <input type="text" id="serialIn" inputmode="text" autocapitalize="characters"
        autocomplete="off" spellcheck="false" placeholder="B26H13-01D" aria-label="Serial">
      <button class="btn primary" data-act="serialgo">Find</button>
    </div>
    <div id="serialMsg" class="small mt8"></div>
  </div>
  ${signedOut ? '' : syncCard({ compact: true })}`;
};

/* Which case to draw on the Identify screen, where no cartridge has been
 * chosen yet. If every brass lot recorded is the same kind of case, draw that
 * kind -- the picture is being held against a real case, and someone who loads
 * one cartridge should see their cartridge. Mixed, or nothing recorded, falls
 * back to the default rather than picking a winner. */
function identifyCart() {
  const carts = (DB.brassLots || []).map(l => byId(DB.cartridges, l.cartridge)).filter(Boolean);
  if (!carts.length) return null;
  const key = (c) => caseShape(c) + '|' + caseHead(c);
  const first = key(carts[0]);
  return carts.every(c => key(c) === first) ? carts[0] : null;
}

function brassRow(l) {
  return `<button class="listitem" data-act="brassDetail" data-arg="${l.id}">
    ${caseSvg(l.marks, { mini: true, cart: l.cartridge })}
    <span class="grow">
      <span class="ttl">${esc(l.headstamp)} · ${esc(cartName(l.cartridge))}</span>
      <span class="sub mono">${esc(l.serial)} · ${esc(codeOf(l.marks))}</span>
      <span class="sub">${brassOnHand(l)} cases · ${brassLife(l).mean.toFixed(1)} of ${l.expectedFirings} firings</span>
      ${brassChips(l).length ? `<span class="sub mt5">${chips(brassChips(l))}</span>` : ''}
    </span><span class="chev">›</span></button>`;
}

/* ------------------------------------------------------------------ Brass */
VIEWS.brass = () => {
  const cap = schemeCapacity(), used = DB.brassLots.length;
  const list = used
    ? `<div class="card tight">
         <div class="spread"><b class="small">Colour codes used</b>
           <span class="small mono">${used} / ${cap}</span></div>
         <div class="capbar"><i style="width:${cap ? Math.min(100, used / cap * 100) : 0}%"></i></div>
       </div>${DB.brassLots.map(brassRow).join('')}`
    : empty('No brass lots yet. A lot is a group of cases you keep together and track through their life.');
  return list + `<button class="btn primary wide" data-act="new" data-arg="brass">+ New brass lot</button>`;
};

VIEWS.brassDetail = (id) => {
  const l = byId(DB.brassLots, id);
  if (!l) return `<div class="empty">This lot no longer exists.</div>`;
  const used = DB.batches.filter(b => b.brassLot === l.id);
  const life = brassLife(l);
  const pct = Math.min(100, l.expectedFirings ? life.mean / l.expectedFirings * 100 : 0);
  const hiPct = Math.min(100, l.expectedFirings ? life.hi / l.expectedFirings * 100 : 0);
  const bar = pct >= 100 ? 'var(--bad)' : hiPct >= 100 ? 'var(--warn)' : 'var(--ok)';
  const an = annealState(l);
  return `<div class="card">
      <div class="spread mb8">
        <div><h2 class="m0">${esc(l.headstamp)}</h2>
          <div class="small muted">${esc(cartName(l.cartridge))}${l.maker ? ' · ' + esc(l.maker) : ''}</div></div>
        <div class="mono big">${esc(l.serial)}</div>
      </div>
      ${brassChips(l).length ? `<div>${chips(brassChips(l))}</div>` : ''}
      <div class="casewrap mt12">${caseSvg(l.marks, { cart: l.cartridge })}</div>
      <div class="small muted center mt8">Marked&nbsp;<b class="mono">${esc(codeOf(l.marks))}</b></div>
    </div>
    <div class="card">
      <div class="spread small"><span>${life.mean.toFixed(2)} of ${l.expectedFirings} expected firings</span>
        <span class="mono">${pct.toFixed(0)}%</span></div>
      <div class="capbar"><i style="width:${pct}%;background:${bar}"></i></div>
      <div class="tiny dim mt4">
        ${life.fired} round${life.fired === 1 ? '' : 's'} fired, each counted against the lot as it
        stood at the time${life.base ? `, on top of ${life.base} before this lot was recorded` : ''}.
        Cases are mixed back together between loadings, so this is the mean per case.
      </div>
      ${life.sd > 0.05 ? `<div class="tiny mt4" style="color:${hiPct >= 100 ? 'var(--warn)' : 'var(--dim)'}">
        Partial draws mean they are not all equal — the most-fired case is probably near
        <b>${life.hi.toFixed(1)}</b>. Retire on that, not on the average.
      </div>` : ''}
      <hr>
      <dl class="kv">
        <dt>Cases on hand</dt><dd class="mono">${brassOnHand(l)} of ${l.initialQty}${
          casesLost(l) ? ` · ${casesLost(l)} removed` : ''}</dd>
        <dt>Committed</dt><dd class="mono">${brassCommitted(l)} loaded · ${brassAvailable(l)} free</dd>
        <dt>Origin</dt><dd>${esc(l.origin || '—')}</dd>
        <dt>Acquired</dt><dd>${fmtDate(l.acquired)}</dd>
        <dt>Last anneal</dt><dd>${an.last
          ? `${fmtDate(an.last.date)} <span class="dim">· ${an.since.toFixed(1)} firing${
              an.since === 1 ? '' : 's'} since</span>`
          : '<span class="chip warn">never</span>'}</dd>
        ${an.every > 0 ? `<dt>Anneal interval</dt><dd class="mono">every ${an.every}</dd>` : ''}
        ${l.trimTo ? `<dt>Trim to</dt><dd class="mono">${l.trimTo}"${
          l.maxLength ? ` <span class="dim">· max ${l.maxLength}"</span>` : ''}</dd>` : ''}
        ${l.weightSort ? `<dt>Weight sorted</dt><dd class="mono">${esc(l.weightSort)}</dd>` : ''}
        <dt>Lot cost</dt><dd class="mono">${l.cost ? money2(l.cost) : '—'}</dd>
        <dt>Amortised</dt><dd class="mono">${l.cost && l.initialQty && l.expectedFirings
          ? money(l.cost / (l.initialQty * l.expectedFirings)) + '/rd' : '—'}</dd>
      </dl>
      ${l.notes ? `<hr><p class="small muted m0">${esc(l.notes)}</p>` : ''}
    </div>
    ${(l.culls || []).length ? `<div class="card"><h2>Cases removed</h2>
      ${l.culls.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map(c => `
        <div class="rowline"><div class="spread small">
          <span>${esc(CULL_REASONS[c.reason] || 'No reason given')}</span>
          <span class="mono">−${c.n}</span></div>
        <div class="tiny dim">${fmtDate(c.date)}${c.note ? ' · ' + esc(c.note) : ''}</div></div>`).join('')}
      <div class="tiny dim mt6">Removing cases changes the count only. The cases still in
        the lot have been fired exactly as often as they had been before.</div>
    </div>` : ''}
    <div class="card"><h2>Used by</h2>${used.length
      ? used.map(b => `<button class="listitem" data-act="ammoDetail" data-arg="${b.id}">
          <span class="grow"><span class="ttl mono">${esc(b.serial)}</span>
          <span class="sub">${b.qty} rounds · ${fmtDate(b.date)}</span></span>
          <span class="chev">›</span></button>`).join('')
      : '<div class="empty"><p>Not loaded into any batch yet.</p></div>'}</div>
    ${(l.anneals || []).length ? `<div class="card"><h2>Annealing</h2>
      ${l.anneals.slice().reverse().map(a => `<div class="rowline">
        <div class="spread small"><span>${fmtDate(a.date)}</span>
          <span class="mono dim">at ${(+a.at || 0).toFixed(1)}f
            <button class="linkbtn" data-act="unanneal" data-arg="${l.id}:${a.id}">undo</button></span></div>
        ${a.note ? `<div class="tiny dim">${esc(a.note)}</div>` : ''}</div>`).join('')}
    </div>` : ''}
    <div class="btnrow noprint">
      <button class="btn" data-act="cull" data-arg="${l.id}">Remove cases</button>
      <button class="btn" data-act="logfire" data-arg="${l.id}"
        title="For firings this app did not see — batches count themselves">+1 outside firing</button>
      <button class="btn ${an.due ? 'primary' : ''}" data-act="loganneal" data-arg="${l.id}">Log anneal</button>
      <button class="btn" data-act="edit" data-kind="brass" data-arg="${l.id}">Edit</button>
      <button class="btn" data-act="retire" data-arg="${l.id}">${l.retired ? 'Return to service' : 'Retire lot'}</button>
      <button class="btn danger" data-act="delBrass" data-arg="${l.id}">Delete</button>
    </div>`;
};

/* ------------------------------------------------------------------- Ammo */
VIEWS.ammo = () => {
  const list = DB.batches.length
    ? [...DB.batches].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(b => {
        const r = recipeOf(b);
        return `<button class="listitem" data-act="ammoDetail" data-arg="${b.id}">
          <span class="grow">
            <span class="ttl mono">${esc(b.serial)}</span>
            <span class="sub">${esc(r ? r.name : 'recipe missing')}</span>
            <span class="sub">${roundsLeft(b)} of ${b.qty} rounds · ${fmtDate(b.date)}</span>
            <span class="sub mt5">${chips(batchChips(b))}</span>
          </span><span class="chev">›</span></button>`;
      }).join('')
    : (DB.recipes.length
        ? empty('No batches yet.')
        : empty('A batch needs a recipe first — a recipe is the load specification you build from.',
                ['nav', 'recipes', 'Go to Recipes']));
  return list + (DB.recipes.length
    ? `<button class="btn primary wide" data-act="new" data-arg="batch">+ New batch</button>` : '');
};

VIEWS.ammoDetail = (id) => {
  const b = byId(DB.batches, id);
  if (!b) return `<div class="empty">This batch no longer exists.</div>`;
  const r = recipeOf(b), c = costPerRound(b), sess = sessionsFor(b.id);
  const brass = byId(DB.brassLots, b.brassLot);
  const frac = maxFraction(b);
  const pct = frac == null ? null : frac * 100;
  const thrown = chargeOf(b);
  // Name the charge for what it is. "41.5 gr" against a max reads very
  // differently depending on whether anyone put it on a scale.
  const chargeWord = b.chargeActual ? 'as weighed' : 'recipe target';

  let warn = '';
  if (b.quarantine) warn += `<div class="banner bad"><div><b>QUARANTINED — DO NOT FIRE</b>
    ${b.notes ? `<span class="small">${esc(b.notes)}</span>` : ''}</div></div>`;
  if (isOverMax(b)) warn += `<div class="banner bad"><div><b>Charge exceeds the published maximum.</b>
    <span class="small">${thrown} gr ${chargeWord}, against a cited max of ${r.sourceMax} gr
    (${pct.toFixed(1)}%). Work up from below and watch for pressure signs.</span></div></div>`;
  const mism = batchMismatches(b);
  if (mism.length) {
    const stop = mism.some(m => m.severity === 'stop');
    warn += `<div class="banner ${stop ? 'bad' : 'warn'}"><div><b>${
      stop ? 'This ammunition does not match its recipe.' : 'Component names do not match the recipe.'}</b>
      <span class="small">${mism.map(m =>
        `${m.what}: the recipe calls for <b>${esc(m.wanted)}</b>, this batch was built with <b>${esc(m.got)}</b>.`
      ).join(' ')} ${stop
        ? 'Charge weights are not transferable between components. Do not fire this until you have confirmed which is right.'
        : 'If the two are the same thing under different names, edit one to match.'}</span></div></div>`;
  }
  if (isUntested(b) && !b.quarantine) warn += `<div class="banner warn"><div><b>Untested.</b>
    <span class="small">No range session recorded against this batch yet.</span></div></div>`;

  const lot = (k) => { const cl = byId(DB.componentLots, b[k]); return cl
    ? `<div class="spread small rowline"><span>${esc(cl.name)}</span>
        <span class="mono dim">${cl.lot ? 'lot ' + esc(cl.lot) : ''}</span></div>` : ''; };

  return `${warn}
  <div class="card">
    <div class="mono huge">${esc(b.serial)}</div>
    <div class="small muted mt3 mb8">${esc(r ? r.name : 'recipe missing')}${
      r ? ' · ' + esc(cartName(r.cartridge)) : ''}</div>
    <div class="row wrap g6">${chips(batchChips(b))}</div>
    <hr>
    <dl class="kv">
      <dt>Loaded</dt><dd>${fmtDate(b.date)}</dd>
      <dt>Rounds</dt><dd class="mono">${roundsLeft(b)} of ${b.qty} remaining</dd>
      ${roundsFired(b) ? `<dt>Fired</dt><dd class="mono">${roundsFired(b)}</dd>` : ''}
      ${roundsAccounted(b) ? `<dt>Otherwise gone</dt><dd class="mono">${roundsAccounted(b)}</dd>` : ''}
      <dt>Storage</dt><dd>${esc(b.storage || '—')}</dd>
    </dl>
    ${(b.adjust || []).length ? `<hr><div class="small muted">${(b.adjust || []).map(a =>
      `<div class="spread"><span>${fmtDate(a.date)} · ${esc(ROUND_REASONS[a.reason] || a.reason)}${
        a.note ? ' — ' + esc(a.note) : ''}</span>
       <span class="mono">−${a.n}
         <button class="linkbtn" data-act="unadjust" data-arg="${b.id}:${a.id}">undo</button></span></div>`
      ).join('')}</div>` : ''}
    <div class="btnrow mt12 noprint">
      <button class="btn primary" data-act="label" data-arg="${b.id}">Label</button>
      <button class="btn" data-act="newSessionFor" data-arg="${b.id}">Log range session</button>
      <button class="btn" data-act="adjustRounds" data-arg="${b.id}">Account for rounds</button>
      <button class="btn" data-act="editBatch" data-arg="${b.id}">Edit</button>
      <button class="btn ${b.quarantine ? '' : 'danger'}" data-act="toggleQ" data-arg="${b.id}">
        ${b.quarantine ? 'Release' : 'Quarantine'}</button>
    </div>
  </div>
  <div class="card"><h2>Load</h2>
    <dl class="kv">
      <dt>Charge</dt><dd class="mono">${b.chargeActual ?? (r ? r.charge : '—')} gr</dd>
      ${b.chargeSd != null ? `<dt>Charge SD</dt><dd class="mono">${b.chargeSd} gr</dd>` : ''}
      <dt>COAL</dt><dd class="mono">${b.coalMean ?? (r ? r.coal : null) ?? '—'}"</dd>
      ${(b.cbtoMean ?? (r ? r.cbto : null)) != null
        ? `<dt>CBTO</dt><dd class="mono">${b.cbtoMean ?? r.cbto}"</dd>` : ''}
      ${b.bump != null ? `<dt>Shoulder bump</dt><dd class="mono">${b.bump}"</dd>` : ''}
      ${b.bushing ? `<dt>Bushing</dt><dd class="mono">${esc(b.bushing)}</dd>` : ''}
      ${b.primerDepth != null ? `<dt>Primer depth</dt><dd class="mono">${b.primerDepth}"</dd>` : ''}
      ${b.runout != null ? `<dt>Runout TIR</dt><dd class="mono">${b.runout}"</dd>` : ''}
      ${b.press ? `<dt>Press / dies</dt><dd>${esc(b.press)}</dd>` : ''}
    </dl>
    ${b.notes && !b.quarantine ? `<hr><p class="small muted m0">${esc(b.notes)}</p>` : ''}
    ${r ? `<hr><div class="small muted"><b>Source:</b> ${esc(r.source)}${
      r.page ? ' · ' + esc(r.page) : ''}${pct != null ? `<br>Published max ${r.sourceMax} gr —
      this ammunition is <b style="color:${pct > 100 ? 'var(--bad)' : pct > 97 ? 'var(--warn)' : 'var(--ok)'}">${
      pct.toFixed(1)}%</b> of max, ${chargeWord}.${
      b.chargeActual && r.charge && +b.chargeActual !== +r.charge
        ? ` The recipe called for ${r.charge} gr.` : ''}`
      : '<br>No published maximum recorded.'}</div>` : ''}
  </div>
  <div class="card"><h2>Components</h2>
    ${lot('bulletLot')}${lot('powderLot')}${lot('primerLot')}
    ${brass ? `<button class="listitem mt10" data-act="brassDetail" data-arg="${brass.id}">
      ${caseSvg(brass.marks, { mini: true, cart: brass.cartridge })}
      <span class="grow"><span class="ttl">${esc(brass.headstamp)}</span>
        <span class="sub mono">${esc(brass.serial)} · ${esc(codeOf(brass.marks))}</span></span>
      <span class="chev">›</span></button>` : ''}
  </div>
  <div class="card"><h2>Cost</h2>
    <dl class="kv">
      <dt>Bullet</dt><dd class="mono">${money(c.bullet)}</dd>
      <dt>Powder</dt><dd class="mono">${money(c.powder)}</dd>
      <dt>Primer</dt><dd class="mono">${money(c.primer)}</dd>
      <dt>Brass</dt><dd class="mono">${money(c.brass)}</dd>
    </dl><hr>
    <div class="spread"><b>Per round</b><b class="mono">${money(c.total)}</b></div>
    <div class="spread small muted"><span>This batch (${b.qty})</span>
      <span class="mono">${money2(c.total * b.qty)}</span></div>
    ${c.known ? '' : '<div class="tiny dim mt6">A component lot has no quantity recorded, so this is incomplete.</div>'}
  </div>
  <div class="card"><h2>Range results</h2>${sess.length ? sess.map(s => {
      const f = byId(DB.firearms, s.firearm);
      return `<div class="rowline">
        <div class="spread"><b class="small">${fmtDate(s.date)}</b>
          <span class="small dim">${esc(f ? f.name : '')}</span></div>
        <dl class="kv mt6">
          <dt>Rounds</dt><dd class="mono">${s.rounds ?? '—'}</dd>
          ${s.vAvg != null ? `<dt>Velocity</dt><dd class="mono">${s.vAvg} fps</dd>` : ''}
          ${s.vSd != null ? `<dt>SD / ES</dt><dd class="mono">${s.vSd} / ${s.vEs ?? '—'}</dd>` : ''}
          ${s.group != null ? `<dt>Group @ ${s.distance}y</dt><dd class="mono">${s.group}"</dd>` : ''}
          ${s.temp != null ? `<dt>Temperature</dt><dd class="mono">${s.temp}°F</dd>` : ''}
          <dt>Pressure signs</dt><dd>${s.pressureSigns === 'none'
            ? '<span class="chip ok">none</span>'
            : `<span class="chip bad">${esc(s.pressureSigns)}</span>`}</dd>
        </dl>${s.notes ? `<p class="small muted mt6 m0">${esc(s.notes)}</p>` : ''}
        <div class="btnrow mt8 noprint">
          <button class="btn sm" data-act="editSession" data-arg="${s.id}">Edit</button>
          <button class="btn sm danger" data-act="delSession" data-arg="${s.id}">Delete</button>
        </div></div>`;
    }).join('') : '<div class="empty"><p>Nothing fired from this batch yet.</p></div>'}</div>
  <div class="btnrow noprint">
    <button class="btn danger" data-act="delBatch" data-arg="${b.id}">Delete batch</button>
  </div>`;
};

/* ------------------------------------------------------------------ Label */
VIEWS.label = (id) => {
  const b = byId(DB.batches, id);
  if (!b) return `<div class="empty">This batch no longer exists.</div>`;
  return `<div class="card noprint">
      <p class="small muted m0">Print, cut on the dashed line, and drop it under the box lid.
        The QR opens this record; the serial underneath is the fallback.</p>
      <div class="btnrow mt12">
        <button class="btn primary" data-act="printOne">Print one</button>
        <button class="btn" data-act="printSheet" data-arg="${b.id}">Print a sheet of 8</button>
      </div>
    </div>
    <div class="center"><div class="label-preview" id="single">${labelHtml(b)}</div></div>
    <div class="sheet hidden" id="sheet"></div>`;
};

function labelHtml(b) {
  const r = recipeOf(b), brass = byId(DB.brassLots, b.brassLot);
  const url = (DB.meta.baseUrl || '') + '/#/s/' + b.serial;
  const qr = QR.toSvg(url, { ecc: 'M', quietZone: 2 });
  const band = b.quarantine ? 'DO NOT FIRE — QUARANTINED'
    : isOverMax(b) ? 'OVER PUBLISHED MAX'
    : batchMismatches(b).some(m => m.severity === 'stop') ? 'DOES NOT MATCH RECIPE'
    : isUntested(b) ? 'UNTESTED — WORK UP' : '';
  /* The marking scheme, drawn ON A CASE rather than as a row of dots.
   *
   * A row of coloured circles is a legend for a code, not the thing itself.
   * The label is read at a bench with a box open and a case in the other hand,
   * and the question being asked is "is this the brass in this box" -- which
   * means matching a band at a POSITION, not a colour in a sequence. Two
   * positions the same colour in a different order are two different lots, and
   * dots in a row make that a counting exercise. The drawing puts each mark
   * where it actually is on the case, including the head, which has no place
   * in a row at all.
   *
   * Same renderer as the Identify screen and the brass list, so what is
   * printed and what is matched against on the phone cannot drift. */
  const caseDiagram = brass ? caseSvg(brass.marks, { mini: true, cart: brass.cartridge }) : '';
  return `<div class="lbl ${band ? 'hasband' : ''}">
    ${band ? `<div class="band">${esc(band)}</div>` : ''}
    <div class="cart">${esc(r ? cartName(r.cartridge) : '')}</div>
    <div class="load">${esc(r ? r.bullet : '')}<br>${esc(r ? r.powder : '')}
      · <b>${b.chargeActual ?? (r ? r.charge : '')} gr</b>
      ${b.coalMean ? ` · COAL ${b.coalMean}"` : ''}<br>${esc(r ? r.primer : '')}</div>
    ${brass ? `<div class="marks"><span class="ms">${
      /* The letter code prints beside the drawing, and that is not redundancy:
       * a mono laser or a thermal printer renders every colour as a grey, and
       * a label whose entire content is colour becomes unreadable on exactly
       * the printers most likely to be in a reloading room. The code survives
       * black and white. */
      esc(codeOf(brass.marks))} · ${esc(brass.headstamp)} · ${
      /* brass.firings is the BASELINE -- firings before the lot was recorded --
       * not the lot's life. Printing it meant a lot bought new and fired four
       * times went in the ammo box labelled "0f". This is the one number on the
       * label a handloader uses to decide whether this is the last trip for
       * these cases, so it prints the same figure every screen shows. */
      brassLife(brass).mean.toFixed(1)}f</span></div>` : ''}
    <div class="btm"><div class="grow1">
      <div class="ser">${esc(b.serial)}</div>
      <div class="meta">${fmtDate(b.date)} · ${b.qty} rounds</div>
      ${/* The case sits here, beside the QR, because that is where the space
           already was: the QR is half an inch tall and the two lines next to it
           are not, so the drawing costs the label no height at all. Given its
           own row it overflowed a 1.5in label by exactly its own height -- and
           a label that does not fit is one that prints clipped. */
        caseDiagram}
    </div><div class="qr">${qr}</div></div>
  </div>`;
}

/* ------------------------------------------------------------------- More */
VIEWS.more = () => [
  ['inventory', 'Inventory', `${DB.componentLots.length} component lot${DB.componentLots.length === 1 ? '' : 's'}`],
  ['recipes', 'Recipes', `${DB.recipes.length} load specification${DB.recipes.length === 1 ? '' : 's'}`],
  ['firearms', 'Firearms', `${DB.firearms.length} recorded`],
  ['cartridges', 'Cartridges', `${DB.cartridges.length} recorded`],
  ['settings', 'Marking scheme', `${scheme().positions.length} positions · ${schemeCapacity()} codes`],
  ...(CORE ? [['sync', 'Cloud sync',
    CORE.isSignedIn() ? `signed in as ${CORE.getUser()?.email || 'you'}` : 'not signed in']] : []),
  ['data', 'Data', Store.persistent ? 'saved on this device' : 'not persisting — export to keep'],
  /* Reachable from the menu, not only from #/diag. A home-screen app has no
   * address bar, so the URL route was unreachable on exactly the device whose
   * numbers are worth having. */
  ['diag', 'Display diagnostics', typeof BUILD_ID === 'string'
    ? 'build ' + BUILD_ID : 'what this device reports about the screen'],
].map(([v, t, s]) => `<button class="listitem" data-act="nav" data-arg="${v}">
    <span class="grow"><span class="ttl">${t}</span><span class="sub">${esc(s)}</span></span>
    <span class="chev">›</span></button>`).join('');

VIEWS.inventory = () => {
  const group = (kind, label) => {
    const rows = lotsOf(kind);
    if (!rows.length) return '';
    return `<div class="card"><h2>${label}</h2>${rows.map(c => {
      // Derived, not stored. See lotUsed(): purchased minus what the batches took.
      const left = lotLeft(c);
      const used = (+c.qty || 0) - left;
      const pct = c.qty > 0 ? (left / c.qty) * 100 : 0;
      const col = pct <= 0 ? 'var(--bad)' : pct < 20 ? 'var(--bad)'
                : pct < 40 ? 'var(--warn)' : 'var(--brass)';
      const unit = c.unit === 'lb' ? ' lb' : '';
      const dp = c.unit === 'lb' ? 3 : 0;
      const uses = batchesUsing(c);
      // For powder, the number a reloader actually wants is rounds, not pounds.
      const perRecipe = c.kind !== 'powder' ? [] : DB.recipes
        .filter(r => +r.charge > 0)
        .map(r => `${roundsLeftFromPowder(c, r.charge)} × ${esc(r.name)}`)
        .slice(0, 3);
      return `<div class="rowline">
        <div class="spread"><b class="small">${esc(c.name)}</b>
          <span class="small mono" style="color:${col}">${left.toFixed(dp)}${unit} left</span></div>
        <div class="capbar"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${col}"></i></div>
        <div class="tiny dim mt4">${used > 0
            ? `${used.toFixed(dp)}${unit} used across ${uses.length} batch${uses.length === 1 ? '' : 'es'} · `
            : 'nothing loaded from this lot yet · '}${c.lot ? 'lot ' + esc(c.lot) + ' · ' : ''}${money2(c.cost)}
          for ${c.qty}${unit}${c.qty > 0 ? ' · ' + money(c.cost / c.qty) + '/' + c.unit : ''}</div>
        ${perRecipe.length ? `<div class="tiny dim mt4">enough for ${perRecipe.join(' · ')}</div>` : ''}
        ${left <= 0 ? '<div class="tiny mt4" style="color:var(--bad)">■ Out of stock — a batch using this lot cannot be saved</div>'
          : pct < 20 ? '<div class="tiny mt4" style="color:var(--warn)">▲ Running low</div>' : ''}
        ${uses.length ? `<div class="tiny dim mt4">${uses.slice(0, 4).map(b =>
            `<button class="linkish" data-act="ammoDetail" data-arg="${b.id}">${esc(b.serial)}</button>`
          ).join(' ')}${uses.length > 4 ? ` +${uses.length - 4}` : ''}</div>` : ''}
        <div class="mt6 row g8">
          <button class="btn sm" data-act="edit" data-kind="component" data-arg="${c.id}">Edit</button>
          <button class="btn sm danger" data-act="delComponent" data-arg="${c.id}">Delete</button></div>
      </div>`;
    }).join('')}</div>`;
  };
  const body = DB.componentLots.length
    ? group('bullet', 'Bullets') + group('powder', 'Powder') + group('primer', 'Primers')
    : empty('No component lots yet. Record the bullets, powder and primers you have so batches can cost themselves.');
  return body + `<button class="btn primary wide" data-act="new" data-arg="component">+ New component lot</button>`;
};

VIEWS.recipes = () => {
  const body = DB.recipes.length ? DB.recipes.map(r => {
    const over = recipeOverMax(r);
    return `<div class="listitem static">
      <span class="grow"><span class="ttl">${esc(r.name)}</span>
        <span class="sub">${esc(cartName(r.cartridge))} · ${r.charge} gr${r.coal ? ' · COAL ' + r.coal + '"' : ''}</span>
        <span class="sub">${esc(r.bullet)} · ${esc(r.powder)} · ${esc(r.primer)}</span>
        <span class="sub mt5">${over ? '<span class="chip bad">Over max</span> ' : ''}
          <span class="chip neutral">${esc(r.source)}</span></span>
        <span class="mt6" style="display:block">
          <button class="btn sm" data-act="workup" data-arg="${r.id}">Workup</button>
          <button class="btn sm" data-act="edit" data-kind="recipe" data-arg="${r.id}">Edit</button>
          <button class="btn sm danger" data-act="delRecipe" data-arg="${r.id}">Delete</button></span>
      </span></div>`;
  }).join('') : empty('No recipes yet. A recipe records the load and, crucially, where the data came from.');
  return body + `<button class="btn primary wide" data-act="new" data-arg="recipe">+ New recipe</button>
    <div class="banner info mt12"><div class="small">This app records load data.
      It never suggests, interpolates or extrapolates a charge, and ships with none.</div></div>`;
};

/* ==========================================================================
 * Workup — the thing a precision shooter actually does
 *
 * A charge ladder or a seating-depth test is one recipe fired at a range of
 * charges or CBTOs, and the whole output is the COMPARISON: velocity climbing
 * with charge, a flat spot where it does not, group size against seating
 * depth, and the rung where pressure signs start. Bench recorded every one of
 * those numbers and had nowhere to put them side by side, so the comparison
 * happened on a notepad and the app held the data that made the notepad
 * redundant.
 *
 * Rungs are batches on the same recipe. They already carry a measured charge
 * and a measured CBTO, so a ladder needs no new record type -- just an axis to
 * sort on and a table to read. The axis is chosen by whichever actually varies:
 * comparing ten batches by charge when they all threw 41.5 and differ by
 * seating depth would sort them into arrival order and tell you nothing.
 */
function workupRows(recipeId) {
  const r = byId(DB.recipes, recipeId);
  const rows = DB.batches.filter(b => b.recipe === recipeId).map(b => {
    const ses = sessionsFor(b.id);
    // Velocity across every session on this rung, weighted by rounds: two
    // 5-shot strings are one 10-shot sample, not two numbers to pick between.
    let n = 0, vsum = 0, sd = null, es = null, grp = null, gn = 0, gsum = 0;
    let signs = 'none';
    for (const s of ses) {
      const k = Math.max(0, +s.rounds || 0);
      if (s.vAvg != null && k) { vsum += (+s.vAvg) * k; n += k; }
      if (s.vSd != null && (sd == null || k > 0)) sd = +s.vSd;
      if (s.vEs != null) es = Math.max(es == null ? -Infinity : es, +s.vEs);
      if (s.group != null) { gsum += +s.group; gn++; }
      if (s.pressureSigns && s.pressureSigns !== 'none') signs = s.pressureSigns;
    }
    if (gn) grp = gsum / gn;
    return { b, charge: chargeOf(b), cbto: b.cbtoMean ?? (r ? r.cbto : null),
             vAvg: n ? vsum / n : null, n, sd, es: es === -Infinity ? null : es,
             group: grp, groups: gn, signs, fired: roundsFired(b),
             over: isOverMax(b) };
  });
  // Which axis varies? Fall back to charge, which is what a ladder usually is.
  const spread = (k) => {
    const vals = rows.map(x => x[k]).filter(v => v != null);
    return vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  };
  const byCbto = spread('charge') === 0 && spread('cbto') > 0;
  const axis = byCbto ? 'cbto' : 'charge';
  rows.sort((a, b) => (a[axis] ?? 0) - (b[axis] ?? 0));
  return { rows, axis, recipe: r };
}

VIEWS.workup = (id) => {
  const { rows, axis, recipe: r } = workupRows(id);
  if (!r) return `<div class="empty">That recipe no longer exists.</div>`;
  const label = axis === 'cbto' ? 'CBTO' : 'Charge';
  const unit = axis === 'cbto' ? '"' : ' gr';
  const shot = rows.filter(x => x.vAvg != null);

  // The flat spot: consecutive rungs where velocity barely moves. Reported as
  // an observation with its numbers, never as a recommendation -- this app
  // does not suggest charges, and a node found in three shots per rung is
  // mostly noise anyway.
  let flat = null;
  if (axis === 'charge' && shot.length >= 3) {
    let best = null;
    for (let i = 1; i < shot.length; i++) {
      const dC = shot[i].charge - shot[i - 1].charge;
      if (!(dC > 0)) continue;
      const rate = (shot[i].vAvg - shot[i - 1].vAvg) / dC;   // fps per grain
      if (best == null || rate < best.rate) best = { rate, a: shot[i - 1], b: shot[i] };
    }
    if (best && best.rate >= 0) flat = best;
  }

  const head = `<div class="card">
    <h2 class="m0">${esc(r.name)}</h2>
    <div class="small muted mt3">${esc(cartName(r.cartridge))} · ${esc(r.bullet)} · ${esc(r.powder)}</div>
    <div class="tiny dim mt6">${rows.length} rung${rows.length === 1 ? '' : 's'} on this recipe,
      ordered by ${esc(label.toLowerCase())}${r.sourceMax > 0
        ? ` · published max ${r.sourceMax} gr` : ' · no published maximum recorded'}.</div>
    <div class="btnrow mt10 noprint">
      <button class="btn primary" data-act="ladder" data-arg="${r.id}">Build a ladder</button>
    </div>
  </div>`;

  if (!rows.length) {
    return head + empty('Nothing loaded on this recipe yet. A ladder builds the rungs in one pass.');
  }

  const body = rows.map(x => `<button class="listitem" data-act="ammoDetail" data-arg="${x.b.id}">
    <span class="grow">
      <span class="ttl mono">${axis === 'cbto' ? (x.cbto ?? '—') : x.charge}${unit}${
        x.over ? ' <span class="chip bad">over max</span>' : ''}</span>
      <span class="sub mono">${x.vAvg != null
        ? `${Math.round(x.vAvg)} fps${x.sd != null ? ` · SD ${x.sd}` : ''}${
            x.es != null ? ` · ES ${x.es}` : ''}`
        : x.fired ? 'fired, no chronograph' : 'not fired yet'}</span>
      <span class="sub mono">${x.group != null ? `${x.group.toFixed(3)}" group${
        x.groups > 1 ? ` (mean of ${x.groups})` : ''}` : ''}${
        x.n ? ` <span class="dim">· ${x.n} over the screens</span>` : ''}</span>
      <span class="sub">${esc(x.b.serial)}${x.signs !== 'none'
        ? ` <span class="chip bad">${esc(x.signs)}</span>` : ''}</span>
    </span><span class="chev">›</span></button>`).join('');

  return head + `<div class="card"><h2>Rungs</h2>${body}
    ${flat ? `<div class="rowline"><div class="small"><b>Flattest step:</b>
      ${flat.a.charge} → ${flat.b.charge} gr moved ${Math.round(flat.b.vAvg - flat.a.vAvg)} fps
      (${flat.rate.toFixed(0)} fps/gr).</div>
      <div class="tiny dim mt4">An observation about these strings, not a recommendation.
      With few rounds per rung the difference between a node and sampling noise is
      not something this data can settle.</div></div>` : ''}
    ${shot.length < rows.length
      ? `<div class="tiny dim mt8">${rows.length - shot.length} rung${
          rows.length - shot.length === 1 ? ' has' : 's have'} no velocity recorded yet.</div>` : ''}
  </div>`;
};

VIEWS.firearms = () => {
  const body = DB.firearms.length ? DB.firearms.map(f => `<div class="card">
      <div class="spread"><h2 class="m0">${esc(f.name)}</h2>
        <span class="row g8">
          <button class="btn sm" data-act="edit" data-kind="firearm" data-arg="${f.id}">Edit</button>
          <button class="btn sm danger" data-act="delFirearm" data-arg="${f.id}">Delete</button></span></div>
      <dl class="kv mt8">
        <dt>Cartridge</dt><dd>${esc(cartName(f.cartridge))}</dd>
        ${f.barrel ? `<dt>Barrel</dt><dd>${f.barrel}"${f.twist ? ' · ' + esc(f.twist) : ''}</dd>` : ''}
        ${f.sightHeight ? `<dt>Sight height</dt><dd class="mono">${f.sightHeight}"</dd>` : ''}
        ${f.zeroRange ? `<dt>Zero</dt><dd class="mono">${f.zeroRange} yd</dd>` : ''}
      </dl></div>`).join('')
    : empty('No firearms yet. Needed to attribute range results, and to carry sight height and zero range.');
  return body + `<button class="btn primary wide" data-act="new" data-arg="firearm">+ New firearm</button>`;
};

/* Cartridges, and the case each one actually is.
 *
 * The shape only ever feeds the drawing, which is why this screen is a list of
 * two dropdowns rather than a form: there is nothing to validate and nothing
 * else it affects. It exists because the alternative was that the case shape
 * could only ever be set on a cartridge created AFTER this update -- and every
 * cartridge the user already has is the one they are actually loading. */
VIEWS.cartridges = () => {
  if (!DB.cartridges.length) {
    return empty('No cartridges yet. They are created as you record a firearm, a recipe or a brass lot.');
  }
  return DB.cartridges.map(c => `<div class="card">
    <div class="spread"><h2 class="m0">${esc(c.name)}</h2>
      <span class="tiny dim">${DB.brassLots.filter(l => l.cartridge === c.id).length} brass lot(s)</span></div>
    <div class="casewrap mt8">${caseSvg({}, { mini: true, cart: c })}</div>
    <div class="row g8 mt8">
      <label class="f grow"><span>Shape</span>
        <select data-act="cartShape" data-arg="${c.id}">
          ${Object.entries(CASE_SHAPES).map(([v, l]) =>
            `<option value="${v}" ${caseShape(c) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select></label>
      <label class="f grow"><span>Head</span>
        <select data-act="cartHead" data-arg="${c.id}">
          ${Object.entries(CASE_HEADS).map(([v, l]) =>
            `<option value="${v}" ${caseHead(c) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select></label>
    </div>
  </div>`).join('')
   + `<p class="small muted">These change the drawing you match brass against, and nothing else —
      no recipe, batch or count depends on them.</p>`;
};

VIEWS.settings = () => {
  const sc = scheme(), cap = schemeCapacity(), used = DB.brassLots.length;
  return `<div class="card">
    <div class="spread"><span class="small">${sc.positions.length} positions ×
      ${sc.palette.filter(c => c.on).length} colours${sc.allowBlank ? ' + blank' : ''}</span>
      <b class="mono">${cap} codes</b></div>
    <div class="capbar"><i style="width:${cap ? Math.min(100, used / cap * 100) : 0}%"></i></div>
    <div class="tiny dim mt6">${used} in use.</div>
  </div>
  <div class="card"><h2>Positions</h2>
    <p class="small muted">Where the paint goes on the case. The diagram and every lookup follow this list.</p>
    ${sc.positions.map((p, i) => `<div class="rowline">
      <div class="row g8">
        <input type="text" value="${esc(p.label)}" data-act="posLabel" data-idx="${i}" style="flex:2">
        <input type="text" value="${esc(p.hint)}" data-act="posHint" data-idx="${i}" style="flex:2">
        <button class="btn sm danger" data-act="posDel" data-idx="${i}" aria-label="Remove">×</button>
      </div>
      <div class="row g8 mt7">
        <select data-act="posKind" data-idx="${i}" style="flex:1">
          <option value="band"${isHeadPos(p) ? '' : ' selected'}>Band around the case</option>
          <option value="head"${isHeadPos(p) ? ' selected' : ''}>Case head (the flat base)</option>
        </select>
      </div>
      ${isHeadPos(p)
        ? `<div class="tiny dim mt7">Written on the base, around the primer. It has no
             position along the case, so there is nothing to slide.</div>`
        : `<div class="row g8 mt7">
             <span class="tiny dim">head</span>
             <input type="range" min="5" max="95" value="${Math.round((p.at ?? 0.5) * 100)}"
               data-act="posAt" data-idx="${i}" style="flex:1">
             <span class="tiny dim">neck</span>
           </div>`}
      </div>`).join('')}
    <div class="row g8 mt10">
      <button class="btn sm" data-act="posAdd" data-arg="band">+ Add band</button>
      <button class="btn sm" data-act="posAdd" data-arg="head">+ Add case head</button>
    </div>
  </div>
  <div class="card"><h2>Palette</h2>
    <p class="small muted">Only enabled colours are offered. Enable what you actually own.</p>
    <div class="swatches">${sc.palette.map((c, i) =>
      `<button class="sw ${c.on ? 'on' : ''}" style="background:${c.hex};${c.on ? '' : 'opacity:.32'}"
        data-act="palToggle" data-idx="${i}" title="${esc(c.name)}">${c.id}</button>`).join('')}</div>
    <hr>
    <label class="row g10 pointer">
      <input type="checkbox" ${sc.allowBlank ? 'checked' : ''} data-act="blankToggle" class="cb">
      <span class="small">Treat an unmarked position as a valid state
        <span class="dim tiny" style="display:block">More codes, but a worn mark can read as data.</span></span>
    </label>
  </div>
  <div class="card"><h2>QR target</h2>
    <label class="f"><span>Base URL encoded into every QR</span>
      <input type="text" value="${esc(DB.meta.baseUrl)}" data-act="baseUrl" placeholder="https://…"></label>
    <div class="small dim">Serials print under the QR, so changing this does not strand old labels.</div>
  </div>`;
};

/* ------------------------------------------------------------ cloud sync */

/* The sign-in form and the sync button, as one block that both the Identify
 * screen and the Cloud sync page render.
 *
 * They used to live only on the Cloud sync page, which is two taps deep under
 * More, and the result was the obvious one: a user who had never opened that
 * menu had no way to know an account existed, and no way to find the sync
 * button once they did. Zero puts exactly this on its home screen, so Bench
 * now does too -- same fields, same order, same wording, so signing in on one
 * app teaches you the other.
 *
 * Placement differs by state, deliberately. Signed OUT it goes above the
 * identify tool, because it is a setup step that has to be seen once. Signed
 * IN it goes below, because it is then a status readout and the tool is what
 * the screen is for. Both are the same markup; only the caller's position
 * changes.
 *
 * There is exactly one element with each of these ids at any moment: only one
 * view renders at a time, so the Identify copy and the Cloud sync copy are
 * never in the document together. */
function syncCard(opts) {
  if (!CORE) return '';
  const o = opts || {};
  const st = UI.sync || {};

  if (!CORE.isSignedIn()) {
    return `<div class="card">
      <h2>Sync with Zero</h2>
      <p class="small muted">One account for Bench and Zero. Your batches become
        selectable loads in Zero, and the groups they shoot come back here.</p>
      <label class="f"><span>Email</span>
        <input type="email" id="sy-email" autocapitalize="none" autocomplete="username"
          inputmode="email" spellcheck="false" placeholder="you@example.com"></label>
      <label class="f"><span>Password</span>
        <input type="password" id="sy-pw" autocomplete="current-password"></label>
      <div class="row g8 mt10">
        <button class="btn primary" data-act="syIn" style="flex:1" ${st.busy ? 'disabled' : ''}>
          ${st.busy ? 'Signing in…' : 'Sign in'}</button>
        <button class="btn" data-act="syUp" style="flex:1" ${st.busy ? 'disabled' : ''}>Create account</button>
      </div>
      ${st.err ? `<div class="banner bad mt10"><div class="small">${esc(st.err)}</div></div>` : ''}
      <p class="tiny dim mt10">Offline writes queue and go on the next sync, so a
        bench with no signal is not a bench that loses work.</p>
    </div>`;
  }

  const pending = CORE.pendingCount();
  return `<div class="card">
    <div class="spread"><b class="small">${esc(CORE.getUser()?.email || 'signed in')}</b>
      ${o.compact ? `<button class="btn sm" data-act="nav" data-arg="sync">Details</button>`
                  : `<button class="btn sm" data-act="syOut">Sign out</button>`}</div>
    <div class="tiny dim mt6">${pending ? `${pending} record${pending === 1 ? '' : 's'} waiting to send`
      : 'everything sent'}${st.at ? ` · last sync ${st.at}` : ''}</div>
    <button class="btn primary wide mt10" data-act="sySync" ${st.busy ? 'disabled' : ''}>
      ${st.busy ? 'Syncing…' : '⇅ Sync now'}</button>
    ${st.msg ? `<div class="banner ${st.ok ? 'ok' : 'bad'} mt10"><div class="small">${esc(st.msg)}</div></div>` : ''}
  </div>`;
}

VIEWS.sync = () => {
  if (!CORE) return empty('No backend is configured in this build, so Bench stores everything on this device.');
  const st = UI.sync || {};
  const signedIn = CORE.isSignedIn();

  if (!signedIn) return syncCard();

  const rejected = CORE.rejectedList ? CORE.rejectedList() : [];
  const blocked = st.blocked || [];
  return `${syncCard()}

  ${blocked.length ? `<div class="card"><h2>Not sent</h2>
    <p class="small muted">These could not be represented in the shared schema. Everything
      else went; one record never strands the rest.</p>
    ${blocked.map(b => `<div class="rowline">
      <div class="small">${esc(b.what)}</div>
      <div class="tiny" style="color:var(--warn)">${esc(b.why)}</div></div>`).join('')}
  </div>` : ''}

  ${rejected.length ? `<div class="card"><h2>Refused by the server</h2>
    <p class="small muted">Dropped from the queue so it keeps moving. These will not retry.</p>
    ${rejected.slice(0, 8).map(r => `<div class="rowline"><div class="tiny mono">${esc(r.table)}</div>
      <div class="tiny dim">${esc(String(r.error || '').slice(0, 160))}</div></div>`).join('')}
    <button class="btn sm mt10" data-act="syClearRej">Clear</button>
  </div>` : ''}

  <div class="card"><h2>What goes up</h2>
    <div class="tiny dim" style="line-height:1.6">
      Firearms, component lots, brass lots, recipes, batches and range sessions —
      mapped onto the schema Zero reads. A component lot becomes two rows there,
      a product and a purchase, because a recipe references the product while it
      is the purchase that runs out.<br><br>
      Your marking scheme travels too, so a colour code means the same thing on
      every device you sign in on.
    </div>
  </div>`;
};

VIEWS.data = () => {
  const counts = [['Cartridges', DB.cartridges.length], ['Firearms', DB.firearms.length],
    ['Component lots', DB.componentLots.length], ['Brass lots', DB.brassLots.length],
    ['Recipes', DB.recipes.length], ['Batches', DB.batches.length], ['Sessions', DB.sessions.length]];
  return `<div class="banner ${Store.persistent ? 'info' : 'bad'}"><div class="small">
      ${Store.persistent
        ? 'Data is saved on this device. Clearing site data erases it — export regularly.'
        : '<b>Not persisting.</b> This browser is blocking local storage, so everything is in memory and will vanish on reload. Export before closing.'}
    </div></div>
    <div class="card"><h2>Backup</h2>
      <div class="btnrow">
        <button class="btn primary" data-act="export">Export JSON</button>
        <button class="btn" data-act="importBtn">Import JSON</button>
        <input type="file" id="importFile" accept="application/json,.json" class="hidden">
      </div>
    </div>
    <div class="card"><h2>Contents</h2><dl class="kv">${counts.map(([k, v]) =>
      `<dt>${k}</dt><dd class="mono">${v}</dd>`).join('')}</dl></div>
    <div class="card"><h2>Reset</h2>
      <p class="small muted">Erases everything on this device. Export first.</p>
      <button class="btn danger" data-act="wipe">Erase all data</button>
    </div>`;
};

/* ==========================================================================
 * #/diag — what the browser actually thinks the viewport is.
 *
 * The tab bar sat at the bottom on one screen and short of it on another, with
 * identical CSS. Chromium cannot reproduce it: a headless viewport has no
 * display cutout, no home indicator, and no dynamic toolbar, so `bottom:0` is
 * always the physical bottom there and every measurement I could take said the
 * layout was correct.
 *
 * Rather than guess a fourth time, this prints the numbers from the device that
 * actually disagrees. Reached only by URL, so it costs nothing in the UI.
 * ========================================================================*/
/* Where a scanned QR lands when this browser has never seen the record.
 *
 * The cause is almost never a missing batch. A camera opens a scanned URL in
 * the browser, and on iOS an installed home-screen app keeps its own storage
 * container -- so the browser has no brass, no batches, no session, and the
 * app it opens looks empty. Explaining that is the whole job of this screen,
 * plus handing over the one thing that makes the next step quick: the serial,
 * in a form you can paste into the app that does have the data. */
VIEWS.scanned = (serial) => {
  const s = serial || UI.scanned || '';
  const local = DB.batches.length + DB.brassLots.length;
  return `<div class="card">
    <h2>Scanned ${esc(s)}</h2>
    <p class="small muted">This browser has no record of it${local ? '' : ', and no records at all'}.
      That is expected when you scan with a phone camera: the camera opens the
      <b>browser</b>, and the Bench you keep on your home screen stores its data
      separately. Same app, different box of records.</p>
    <div class="serialbig mono">${esc(s)}</div>
    <div class="row g8 mt10">
      <button class="btn primary grow" data-act="copySerial" data-arg="${esc(s)}">Copy serial</button>
      <button class="btn grow" data-act="tab" data-arg="lookup">Look it up here</button>
    </div>
    <p class="tiny dim mt10">Open Bench from your home screen and paste it into
      <b>Identify &rsaquo; By serial</b>. If you have not installed Bench yet, this
      page is it — use Share &rsaquo; Add to Home Screen, sign in, and the records
      follow your account.</p>
  </div>
  ${CORE && !CORE.isSignedIn() ? `<div class="card"><h2>Or sign in here</h2>
    <p class="small muted">Signing in on this browser pulls your firearms and, in
      time, the rest. It is a second copy of the same account, not a second
      account.</p>${syncCard()}</div>` : ''}`;
};

VIEWS.diag = () => {
  /* The first version of this read the nav's rect DURING render, before the
   * tab buttons had been rebuilt -- so it measured a 1px-tall bar and reported
   * `nav top 712` against an innerHeight of 713. A diagnostic that lies is
   * worse than no diagnostic, so the bar's numbers are filled in after paint,
   * from the DOM, once layout has settled. */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const n = document.querySelector('nav.tabs');
    const box = document.getElementById('diag-nav');
    if (!n || !box) return;
    const b = n.getBoundingClientRect();
    const line = (k, v) => `<div class="spread small rowline"><span class="dim">${esc(k)}</span>
      <span class="mono">${esc(String(v))}</span></div>`;
    const gap = Math.round(window.innerHeight - b.bottom);
    box.innerHTML =
      line('nav top', Math.round(b.top) + 'px') +
      line('nav bottom', Math.round(b.bottom) + 'px') +
      line('nav height', Math.round(b.height) + 'px') +
      line('GAP BELOW NAV', gap + 'px') +
      line('nav padding-bottom', getComputedStyle(n).paddingBottom) +
      `<div class="tiny mt6" style="color:${gap === 0 ? 'var(--ok)' : 'var(--bad)'}">${
        gap === 0 ? 'The bar reaches the bottom of the viewport. Anything visible below it belongs to the browser, not to this page.'
                  : 'The bar stops ' + gap + 'px short of the viewport bottom — that IS the bug.'}</div>`;
  }));

  const cs = getComputedStyle(document.documentElement);
  const nav = document.querySelector('nav.tabs');
  const r = nav ? nav.getBoundingClientRect() : null;
  const vv = window.visualViewport;
  const row = (k, v) => `<div class="spread small rowline"><span class="dim">${esc(k)}</span>
    <span class="mono">${esc(String(v))}</span></div>`;
  const px = (n) => (n == null ? '—' : Math.round(n) + 'px');

  return `<div class="card"><h2>Viewport</h2>
    ${row('window.innerHeight', px(window.innerHeight))}
    ${row('documentElement.clientHeight', px(document.documentElement.clientHeight))}
    ${row('visualViewport.height', px(vv && vv.height))}
    ${row('visualViewport.offsetTop', px(vv && vv.offsetTop))}
    ${row('screen.height', px(window.screen && window.screen.height))}
    ${row('devicePixelRatio', window.devicePixelRatio)}
  </div>
  <div class="card"><h2>Safe areas, as resolved</h2>
    ${row('--safe-t', cs.getPropertyValue('--safe-t').trim() || '(unset)')}
    ${row('--safe-b', cs.getPropertyValue('--safe-b').trim() || '(unset)')}
    ${row('--safe-l', cs.getPropertyValue('--safe-l').trim() || '(unset)')}
    ${row('--safe-r', cs.getPropertyValue('--safe-r').trim() || '(unset)')}
  </div>
  <div class="card"><h2>The tab bar</h2>
    <div id="diag-nav"><div class="small dim">measuring…</div></div>
  </div>
  <div class="card"><h2>Browser chrome</h2>
    ${row('screen minus viewport', px((window.screen ? window.screen.height : 0) - window.innerHeight))}
    <div class="tiny dim mt6">Anything here above 0 is space the BROWSER has taken —
      an address bar, a toolbar. No CSS in this page can paint it. In a home-screen
      app it should be 0 and the safe-area values above should be non-zero.</div>
  </div>
  <div class="card"><h2>Page</h2>
    ${row('body scrollHeight', px(document.body.scrollHeight))}
    ${row('scrollable', document.body.scrollHeight > window.innerHeight ? 'yes' : 'no')}
    ${row('display-mode standalone', String(matchMedia('(display-mode: standalone)').matches))}
    ${row('navigator.standalone', String(navigator.standalone))}
    <div class="tiny dim mt6">Take this on a screen that looks WRONG and one that
      looks RIGHT. The value that differs is the cause.</div>
  </div>`;
};

VIEWS.form = (arg) => {
  const kind = arg.kind;
  const spec = FORMS[kind];
  const rec = arg.id ? byId(HOMES[kind].list(), arg.id) : null;
  if (arg.id && !rec) return `<div class="empty">That record no longer exists.</div>`;
  const blockers = spec.fields.filter(f => f.hard && !f.ref().length);
  if (blockers.length && !rec) {
    return `<div class="banner warn"><div><b>${esc(blockers[0].l)} required.</b>
      <span class="small">Add one before creating a ${esc(spec.title.toLowerCase())}.</span></div></div>`;
  }
  // Editing a batch shows what it would draw with itself excluded, so its own
  // components read as available rather than as already spent.
  const head = rec ? `<div class="card"><div class="small muted m0">Editing
    <b class="mono">${esc(rec.serial || spec.title)}</b>. The serial does not change —
    it is printed on labels that are already in boxes.</div></div>` : '';
  return head + `<div id="formErr"></div>`
    + formHtml(kind, { kindSel: rec ? rec.kind : UI.formKind, rec });
};

/* ==========================================================================
 * Controller
 * ========================================================================*/
function findBySerial(raw) {
  const n = Serial.normalise(raw);
  const hit = (arr) => arr.find(x => Serial.normalise(x.serial || '') === n);
  const b = hit(DB.batches); if (b) return ['ammoDetail', b.id];
  const l = hit(DB.brassLots); if (l) return ['brassDetail', l.id];
  return null;
}

function doSerialLookup() {
  const input = document.getElementById('serialIn');
  const msg = document.getElementById('serialMsg');
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  input.classList.remove('good', 'bad');

  if (!Serial.isValid(raw)) {
    input.classList.add('bad');
    msg.innerHTML = `<span class="err"><b>Check character doesn't match.</b>
      That serial has a typo — nothing was looked up.</span>`;
    return;
  }
  const found = findBySerial(raw);
  if (!found) {
    input.classList.add('bad');
    msg.innerHTML = `<span class="warnt">Well-formed, but nothing carries that serial.</span>`;
    return;
  }
  input.classList.add('good');
  msg.innerHTML = '';
  go(found[0], found[1]);
}

/* Sign in / create account. Kept out of ACTIONS so the async flow reads in one
 * place rather than inside an object literal. */
async function doAuth(mode) {
  const email = (document.getElementById('sy-email') || {}).value || '';
  const pw = (document.getElementById('sy-pw') || {}).value || '';
  /* Rendered before the await, not just set: without it the buttons stay live
   * during the request and a second tap fires a second sign-in. */
  UI.sync = { busy: true };
  render();
  const r = mode === 'up' ? await CORE.signUp(email.trim(), pw)
                          : await CORE.signIn(email.trim(), pw);
  UI.sync = r.ok
    ? (r.needsConfirmation ? { err: 'Account created — confirm the email, then sign in.' } : {})
    : { err: r.error?.msg || r.error?.error_description || r.error?.message || 'Sign-in failed.' };
  render();
  /* Sync immediately on a successful sign-in. Signing in is the user saying
   * "connect this to my account"; making them then find and press a second
   * button before anything moves is the gap that made the feature feel absent.
   * A confirmation-pending signup has no session yet, so it is skipped. */
  if (r.ok && !r.needsConfirmation) await doSync();
}

/* Map the whole bench onto the shared schema, queue it, and push.
 *
 * Remote ids are assigned onto the local records and SAVED FIRST. If the
 * network step ran before the save, a retry would mint fresh ids and duplicate
 * every row on the server — the same trap Zero's sync had to avoid. */
async function doSync() {
  if (!CORE || !CORE.isSignedIn()) return;
  UI.sync = { ...(UI.sync || {}), busy: true, msg: null };
  render();
  try {
    const { queued, blocked } = BenchSync.push(CORE, DB, lotLeft, roundsLeft);
    save();                                   // ids first, network second

    /* Pulled rows are applied through this handler. Passing one is also what
     * tells zero-core the rows were consumed -- without it the cursor stays
     * put, deliberately, so nothing is skipped for whoever wires a handler up
     * later. Everything the handler changes is saved once at the end rather
     * than per row: one write, and nothing half-applied if a later table
     * throws. */
    const pulled = { added: 0, updated: 0, removed: 0 };
    const r = await CORE.sync({
      trigger: 'manual',
      apply: (table, rows) => {
        const s = BenchSync.applyPulled(DB, table, rows, { ensureCartridge, uid });
        if (s) { pulled.added += s.added; pulled.updated += s.updated; pulled.removed += s.removed; }
      },
    });
    if (pulled.added || pulled.updated || pulled.removed) save();

    const fromOther = [
      pulled.added ? `${pulled.added} new` : '',
      pulled.updated ? `${pulled.updated} updated` : '',
      pulled.removed ? `${pulled.removed} removed` : '',
    ].filter(Boolean).join(', ');

    UI.sync = {
      busy: false, blocked,
      ok: r.ok,
      at: new Date().toLocaleTimeString(),
      msg: r.ok
        ? `Sent ${queued} record${queued === 1 ? '' : 's'}, pulled ${r.stats.pulled}.`
          + (fromOther ? ` Firearms from Zero: ${fromOther}.` : '')
          + (blocked.length ? ` ${blocked.length} could not be represented — see below.` : '')
        : 'Sync failed: ' + r.reason,
    };
  } catch (e) {
    UI.sync = { busy: false, ok: false, msg: 'Sync failed: ' + (e?.message || e) };
  }
  render();
}

/* ==========================================================================
 * Saving, and the thing that was missing: saving again.
 *
 * Every form used to run one code path that only ever pushed a new record.
 * Combined with guardedDelete below -- which quite correctly refuses to delete
 * anything a batch points at -- that made a typo permanent. Record a brass lot
 * as 100 cases when you counted 200, load one batch from it, and the lot was
 * uneditable AND undeletable for as long as you owned it.
 *
 * So each kind declares FIELDS: the map from a submitted form to the record's
 * own columns, and nothing else. Creating is that map plus the things only
 * creation decides (an id, a serial, an empty cull list, the acquisition date).
 * Editing is that same map applied over the record that already exists. There
 * is one description of what a brass lot's fields are, so the two cannot drift.
 *
 * What editing deliberately does NOT touch: serials, because a serial is
 * printed on a label in a box somewhere and changing it strands that label;
 * ids; culls and adjustments, which are their own dated records; and anything
 * derived, which by definition has no stored value to change.
 * ========================================================================*/
const FIELDS = {
  firearm: (d) => ({ name: d.name, cartridge: d.cartridge, barrel: d.barrel,
    twist: d.twist, sightHeight: d.sightHeight, zeroRange: d.zeroRange, notes: d.notes }),
  component: (d) => ({ kind: d.kind, name: d.name, lot: d.lot, qty: d.qty,
    unit: d.unit || 'ea', cost: d.cost || 0, vendor: d.vendor,
    weightGr: d.weightGr, bcG1: d.bcG1, bcG7: d.bcG7 }),
  recipe: (d) => ({ name: d.name, cartridge: d.cartridge, bullet: d.bullet,
    powder: d.powder, primer: d.primer, charge: d.charge, coal: d.coal,
    cbto: d.cbto, source: d.source, page: d.page, sourceMax: d.sourceMax, notes: d.notes }),
  brass: (d) => ({ marks: d.marks, cartridge: d.cartridge, headstamp: d.headstamp,
    maker: d.maker, initialQty: d.initialQty, firings: d.firings || 0,
    expectedFirings: d.expectedFirings || 6, annealEvery: d.annealEvery,
    cost: d.cost || 0, origin: d.origin, notes: d.notes,
    trimTo: d.trimTo, maxLength: d.maxLength, weightSort: d.weightSort }),
  batch: (d) => ({ recipe: d.recipe, brassLot: d.brassLot, bulletLot: d.bulletLot,
    powderLot: d.powderLot, primerLot: d.primerLot, date: d.date || today(),
    qty: d.qty, chargeActual: d.chargeActual, chargeSd: d.chargeSd,
    coalMean: d.coalMean, cbtoMean: d.cbtoMean, runout: d.runout,
    bump: d.bump, bushing: d.bushing, primerDepth: d.primerDepth,
    press: d.press, storage: d.storage, notes: d.notes }),
  session: (d) => ({ batch: d.batch, firearm: d.firearm, date: d.date || today(),
    rounds: d.rounds, distance: d.distance, vAvg: d.vAvg, vSd: d.vSd, vEs: d.vEs,
    group: d.group, temp: d.temp, pressureSigns: d.pressureSigns || 'none', notes: d.notes }),
};

/** The collection and detail screen for each kind, so edit can return to where
 *  the record actually lives rather than to a list. */
const HOMES = {
  firearm: { list: () => DB.firearms, nav: 'firearms' },
  component: { list: () => DB.componentLots, nav: 'inventory' },
  recipe: { list: () => DB.recipes, nav: 'recipes' },
  brass: { list: () => DB.brassLots, detail: 'brassDetail' },
  batch: { list: () => DB.batches, detail: 'ammoDetail' },
  session: { list: () => DB.sessions, detail: null },
};

/** Apply an edit. Shared by every kind: find it, overlay the field map, done. */
function applyEdit(kind, id, d) {
  const rec = byId(HOMES[kind].list(), id);
  if (!rec) return ['err', null, 'That record no longer exists.'];
  Object.assign(rec, FIELDS[kind](d));
  /* Firearms are the one collection that syncs BOTH ways, so an edit here has
   * to be distinguishable from a record that merely exists. Without a local
   * modification time Bench re-pushed every firearm on every sync, and since
   * push runs before pull that overwrote edits made in Zero with Bench's stale
   * copy -- then read the stale value back and called it agreement. */
  if (kind === 'firearm') rec.mtime = Date.now();
  if (kind === 'brass') rec.qty = brassOnHand(rec);   // kept in step for exports
  const home = HOMES[kind];
  const msg = 'Changes saved.';
  if (kind === 'session') return ['goDetail', ['ammoDetail', rec.batch], msg];
  return home.detail ? ['goDetail', [home.detail, rec.id], msg] : ['nav', home.nav, msg];
}

/* Creation: exactly one save path per kind. */
const SAVERS = {
  firearm: (d) => {
    DB.firearms.push(Object.assign({ id: uid('f'), mtime: Date.now() }, FIELDS.firearm(d)));
    return ['nav', 'firearms', 'Firearm saved.'];
  },
  component: (d) => {
    DB.componentLots.push(Object.assign(
      { id: uid('cl'), serial: Serial.shortCode('C', takenSerials()) }, FIELDS.component(d)));
    return ['nav', 'inventory', 'Component lot saved.'];
  },
  recipe: (d) => {
    DB.recipes.push(Object.assign({ id: uid('r') }, FIELDS.recipe(d)));
    return ['nav', 'recipes', 'Recipe saved.'];
  },
  brass: (d) => {
    const serial = Serial.shortCode('R', takenSerials());
    if (!serial) return ['err', null, 'Serial space exhausted.'];
    const rec = Object.assign({ id: uid('bl'), serial, qty: d.initialQty, culls: [],
      acquired: today(), anneals: [], retired: false }, FIELDS.brass(d));
    DB.brassLots.push(rec);
    return ['goDetail', ['brassDetail', rec.id], `Brass lot ${serial} created.`];
  },
  batch: (d) => {
    const serial = Serial.batchSerial(d.date || today(), takenSerials());
    if (!serial) return ['err', null, 'No serial left for that date — 99 batches already.'];
    const rec = Object.assign({ id: uid('ba'), serial, adjust: [], quarantine: false },
      FIELDS.batch(d));
    DB.batches.push(rec);
    return ['goDetail', ['ammoDetail', rec.id], `Batch ${serial} created.`];
  },
  /* Removing cases changes the COUNT and nothing else. The survivors have
   * been fired exactly as many times as they had been a moment ago, so the
   * firing average is deliberately untouched -- see brassLife, which measures
   * each firing against the population in circulation at the time. */
  cull: (d) => {
    const l = byId(DB.brassLots, d.lot);
    if (!l) return ['err', null, 'That brass lot no longer exists.'];
    (l.culls = l.culls || []).push({ id: uid('cu'), n: d.n,
      reason: CULL_REASONS[d.reason] ? d.reason : 'none',
      date: d.date || today(), note: d.note || '' });
    l.qty = brassOnHand(l);          // kept in step for exports and old records
    return ['goDetail', ['brassDetail', l.id],
      `${d.n} case${d.n === 1 ? '' : 's'} removed — ${brassOnHand(l)} left.`];
  },

  /* No decrement here any more. The rounds left in a box are derived from the
   * sessions fired out of it, so logging one IS the decrement -- and deleting a
   * mistyped one puts the rounds back, and un-ages the brass, for free. */
  session: (d) => {
    DB.sessions.push(Object.assign({ id: uid('se') }, FIELDS.session(d)));
    return ['goDetail', ['ammoDetail', d.batch], 'Session saved — batch is no longer untested.'];
  },

  /* Builds every rung in one pass. Each is a real batch with its own serial
   * and its own label, because that is what ends up in the ammo box -- the
   * ladder is a way of creating them, not a new kind of record.
   *
   * Rungs that would exceed the published maximum are created anyway and
   * flagged, rather than silently dropped: a ladder deliberately walks toward
   * max, and quietly building seven of the eight rungs somebody asked for is
   * worse than building eight and saying which ones are over. */
  ladder: (d) => {
    const rid = (cur().arg || {}).recipe;
    const r = byId(DB.recipes, rid);
    if (!r) return ['err', null, 'That recipe no longer exists.'];
    const steps = Math.round(+d.steps || 0);
    const per = Math.round(+d.perStep || 0);
    const made = [];
    const taken = takenSerials();
    for (let i = 0; i < steps; i++) {
      const at = round3((+d.start || 0) + i * (+d.step || 0));
      const serial = Serial.batchSerial(d.date || today(), taken);
      if (!serial) return ['err', null,
        `Only ${made.length} serial${made.length === 1 ? '' : 's'} left for that date — `
        + 'the ladder was not built. Spread it over two days, or pick another date.'];
      taken.add(serial);
      const rec = Object.assign({ id: uid('ba'), serial, adjust: [], quarantine: false },
        FIELDS.batch({
          recipe: rid, brassLot: d.brassLot, bulletLot: d.bulletLot,
          powderLot: d.powderLot, primerLot: d.primerLot, date: d.date,
          qty: per, storage: d.storage,
          chargeActual: d.axis === 'cbto' ? null : at,
          cbtoMean: d.axis === 'cbto' ? at : null,
          notes: `Rung ${i + 1} of ${steps} — ${d.axis === 'cbto' ? 'seating' : 'charge'} ladder.`,
        }));
      made.push(rec);
    }
    DB.batches.push(...made);
    const over = made.filter(isOverMax).length;
    return ['goDetail', ['workup', rid],
      `${made.length} rungs built, ${made.length * per} rounds.`
      + (over ? ` ${over} ${over === 1 ? 'is' : 'are'} over the published maximum.` : '')];
  },

  anneal: (d) => {
    const l = byId(DB.brassLots, (cur().arg || {}).lot);
    if (!l) return ['err', null, 'That brass lot no longer exists.'];
    (l.anneals = l.anneals || []).push({ id: uid('an'),
      date: d.date || today(), note: d.note || '', at: brassLife(l).mean });
    l.anneals.sort((a, b) => (a.date < b.date ? -1 : 1));
    l.lastAnneal = l.anneals[l.anneals.length - 1].date;
    return ['goDetail', ['brassDetail', l.id], 'Anneal logged.'];
  },

  /* Rounds that left the box without being fired. Recorded as a dated line
   * rather than by editing a counter, so "where did the other twelve go" has
   * an answer, and so brass wear -- which counts firings only -- is unaffected. */
  adjust: (d) => {
    const b = byId(DB.batches, (cur().arg || {}).batch);
    if (!b) return ['err', null, 'That batch no longer exists.'];
    (b.adjust = b.adjust || []).push({ id: uid('aj'), n: d.n,
      reason: ROUND_REASONS[d.reason] ? d.reason : 'none',
      date: d.date || today(), note: d.note || '' });
    return ['goDetail', ['ammoDetail', b.id],
      `${d.n} round${d.n === 1 ? '' : 's'} accounted for — ${roundsLeft(b)} left.`];
  },
};

/** Deleting a record that others point at would leave dangling references, so
 *  each delete states what is blocking it rather than silently cascading. */
function guardedDelete(kind, id) {
  const uses = {
    brass: () => DB.batches.filter(b => b.brassLot === id).length,
    recipe: () => DB.batches.filter(b => b.recipe === id).length,
    component: () => DB.batches.filter(b =>
      b.bulletLot === id || b.powderLot === id || b.primerLot === id).length,
    firearm: () => DB.sessions.filter(s => s.firearm === id).length,
  }[kind]();
  if (uses) { toast(`Still used by ${uses} batch${uses === 1 ? '' : 'es'} — not deleted.`); render(); return; }
  const arr = { brass: 'brassLots', recipe: 'recipes', component: 'componentLots', firearm: 'firearms' }[kind];
  /* Firearms are the one collection that comes BACK from the server, so a
   * local delete has to be published as a tombstone. Without it the row is
   * still there on the next pull, nothing local matches its id any more, and
   * the apply handler faithfully recreates the firearm the user just deleted.
   * The other collections are push-only, so there is nothing to resurrect
   * them; when one of them gains an inverse, it gains a tombstone here too. */
  if (kind === 'firearm' && CORE) {
    const rec = byId(DB.firearms, id);
    if (rec && rec.remote) { try { CORE.remove('firearms', rec.remote); } catch (e) {} }
  }
  DB[arr] = DB[arr].filter(x => x.id !== id);
  save();
  toast('Deleted.');
  back();
}

const ACTIONS = {
  tab: (a) => reset(a),
  nav: (a) => go(a),
  brassDetail: (a) => go('brassDetail', a),
  ammoDetail: (a) => go('ammoDetail', a),
  label: (a) => go('label', a),

  new: (a) => { UI.marks = {}; UI.formKind = a === 'component' ? 'bullet' : null;
                UI.cartNew = {}; go('form', { kind: a }); },
  newSessionFor: (a) => { UI.cartNew = {}; go('form', { kind: 'session', batch: a }); },

  /* Editing. `marks` lives in UI state rather than on the form, so the colour
   * pickers have to be seeded from the record or an edit would silently clear
   * the code the lot is identified by. */
  edit: (a, el) => {
    const kind = el.dataset.kind;
    const rec = byId(HOMES[kind].list(), a);
    if (!rec) { toast('That record no longer exists.'); return; }
    UI.marks = kind === 'brass' ? Object.assign({}, rec.marks) : {};
    UI.formKind = kind === 'component' ? rec.kind : null;
    UI.cartNew = {};
    go('form', { kind, id: a, batch: rec.batch });
  },
  editBatch: (a) => ACTIONS.edit(a, { dataset: { kind: 'batch' } }),
  editSession: (a) => ACTIONS.edit(a, { dataset: { kind: 'session' } }),

  adjustRounds: (a) => { UI.cartNew = {}; go('form', { kind: 'adjust', batch: a }); },
  workup: (a) => go('workup', a),
  ladder: (a) => { UI.cartNew = {}; go('form', { kind: 'ladder', recipe: a }); },
  unadjust: (a) => {
    const [bid, aid] = String(a).split(':');
    const b = byId(DB.batches, bid);
    if (!b) return;
    b.adjust = (b.adjust || []).filter(x => x.id !== aid);
    save(); toast('Put back.'); render();
  },
  delSession: (a) => {
    const s2 = byId(DB.sessions, a);
    if (!s2) return;
    // No counter to restore. The rounds and the brass wear both come back
    // because both were derived from this record in the first place.
    DB.sessions = DB.sessions.filter(x => x.id !== a);
    save(); toast('Session deleted — rounds and brass wear returned.'); render();
  },

  /* The app already knows the largest loadable count; making the user retype
   * it is busywork. Tapping the figure fills the field. */
  fillmax: (a) => {
    const el = document.querySelector('#frm [name="qty"]');
    if (!el) return;
    el.value = String(Math.max(0, +a || 0));
    el.focus();
    paintDrawPreview();
  },

  syIn:  () => doAuth('in'),
  syUp:  () => doAuth('up'),
  syOut: () => { CORE.signOut(); UI.sync = {}; render(); },
  syClearRej: () => { CORE.clearRejected && CORE.clearRejected(); render(); },
  sySync: () => doSync(),

  serialgo: () => doSerialLookup(),

  /* Clipboard, with a fallback: navigator.clipboard is unavailable on an
   * insecure origin and can be refused outright, and the whole point of the
   * screen this sits on is to hand the serial over. */
  copySerial: async (a) => {
    const text = String(a || '');
    let done = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        done = true;
      }
    } catch (e) { done = false; }
    if (!done) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        done = document.execCommand && document.execCommand('copy');
        ta.remove();
      } catch (e) { done = false; }
    }
    toast(done ? `Copied ${text}` : `Select and copy: ${text}`);
    render();
  },
  clearpick: () => { UI.lookup = {}; render(); },
  pick: (a, el) => { const v = el.dataset.val;
    UI.lookup[el.dataset.pos] = v === '?' ? '?' : (v === '' ? null : v); render(); },
  markpick: (a, el) => { const v = el.dataset.val;
    UI.marks[el.dataset.pos] = v === '' ? null : v; render(); },

  printOne: () => window.print(),
  printSheet: (a) => {
    const b = byId(DB.batches, a);
    const sheet = document.getElementById('sheet');
    const single = document.getElementById('single');
    if (!b || !sheet || !single) return;
    sheet.innerHTML = Array.from({ length: 8 }, () => labelHtml(b)).join('');
    sheet.classList.remove('hidden');
    single.classList.add('noprint');
    const restore = () => {
      sheet.classList.add('hidden'); single.classList.remove('noprint');
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    setTimeout(() => { window.print(); setTimeout(restore, 500); }, 50);
  },

  toggleQ: (a) => { const b = byId(DB.batches, a); b.quarantine = !b.quarantine;
    save(); toast(b.quarantine ? 'Quarantined.' : 'Released.'); render(); },
  /* Firings from batches are derived. This button is for wear this app did
   * not see -- factory ammo through the same cases, or a lot recorded partway
   * through its life -- so it adjusts the BASELINE, and says so. */
  logfire: (a) => { const l = byId(DB.brassLots, a); l.firings = (+l.firings || 0) + 1;
    save(); toast(`Baseline +1 — ${l.serial} now at ${brassLife(l).mean.toFixed(2)} firings.`);
    render(); },
  cull: (a) => { UI.cartNew = {}; go('form', { kind: 'cull', lot: a }); },
  loganneal: (a) => { UI.cartNew = {}; go('form', { kind: 'anneal', lot: a }); },
  unanneal: (a) => {
    const [lid, aid] = String(a).split(':');
    const l = byId(DB.brassLots, lid);
    if (!l) return;
    l.anneals = (l.anneals || []).filter(x => x.id !== aid);
    l.lastAnneal = l.anneals.length ? l.anneals[l.anneals.length - 1].date : null;
    save(); toast('Anneal removed.'); render();
  },
  retire: (a) => {
    const l = byId(DB.brassLots, a);
    if (!l) return;
    const loaded = brassCommitted(l);
    if (!l.retired && loaded > 0) {
      toast(`${loaded} case${loaded === 1 ? '' : 's'} are still in loaded rounds — fire or pull those first.`);
      return;
    }
    l.retired = !l.retired;
    save(); toast(l.retired ? 'Lot retired — it will not be offered for new batches.'
                            : 'Lot back in service.');
    render();
  },

  delBrass: (a) => guardedDelete('brass', a),
  delRecipe: (a) => { guardedDelete('recipe', a); if (cur().v !== 'recipes') reset('recipes'); },
  delComponent: (a) => { guardedDelete('component', a); if (cur().v !== 'inventory') reset('inventory'); },
  delFirearm: (a) => { guardedDelete('firearm', a); if (cur().v !== 'firearms') reset('firearms'); },
  delBatch: (a) => {
    const b = byId(DB.batches, a);
    const n = DB.sessions.filter(s => s.batch === a).length;
    // Deleting a batch takes its serial and every session fired from it. That
    // is a lot to do on one tap of a button next to "Quarantine".
    if (!confirm(`Delete batch ${b ? b.serial : ''}?`
      + (n ? `\n\nThis also deletes ${n} range session${n === 1 ? '' : 's'} logged against it.` : '')
      + '\n\nComponents and cases go back to their lots. This cannot be undone.')) return;
    DB.sessions = DB.sessions.filter(s => s.batch !== a);
    DB.batches = DB.batches.filter(x => x.id !== a); save(); toast('Batch deleted.'); reset('ammo'); },

  posAdd: (a) => { scheme().positions.push(a === 'head'
      ? { id: uid('p'), label: 'Case head', hint: 'around the primer', at: null, kind: 'head' }
      : { id: uid('p'), label: 'New band', hint: '', at: 0.5, kind: 'band' });
    save(); render(); },
  posDel: (a, el) => { const sc = scheme();
    if (sc.positions.length <= 1) { toast('Keep at least one position.'); return; }
    sc.positions.splice(+el.dataset.idx, 1); save(); render(); },
  palToggle: (a, el) => { const sc = scheme(), c = sc.palette[+el.dataset.idx];
    if (c.on && sc.palette.filter(x => x.on).length <= 1) { toast('Keep at least one colour.'); return; }
    c.on = !c.on; save(); render(); },
  blankToggle: () => { scheme().allowBlank = !scheme().allowBlank; save(); render(); },

  export: () => {
    const blob = new Blob([JSON.stringify(DB, null, 2)], { type: 'application/json' });
    const a2 = document.createElement('a');
    a2.href = URL.createObjectURL(blob);
    a2.download = `reloading-${today()}.json`;
    document.body.appendChild(a2); a2.click(); a2.remove();
    setTimeout(() => URL.revokeObjectURL(a2.href), 1000);
  },
  importBtn: () => document.getElementById('importFile').click(),
  wipe: () => {
    if (!confirm('Erase every record on this device? This cannot be undone.')) return;
    Store.wipe(); DB = loadDb(); toast('Erased.'); reset('lookup');
  },
};

/* ------------------------------------------------------------- listeners */
/* Actions that destroy a record. Every one of them used to fire on the first
 * tap, which on a phone is one mis-aimed thumb away from losing a brass lot
 * with four firings of history on it. guardedDelete refuses to delete anything
 * a batch still points at, which is a different protection entirely: it stops
 * you breaking a reference, not from deleting the thing you did not mean to
 * touch.
 *
 * Two taps, and the second one is on a button that has changed its label, so
 * it cannot be satisfied by a double tap. Handled here rather than in each
 * view because there are seven of these and the eighth would have been added
 * without one. */
const DESTRUCTIVE = new Set(['delFirearm', 'delBrass', 'delRecipe', 'delComponent',
                             'delBatch', 'delSession', 'unadjust']);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault();

  const key = el.dataset.act + ':' + (el.dataset.arg || '');
  if (DESTRUCTIVE.has(el.dataset.act) && UI.confirm !== key) {
    UI.confirm = key;
    render();
    /* It expires. A confirmation left armed across a screen change is a
     * delete waiting for an unrelated tap on the same spot. */
    clearTimeout(UI.confirmTimer);
    UI.confirmTimer = setTimeout(() => {
      if (UI.confirm === key) { UI.confirm = null; render(); }
    }, 5000);
    return;
  }
  UI.confirm = null;
  clearTimeout(UI.confirmTimer);
  fn(el.dataset.arg, el);
});

document.getElementById('back').addEventListener('click', back);

document.addEventListener('change', (e) => {
  const el = e.target;

  if (el.id === 'importFile' && el.files && el.files.length) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const parsed = JSON.parse(fr.result);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.brassLots)) {
          throw new Error('shape');
        }
        /* Import REPLACES the database. It used to do that on one tap, with no
         * confirmation and no indication of what was about to go -- on a device
         * where the file picker sits two buttons from "Erase all data", and
         * where restoring last month's backup onto a phone carrying this
         * month's loading destroys it silently.
         *
         * So it says what it is replacing and what with, in records, and asks.
         * Counting both sides is the point: "12 batches" means nothing without
         * "you have 47". */
        const n = (o, k) => (Array.isArray(o[k]) ? o[k].length : 0);
        const tally = (o) => COLLECTIONS.map(k => n(o, k)).reduce((a, b) => a + b, 0);
        const mine = tally(DB), theirs = tally(parsed);
        const detail = COLLECTIONS
          .filter(k => n(DB, k) || n(parsed, k))
          .map(k => `  ${k}: ${n(DB, k)} → ${n(parsed, k)}`).join('\n');
        if (mine > 0 && !confirm(
          `Replace everything on this device with this file?\n\n${detail}\n\n`
          + `${mine} record${mine === 1 ? '' : 's'} here are discarded and `
          + `${theirs} restored. This is not a merge, and it cannot be undone — `
          + `export first if you are not sure.`)) {
          render();
          return;
        }
        Store.save(parsed); DB = loadDb(); toast(`Imported ${theirs} records.`); reset('lookup');
      } catch (err) { toast('That file is not a Bench export.'); render(); }
    };
    fr.readAsText(el.files[0]);
    el.value = '';
    return;
  }

  const act = el.dataset && el.dataset.act;
  if (act === 'cartsel') {
    // "+ Add new cartridge" reveals the free-text field beside the list
    UI.cartNew[el.dataset.key] = el.value === '__new';
    const txt = el.form && el.form.querySelector(`[name="${el.dataset.key}__new"]`);
    if (txt) { txt.classList.toggle('hidden', el.value !== '__new'); if (el.value === '__new') txt.focus(); }
    /* The case-type controls belong to the same "adding a new one" state as
     * the text box, and are hidden with it -- offering a case shape for a
     * cartridge you picked from the list would imply it is about to change. */
    if (el.form) {
      el.form.querySelectorAll(`[data-newcase="${el.dataset.key}"]`).forEach(n =>
        n.classList.toggle('hidden', el.value !== '__new'));
    }
    return;
  }
  if (el.name === 'kind' && cur().v === 'form') {   // component type drives which fields show
    UI.formKind = el.value;
    document.querySelectorAll('#frm [data-only]').forEach(d =>
      d.classList.toggle('hidden', d.dataset.only !== el.value));
  }
  if (cur().v === 'form' && cur().arg && cur().arg.kind === 'batch') paintDrawPreview();
});

/* Typing a round count should move the numbers immediately, not on blur. */
document.addEventListener('input', (e) => {
  if (cur().v !== 'form' || !cur().arg || cur().arg.kind !== 'batch') return;
  if (!e.target.closest('#frm')) return;
  paintDrawPreview();
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;

  /* Case shape and head. Saved on change and redrawn, with no Save button:
   * the only thing either one affects is a picture on the same screen, so the
   * change and its consequence are visible in one move. */
  if (el.dataset.act === 'cartShape' || el.dataset.act === 'cartHead') {
    const c = byId(DB.cartridges, el.dataset.arg);
    if (!c) return;
    if (el.dataset.act === 'cartShape') c.shape = el.value; else c.head = el.value;
    save();
    render();
    return;
  }

  const sc = scheme(), i = +el.dataset.idx;
  switch (el.dataset.act) {
    case 'posLabel': sc.positions[i].label = el.value; save(); break;
    case 'posHint':  sc.positions[i].hint = el.value; save(); break;
    case 'posAt': {
      sc.positions[i].at = +el.value / 100; save();
      const w = document.querySelector('.casewrap');
      if (w) w.innerHTML = caseSvg({});
      break;
    }
    case 'posKind': {
      const p2 = sc.positions[i];
      p2.kind = el.value === 'head' ? 'head' : 'band';
      // A band needs a place on the case; the head does not have one.
      if (p2.kind === 'head') p2.at = null;
      else if (p2.at == null) p2.at = 0.5;
      save(); render();          // the slider appears or disappears with this
      break;
    }
    case 'baseUrl': DB.meta.baseUrl = el.value.trim(); save(); break;
    default: break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'serialIn') { e.preventDefault(); doSerialLookup(); }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const kind = form.dataset.kind;
  if (!kind || !(SAVERS[kind] || form.dataset.edit)) return;

  const d = readForm(form, kind);
  const editId = form.dataset.edit || null;
  if (kind === 'session' && cur().arg && cur().arg.batch) d.batch = cur().arg.batch;
  if (kind === 'cull' && cur().arg && cur().arg.lot) d.lot = cur().arg.lot;

  const err = validate(kind, d, editId);
  const box = document.getElementById('formErr');
  if (err) {
    if (box) box.innerHTML = `<div class="banner bad"><div>${esc(err)}</div></div>`;
    scrollTo(0, 0);
    return;
  }

  for (const f of FORMS[kind].fields) {
    if (f.t === 'cartridge' && typeof d[f.k] === 'string' && d[f.k].startsWith(PENDING)) {
      d[f.k] = ensureCartridge(d[f.k].slice(PENDING.length), d['__case_' + f.k]);
    }
    delete d['__case_' + f.k];
  }

  const [mode, target, msg] = editId ? applyEdit(kind, editId, d) : SAVERS[kind](d);
  const wrote = save();
  toast(wrote ? msg : msg.replace(/\.$/, '') + ' — in memory only, not saved to this device.');
  if (mode === 'err') { if (box) box.innerHTML = `<div class="banner bad"><div>${esc(msg)}</div></div>`; return; }
  stack.pop();
  if (mode === 'goDetail') go(target[0], target[1]); else reset(target);
});

/* -------------------------------------------------------------- start-up */

/* The QR on every box label, honoured.
 *
 * The label prints a QR and the words "the QR opens this record", and until now
 * nothing read the URL: scanning a box landed you on the Identify screen with
 * the serial thrown away, and the printed serial underneath -- the fallback --
 * was the only route that actually worked.
 *
 * The link is a FRAGMENT (#/s/SERIAL) rather than a path. A path needs the host
 * to rewrite /s/* onto index.html, which is a deploy setting that can be wrong
 * or missing, and which fails on a device that has not installed the service
 * worker yet -- the exact device someone is scanning a box with for the first
 * time. A fragment is never sent to the server, so it works on any static host,
 * offline, and from a file:// copy.
 *
 * It is consumed on arrival: the stack becomes Identify -> the record, so Back
 * behaves, and the address bar is cleaned so a later reload does not drag you
 * back to a box you have long since finished.
 */
function openDeepLink() {
  const raw = (location.hash || '').replace(/^#/, '') || location.pathname || '';
  if (/(^|\/)diag\/?$/.test(raw)) {
    stack = [{ v: 'lookup' }, { v: 'diag' }];
    return true;
  }
  const m = /(?:^|\/)s\/([^/?#]+)/.exec(decodeURIComponent(raw));
  if (!m) return false;
  const found = findBySerial(m[1]);
  if (location.hash && history.replaceState) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!found) {
    /* Almost always the same cause, and it is not a missing record.
     *
     * A phone camera opens a scanned URL in the BROWSER. On iOS an installed
     * home-screen app has its own storage container, entirely separate from
     * Safari's -- so the browser that just opened has no brass, no batches and
     * no session, and every scan lands on an app that looks wiped. The old
     * behaviour was a toast saying nothing on this device carries that serial,
     * which is true, useless, and reads like the record is gone.
     *
     * A screen instead of a toast, because there is something to do here: the
     * serial is what the app's own By-serial box wants, so it is shown large
     * and copyable. */
    UI.scanned = m[1];
    stack = [{ v: 'scanned', arg: m[1] }];
    return true;
  }
  stack = [{ v: 'lookup' }, { v: found[0], arg: found[1] }];
  return true;
}

openDeepLink();
render();

/* Sync on launch when a session already exists.
 *
 * The manual button stays -- a user who wants to know that something happened
 * right now needs a control that says so -- but the common case should not
 * require one. Deferred behind the first paint so a slow or dead network never
 * delays the app opening, and guarded on navigator.onLine so a phone that is
 * plainly offline does not spend a request finding that out. Errors land in
 * UI.sync like any other sync and are shown on the card; they never throw into
 * the boot path. */
if (CORE && CORE.isSignedIn() && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
  setTimeout(() => { doSync().catch(() => {}); }, 800);
}

/* The service worker only exists over http(s); opening the file directly is a
 * supported way to use this app and must not throw. */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    /* The build id rides in the query string. The worker is the one file whose
     * job is to notice a new build, which makes it the one file a stale cache
     * ruins completely -- and a stale copy WAS being served from the bare URL
     * while the same path with any query returned the current one. A URL that
     * changes every build cannot be answered from a cache of the last one.
     * Scope is taken from the path, so the query changes nothing about it. */
    navigator.serviceWorker
      .register('sw.js?v=' + encodeURIComponent(typeof BUILD_ID === 'string' ? BUILD_ID : 'dev'))
      .catch(() => {});
  });
}
