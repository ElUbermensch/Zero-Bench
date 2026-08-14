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

/* --------------------------------------------------------------------------
 * Data model
 * ------------------------------------------------------------------------*/
const SCHEMA = 2;

const DEFAULT_SCHEME = {
  positions: [
    { id: 'neck', label: 'Neck band', hint: 'toward the bullet', at: 0.72 },
    { id: 'head', label: 'Head band', hint: 'toward the primer', at: 0.26 },
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

const emptyDb = () => ({
  meta: {
    schema: SCHEMA,
    scheme: JSON.parse(JSON.stringify(DEFAULT_SCHEME)),
    baseUrl: location.origin && location.origin !== 'null' ? location.origin : '',
    overheadPerRound: 0,
  },
  cartridges: [], firearms: [], componentLots: [],
  brassLots: [], recipes: [], batches: [], sessions: [],
});

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
  db.meta = Object.assign(emptyDb().meta, raw.meta || {});
  db.meta.schema = SCHEMA;
  for (const c of COLLECTIONS) if (!Array.isArray(db[c])) db[c] = [];
  if (!db.meta.scheme || !Array.isArray(db.meta.scheme.positions)) {
    db.meta.scheme = JSON.parse(JSON.stringify(DEFAULT_SCHEME));
  }
  return db;
}

let DB = loadDb();
const save = () => Store.save(DB);
const scheme = () => DB.meta.scheme;

const uid = (p) => p + Math.random().toString(36).slice(2, 9);
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

function ensureCartridge(name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const found = findCartridge(clean);
  if (found) return found.id;
  const c = { id: uid('ct'), name: clean };
  DB.cartridges.push(c);
  return c.id;
}

const cartName = (id) => (byId(DB.cartridges, id) || {}).name || '—';

/* ------------------------------------------------------------------ derived */
const recipeOf = (b) => byId(DB.recipes, b.recipe);
const sessionsFor = (id) => DB.sessions.filter(s => s.batch === id);
const isUntested = (b) => sessionsFor(b.id).length === 0;
const isOverMax = (b) => {
  const r = recipeOf(b);
  return !!(r && r.sourceMax > 0 && r.charge > r.sourceMax);
};

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
    p.powder = (pw.cost / (pw.qty * GRAINS_PER_LB)) * (+b.chargeActual || +r.charge || 0);
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

/** What one batch draws, in natural units. Powder is in grains: the measured
 *  charge if it was weighed, otherwise the recipe's target. */
function batchDraw(b) {
  const r = recipeOf(b);
  const n = Math.max(0, +b.qty || 0);
  const charge = +b.chargeActual || (r ? +r.charge : 0) || 0;
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

/** Cases sitting in loaded, unfired rounds. They are not gone — firing a
 *  batch returns them to the pool as once-more-fired brass. */
const brassCommitted = (lot, exceptBatch) => DB.batches
  .filter(b => b.brassLot === lot.id && b.id !== exceptBatch)
  .reduce((s, b) => s + Math.max(0, +b.remaining || 0), 0);

const brassAvailable = (lot, exceptBatch) =>
  (+lot.qty || 0) - brassCommitted(lot, exceptBatch);

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

function brassChips(l) {
  const out = [];
  if (l.retired) out.push(['bad', 'Retired']);
  else if (l.firings >= l.expectedFirings) out.push(['bad', 'At life limit']);
  else if (l.firings >= l.expectedFirings - 1) out.push(['warn', 'Near limit']);
  if (!l.lastAnneal && l.firings >= 3) out.push(['warn', 'Never annealed']);
  return out;
}

function batchChips(b) {
  const out = [];
  if (b.quarantine) out.push(['bad', 'Quarantined']);
  if (isOverMax(b)) out.push(['bad', 'Over published max']);
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
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (s) => s
  ? new Date(s + 'T12:00:00').toLocaleDateString(undefined,
      { year: 'numeric', month: 'short', day: 'numeric' })
  : '—';
const num = (v, d) => (v === '' || v == null || isNaN(+v) ? (d == null ? null : d) : +v);

/* --------------------------------------------------------------- case SVG */
const CASE_PATH = 'M40,28 L78,28 L100,17 L248,17 L248,13 L262,13 L262,75 L248,75 '
                + 'L248,71 L100,71 L78,60 L40,60 Z';
const HEAD_X = 248, NECK_X = 42;
let svgSeq = 0;

function caseSvg(marks, opts) {
  const o = opts || {}, sc = scheme();
  const uidc = 'cc' + (++svgSeq);
  const bands = sc.positions.map(p => {
    const col = marks && marks[p.id] ? sc.palette.find(c => c.id === marks[p.id]) : null;
    const x = HEAD_X - p.at * (HEAD_X - NECK_X);
    const w = o.mini ? 15 : 17;
    return col
      ? `<rect x="${x - w / 2}" y="10" width="${w}" height="70" fill="${col.hex}"/>`
      : `<rect x="${x - w / 2}" y="10" width="${w}" height="70" fill="none" `
        + `stroke="#7a828f" stroke-width="1.4" stroke-dasharray="3 3"/>`;
  }).join('');
  const ticks = o.mini ? '' : sc.positions.map(p => {
    const x = HEAD_X - p.at * (HEAD_X - NECK_X);
    return `<line x1="${x}" y1="78" x2="${x}" y2="88" stroke="#6c7480" stroke-width="1"/>`
      + `<text x="${x}" y="99" fill="#9aa3b0" font-size="11" text-anchor="middle">${esc(p.label)}</text>`;
  }).join('');
  return `<svg class="case${o.mini ? ' casemini' : ''}" viewBox="0 0 300 ${o.mini ? 88 : 106}"
      xmlns="http://www.w3.org/2000/svg" role="img" aria-label="case marking">
    <defs><clipPath id="${uidc}"><path d="${CASE_PATH}"/></clipPath></defs>
    <path d="${CASE_PATH}" fill="#b9a06a" stroke="#8d7844" stroke-width="1.5"/>
    <g clip-path="url(#${uidc})">${bands}</g>
    <path d="${CASE_PATH}" fill="none" stroke="#8d7844" stroke-width="1.5"/>
    <path d="M248,17 L248,71" stroke="#8d7844" stroke-width="1"/>${ticks}</svg>`;
}

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
    { k: 'firings', l: 'Firings so far', t: 'num', def: 0 },
    { k: 'expectedFirings', l: 'Expected firings', t: 'num', def: 6 },
    { k: 'cost', l: 'Lot cost ($)', t: 'num', step: '0.01', def: 0 },
    { k: 'origin', l: 'Origin', t: 'select',
      opts: [['new', 'New'], ['once-fired', 'Once-fired'], ['range pickup', 'Range pickup']] },
    { k: 'notes', l: 'Notes', t: 'area' },
  ]},

  batch: { title: 'Batch', fields: [
    { k: 'recipe', l: 'Recipe', t: 'ref', ref: () => DB.recipes, label: r => r.name,
      req: true, hard: true },
    // Recording WHICH lot went into a batch is the point of the app, so these
    // are required whenever there is a lot to pick. Defaulting them to "none"
    // silently produced zero-cost, untraceable batches.
    { k: 'brassLot', l: 'Brass lot', t: 'ref', req: true,
      ref: () => DB.brassLots.filter(l => !l.retired),
      label: l => `${l.serial} — ${l.headstamp} (${l.firings}f)` },
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
    { k: 'runout', l: 'Runout TIR (in)', t: 'num', step: '0.0001' },
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
const UI = { lookup: {}, marks: {}, formKind: null, toast: null, cartNew: {} };

function fieldHtml(f, kind) {
  const hint = f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : '';
  const req = f.req ? 'required' : '';
  let ctrl = '';

  switch (f.t) {
    case 'area':
      ctrl = `<textarea name="${f.k}"></textarea>`; break;

    case 'num':
      ctrl = `<input type="number" inputmode="decimal" name="${f.k}"
        ${f.step ? `step="${f.step}"` : 'step="any"'}
        ${f.def != null ? `value="${f.def}"` : ''} ${req}>`; break;

    case 'date':
      ctrl = `<input type="date" name="${f.k}" value="${today()}">`; break;

    case 'select':
      ctrl = `<select name="${f.k}">${f.opts.map(([v, l]) =>
        `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`; break;

    case 'ref': {
      const rows = f.ref();
      if (!rows.length) {
        return `<label class="f"><span>${esc(f.l)}</span>
          <div class="banner warn"><div class="small">None recorded yet.${
            f.req ? ' This is required before you can continue.' : ''}</div></div></label>`;
      }
      ctrl = `<select name="${f.k}" ${req}>${!f.req ? '<option value="">—</option>' : ''}
        ${rows.map(r => `<option value="${r.id}">${esc(f.label(r))}</option>`).join('')}</select>`;
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
            `<option value="${c.id}" ${open ? '' : ''}>${esc(c.name)}</option>`).join('')}
          <option value="__new" ${open ? 'selected' : ''}>+ Add new cartridge…</option>
        </select>
        <input type="text" name="${f.k}__new" class="mt6 ${open ? '' : 'hidden'}"
          placeholder="e.g. 6.5 Creedmoor" autocomplete="off">`;
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
  // Every field is rendered. Type-specific ones are hidden with a class and
  // toggled on change -- re-rendering the form would reset the <select> to its
  // first option and throw away anything already typed.
  return `<form id="frm" class="card" data-kind="${kind}" novalidate>
    ${spec.fields.map(f => {
      const html = f.only
        ? `<div data-only="${f.only}" class="${f.only === shown ? '' : 'hidden'}">${fieldHtml(f, kind)}</div>`
        : fieldHtml(f, kind);
      // The draw preview sits immediately under "Rounds loaded", not at the
      // foot of the form. It is the consequence of that one number, and a
      // consequence ten fields below the cause is a consequence nobody reads.
      return (kind === 'batch' && f.k === 'qty') ? html + '<div id="drawpv"></div>' : html;
    }).join('')}
    <button class="btn primary wide" type="submit">Save ${esc(spec.title.toLowerCase())}</button>
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

/** Returns an error string, or null when the record is acceptable. */
function validate(kind, d) {
  for (const f of FORMS[kind].fields) {
    if (!f.req) continue;
    if (f.only && f.only !== d.kind) continue;
    if (f.t === 'ref' && !f.ref().length) continue;   // nothing to pick yet
    const v = d[f.k];
    if (v === '' || v == null || (f.t === 'num' && !Number.isFinite(v))) {
      return `${f.l} is required.`;
    }
  }
  if (kind === 'brass' && DB.brassLots.some(l => marksEqual(l.marks, d.marks))) {
    return 'That colour code is already in use.';
  }
  if (kind === 'component' && d.qty <= 0) return 'Quantity must be greater than zero.';
  if (kind === 'batch' && d.qty <= 0) return 'Rounds loaded must be greater than zero.';
  if (kind === 'batch') {
    // Refuse rather than go negative. A stock figure that can be negative is
    // not a stock figure, and silently allowing it is how the inventory stops
    // being worth reading.
    const pv = drawPreview(d);
    const short = pv.rows.filter(r => r.short);
    if (short.length) {
      const cap = maxRoundsFor(d);
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
  settings: ['Marking scheme', ''],
  data: ['Data', 'backup and reset'],
  form: ['', ''],
};

function render() {
  const c = cur();
  let [t, s] = TITLES[c.v] || ['', ''];
  if (c.v === 'form') { t = 'New ' + FORMS[c.arg.kind].title.toLowerCase(); s = ''; }
  document.getElementById('title').innerHTML =
    esc(t) + (s ? `<div class="sub">${esc(s)}</div>` : '');
  document.getElementById('back').classList.toggle('hidden', stack.length < 2);
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

  return `<div class="card">
    <div class="casewrap mb12">${caseSvg(preview)}</div>
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
  </div>`;
};

function brassRow(l) {
  return `<button class="listitem" data-act="brassDetail" data-arg="${l.id}">
    ${caseSvg(l.marks, { mini: true })}
    <span class="grow">
      <span class="ttl">${esc(l.headstamp)} · ${esc(cartName(l.cartridge))}</span>
      <span class="sub mono">${esc(l.serial)} · ${esc(codeOf(l.marks))}</span>
      <span class="sub">${l.qty} cases · ${l.firings} of ${l.expectedFirings} firings</span>
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
  const pct = Math.min(100, l.expectedFirings ? l.firings / l.expectedFirings * 100 : 0);
  const bar = pct >= 100 ? 'var(--bad)' : pct > 80 ? 'var(--warn)' : 'var(--ok)';
  return `<div class="card">
      <div class="spread mb8">
        <div><h2 class="m0">${esc(l.headstamp)}</h2>
          <div class="small muted">${esc(cartName(l.cartridge))}${l.maker ? ' · ' + esc(l.maker) : ''}</div></div>
        <div class="mono big">${esc(l.serial)}</div>
      </div>
      ${brassChips(l).length ? `<div>${chips(brassChips(l))}</div>` : ''}
      <div class="casewrap mt12">${caseSvg(l.marks)}</div>
      <div class="small muted center mt8">Marked <b class="mono">${esc(codeOf(l.marks))}</b></div>
    </div>
    <div class="card">
      <div class="spread small"><span>${l.firings} of ${l.expectedFirings} expected firings</span>
        <span class="mono">${pct.toFixed(0)}%</span></div>
      <div class="capbar"><i style="width:${pct}%;background:${bar}"></i></div>
      <hr>
      <dl class="kv">
        <dt>Cases on hand</dt><dd class="mono">${l.qty} of ${l.initialQty}</dd>
        <dt>Origin</dt><dd>${esc(l.origin || '—')}</dd>
        <dt>Acquired</dt><dd>${fmtDate(l.acquired)}</dd>
        <dt>Last anneal</dt><dd>${l.lastAnneal ? fmtDate(l.lastAnneal) : '<span class="chip warn">never</span>'}</dd>
        <dt>Lot cost</dt><dd class="mono">${l.cost ? money2(l.cost) : '—'}</dd>
        <dt>Amortised</dt><dd class="mono">${l.cost && l.initialQty && l.expectedFirings
          ? money(l.cost / (l.initialQty * l.expectedFirings)) + '/rd' : '—'}</dd>
      </dl>
      ${l.notes ? `<hr><p class="small muted m0">${esc(l.notes)}</p>` : ''}
    </div>
    <div class="card"><h2>Used by</h2>${used.length
      ? used.map(b => `<button class="listitem" data-act="ammoDetail" data-arg="${b.id}">
          <span class="grow"><span class="ttl mono">${esc(b.serial)}</span>
          <span class="sub">${b.qty} rounds · ${fmtDate(b.date)}</span></span>
          <span class="chev">›</span></button>`).join('')
      : '<div class="empty"><p>Not loaded into any batch yet.</p></div>'}</div>
    <div class="btnrow noprint">
      <button class="btn" data-act="logfire" data-arg="${l.id}">Log a firing</button>
      <button class="btn" data-act="loganneal" data-arg="${l.id}">Log anneal</button>
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
            <span class="sub">${b.remaining} of ${b.qty} rounds · ${fmtDate(b.date)}</span>
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
  const pct = r && r.sourceMax > 0 ? (r.charge / r.sourceMax) * 100 : null;

  let warn = '';
  if (b.quarantine) warn += `<div class="banner bad"><div><b>QUARANTINED — DO NOT FIRE</b>
    ${b.notes ? `<span class="small">${esc(b.notes)}</span>` : ''}</div></div>`;
  if (isOverMax(b)) warn += `<div class="banner bad"><div><b>Charge exceeds the published maximum.</b>
    <span class="small">${r.charge} gr against a cited max of ${r.sourceMax} gr
    (${pct.toFixed(1)}%). Work up from below and watch for pressure signs.</span></div></div>`;
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
      <dt>Rounds</dt><dd class="mono">${b.remaining} of ${b.qty} remaining</dd>
      <dt>Storage</dt><dd>${esc(b.storage || '—')}</dd>
    </dl>
    <div class="btnrow mt12 noprint">
      <button class="btn primary" data-act="label" data-arg="${b.id}">Label</button>
      <button class="btn" data-act="newSessionFor" data-arg="${b.id}">Log range session</button>
      <button class="btn ${b.quarantine ? '' : 'danger'}" data-act="toggleQ" data-arg="${b.id}">
        ${b.quarantine ? 'Release' : 'Quarantine'}</button>
    </div>
  </div>
  <div class="card"><h2>Load</h2>
    <dl class="kv">
      <dt>Charge</dt><dd class="mono">${b.chargeActual ?? (r ? r.charge : '—')} gr</dd>
      ${b.chargeSd != null ? `<dt>Charge SD</dt><dd class="mono">${b.chargeSd} gr</dd>` : ''}
      <dt>COAL</dt><dd class="mono">${b.coalMean ?? (r ? r.coal : null) ?? '—'}"</dd>
      ${b.runout != null ? `<dt>Runout TIR</dt><dd class="mono">${b.runout}"</dd>` : ''}
      ${b.press ? `<dt>Press / dies</dt><dd>${esc(b.press)}</dd>` : ''}
    </dl>
    ${r ? `<hr><div class="small muted"><b>Source:</b> ${esc(r.source)}${
      r.page ? ' · ' + esc(r.page) : ''}${r.sourceMax > 0 ? `<br>Published max ${r.sourceMax} gr —
      this load is <b style="color:${pct > 100 ? 'var(--bad)' : pct > 97 ? 'var(--warn)' : 'var(--ok)'}">${
      pct.toFixed(1)}%</b> of max.` : '<br>No published maximum recorded.'}</div>` : ''}
  </div>
  <div class="card"><h2>Components</h2>
    ${lot('bulletLot')}${lot('powderLot')}${lot('primerLot')}
    ${brass ? `<button class="listitem mt10" data-act="brassDetail" data-arg="${brass.id}">
      ${caseSvg(brass.marks, { mini: true })}
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
          ${s.vAvg != null ? `<dt>Velocity</dt><dd class="mono">${s.vAvg} fps</dd>` : ''}
          ${s.vSd != null ? `<dt>SD / ES</dt><dd class="mono">${s.vSd} / ${s.vEs ?? '—'}</dd>` : ''}
          ${s.group != null ? `<dt>Group @ ${s.distance}y</dt><dd class="mono">${s.group}"</dd>` : ''}
          <dt>Pressure signs</dt><dd>${s.pressureSigns === 'none'
            ? '<span class="chip ok">none</span>'
            : `<span class="chip bad">${esc(s.pressureSigns)}</span>`}</dd>
        </dl>${s.notes ? `<p class="small muted mt6 m0">${esc(s.notes)}</p>` : ''}</div>`;
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
  const url = (DB.meta.baseUrl || '') + '/s/' + b.serial;
  const qr = QR.toSvg(url, { ecc: 'M', quietZone: 2 });
  const band = b.quarantine ? 'DO NOT FIRE — QUARANTINED'
    : isOverMax(b) ? 'OVER PUBLISHED MAX'
    : isUntested(b) ? 'UNTESTED — WORK UP' : '';
  const dots = brass ? scheme().positions.map(p => {
    const c = brass.marks[p.id] ? scheme().palette.find(x => x.id === brass.marks[p.id]) : null;
    return `<i style="background:${c ? c.hex : 'transparent'};${c ? '' : 'border-style:dashed'}"></i>`;
  }).join('') : '';
  return `<div class="lbl ${band ? 'hasband' : ''}">
    ${band ? `<div class="band">${esc(band)}</div>` : ''}
    <div class="cart">${esc(r ? cartName(r.cartridge) : '')}</div>
    <div class="load">${esc(r ? r.bullet : '')}<br>${esc(r ? r.powder : '')}
      · <b>${b.chargeActual ?? (r ? r.charge : '')} gr</b>
      ${b.coalMean ? ` · COAL ${b.coalMean}"` : ''}<br>${esc(r ? r.primer : '')}</div>
    ${brass ? `<div class="marks">${dots}<span class="ms">${esc(brass.headstamp)} · ${brass.firings}f</span></div>` : ''}
    <div class="btm"><div class="grow1">
      <div class="ser">${esc(b.serial)}</div>
      <div class="meta">${fmtDate(b.date)} · ${b.qty} rounds</div>
    </div><div class="qr">${qr}</div></div>
  </div>`;
}

/* ------------------------------------------------------------------- More */
VIEWS.more = () => [
  ['inventory', 'Inventory', `${DB.componentLots.length} component lot${DB.componentLots.length === 1 ? '' : 's'}`],
  ['recipes', 'Recipes', `${DB.recipes.length} load specification${DB.recipes.length === 1 ? '' : 's'}`],
  ['firearms', 'Firearms', `${DB.firearms.length} recorded`],
  ['settings', 'Marking scheme', `${scheme().positions.length} positions · ${schemeCapacity()} codes`],
  ['data', 'Data', Store.persistent ? 'saved on this device' : 'not persisting — export to keep'],
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
        <div class="mt6"><button class="btn sm danger" data-act="delComponent" data-arg="${c.id}">Delete</button></div>
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
    const over = r.sourceMax > 0 && r.charge > r.sourceMax;
    return `<div class="listitem static">
      <span class="grow"><span class="ttl">${esc(r.name)}</span>
        <span class="sub">${esc(cartName(r.cartridge))} · ${r.charge} gr${r.coal ? ' · COAL ' + r.coal + '"' : ''}</span>
        <span class="sub">${esc(r.bullet)} · ${esc(r.powder)} · ${esc(r.primer)}</span>
        <span class="sub mt5">${over ? '<span class="chip bad">Over max</span> ' : ''}
          <span class="chip neutral">${esc(r.source)}</span></span>
        <span class="mt6" style="display:block">
          <button class="btn sm danger" data-act="delRecipe" data-arg="${r.id}">Delete</button></span>
      </span></div>`;
  }).join('') : empty('No recipes yet. A recipe records the load and, crucially, where the data came from.');
  return body + `<button class="btn primary wide" data-act="new" data-arg="recipe">+ New recipe</button>
    <div class="banner info mt12"><div class="small">This app records load data.
      It never suggests, interpolates or extrapolates a charge, and ships with none.</div></div>`;
};

VIEWS.firearms = () => {
  const body = DB.firearms.length ? DB.firearms.map(f => `<div class="card">
      <div class="spread"><h2 class="m0">${esc(f.name)}</h2>
        <button class="btn sm danger" data-act="delFirearm" data-arg="${f.id}">Delete</button></div>
      <dl class="kv mt8">
        <dt>Cartridge</dt><dd>${esc(cartName(f.cartridge))}</dd>
        ${f.barrel ? `<dt>Barrel</dt><dd>${f.barrel}"${f.twist ? ' · ' + esc(f.twist) : ''}</dd>` : ''}
        ${f.sightHeight ? `<dt>Sight height</dt><dd class="mono">${f.sightHeight}"</dd>` : ''}
        ${f.zeroRange ? `<dt>Zero</dt><dd class="mono">${f.zeroRange} yd</dd>` : ''}
      </dl></div>`).join('')
    : empty('No firearms yet. Needed to attribute range results, and to carry sight height and zero range.');
  return body + `<button class="btn primary wide" data-act="new" data-arg="firearm">+ New firearm</button>`;
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
        <span class="tiny dim">head</span>
        <input type="range" min="5" max="95" value="${Math.round(p.at * 100)}"
          data-act="posAt" data-idx="${i}" style="flex:1">
        <span class="tiny dim">neck</span>
      </div></div>`).join('')}
    <button class="btn sm mt10" data-act="posAdd">+ Add position</button>
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

VIEWS.form = (arg) => {
  const kind = arg.kind;
  const spec = FORMS[kind];
  const blockers = spec.fields.filter(f => f.hard && !f.ref().length);
  if (blockers.length) {
    return `<div class="banner warn"><div><b>${esc(blockers[0].l)} required.</b>
      <span class="small">Add one before creating a ${esc(spec.title.toLowerCase())}.</span></div></div>`;
  }
  return `<div id="formErr"></div>` + formHtml(kind, { kindSel: UI.formKind });
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

/* Creation: exactly one save path per kind. */
const SAVERS = {
  firearm: (d) => {
    DB.firearms.push({ id: uid('f'), name: d.name, cartridge: d.cartridge,
      barrel: d.barrel, twist: d.twist, sightHeight: d.sightHeight,
      zeroRange: d.zeroRange, notes: d.notes });
    return ['nav', 'firearms', 'Firearm saved.'];
  },
  component: (d) => {
    DB.componentLots.push({ id: uid('cl'), serial: Serial.shortCode('C', takenSerials()),
      kind: d.kind, name: d.name, lot: d.lot, qty: d.qty,
      unit: d.unit || 'ea', cost: d.cost || 0, vendor: d.vendor,
      weightGr: d.weightGr, bcG1: d.bcG1, bcG7: d.bcG7 });
    return ['nav', 'inventory', 'Component lot saved.'];
  },
  recipe: (d) => {
    DB.recipes.push({ id: uid('r'), name: d.name, cartridge: d.cartridge,
      bullet: d.bullet, powder: d.powder, primer: d.primer, charge: d.charge,
      coal: d.coal, cbto: d.cbto, source: d.source, page: d.page,
      sourceMax: d.sourceMax, notes: d.notes });
    return ['nav', 'recipes', 'Recipe saved.'];
  },
  brass: (d) => {
    const serial = Serial.shortCode('R', takenSerials());
    if (!serial) return ['err', null, 'Serial space exhausted.'];
    const rec = { id: uid('bl'), serial, marks: d.marks, cartridge: d.cartridge,
      headstamp: d.headstamp, maker: d.maker, initialQty: d.initialQty,
      qty: d.initialQty, firings: d.firings || 0,
      expectedFirings: d.expectedFirings || 6, cost: d.cost || 0,
      origin: d.origin, acquired: today(), lastAnneal: null, retired: false, notes: d.notes };
    DB.brassLots.push(rec);
    return ['goDetail', ['brassDetail', rec.id], `Brass lot ${serial} created.`];
  },
  batch: (d) => {
    const serial = Serial.batchSerial(d.date || today(), takenSerials());
    if (!serial) return ['err', null, 'No serial left for that date — 99 batches already.'];
    const rec = { id: uid('ba'), serial, recipe: d.recipe, brassLot: d.brassLot,
      bulletLot: d.bulletLot, powderLot: d.powderLot, primerLot: d.primerLot,
      date: d.date || today(), qty: d.qty, remaining: d.qty,
      chargeActual: d.chargeActual, chargeSd: d.chargeSd, coalMean: d.coalMean,
      runout: d.runout, press: d.press, storage: d.storage,
      quarantine: false, notes: d.notes };
    DB.batches.push(rec);
    return ['goDetail', ['ammoDetail', rec.id], `Batch ${serial} created.`];
  },
  session: (d) => {
    DB.sessions.push({ id: uid('se'), batch: d.batch, firearm: d.firearm,
      date: d.date || today(), rounds: d.rounds, distance: d.distance,
      vAvg: d.vAvg, vSd: d.vSd, vEs: d.vEs, group: d.group, temp: d.temp,
      pressureSigns: d.pressureSigns || 'none', notes: d.notes });
    const b = byId(DB.batches, d.batch);
    if (b) b.remaining = Math.max(0, b.remaining - (d.rounds || 0));
    return ['goDetail', ['ammoDetail', d.batch], 'Session saved — batch is no longer untested.'];
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

  /* The app already knows the largest loadable count; making the user retype
   * it is busywork. Tapping the figure fills the field. */
  fillmax: (a) => {
    const el = document.querySelector('#frm [name="qty"]');
    if (!el) return;
    el.value = String(Math.max(0, +a || 0));
    el.focus();
    paintDrawPreview();
  },

  serialgo: () => doSerialLookup(),
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
  logfire: (a) => { const l = byId(DB.brassLots, a); l.firings += 1;
    save(); toast(`${l.serial} now at ${l.firings} firings.`); render(); },
  loganneal: (a) => { const l = byId(DB.brassLots, a); l.lastAnneal = today();
    save(); toast('Anneal logged.'); render(); },

  delBrass: (a) => guardedDelete('brass', a),
  delRecipe: (a) => { guardedDelete('recipe', a); if (cur().v !== 'recipes') reset('recipes'); },
  delComponent: (a) => { guardedDelete('component', a); if (cur().v !== 'inventory') reset('inventory'); },
  delFirearm: (a) => { guardedDelete('firearm', a); if (cur().v !== 'firearms') reset('firearms'); },
  delBatch: (a) => { DB.sessions = DB.sessions.filter(s => s.batch !== a);
    DB.batches = DB.batches.filter(b => b.id !== a); save(); toast('Batch deleted.'); reset('ammo'); },

  posAdd: () => { scheme().positions.push({ id: uid('p'), label: 'New position', hint: '', at: 0.5 });
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
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault();
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
        Store.save(parsed); DB = loadDb(); toast('Imported.'); reset('lookup');
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
  if (!kind || !SAVERS[kind]) return;

  const d = readForm(form, kind);
  if (kind === 'session' && cur().arg && cur().arg.batch) d.batch = cur().arg.batch;

  const err = validate(kind, d);
  const box = document.getElementById('formErr');
  if (err) {
    if (box) box.innerHTML = `<div class="banner bad"><div>${esc(err)}</div></div>`;
    scrollTo(0, 0);
    return;
  }

  for (const f of FORMS[kind].fields) {
    if (f.t === 'cartridge' && typeof d[f.k] === 'string' && d[f.k].startsWith(PENDING)) {
      d[f.k] = ensureCartridge(d[f.k].slice(PENDING.length));
    }
  }

  const [mode, target, msg] = SAVERS[kind](d);
  const wrote = save();
  toast(wrote ? msg : msg.replace(/\.$/, '') + ' — in memory only, not saved to this device.');
  if (mode === 'err') { if (box) box.innerHTML = `<div class="banner bad"><div>${esc(msg)}</div></div>`; return; }
  stack.pop();
  if (mode === 'goDetail') go(target[0], target[1]); else reset(target);
});

/* -------------------------------------------------------------- start-up */
render();

/* The service worker only exists over http(s); opening the file directly is a
 * supported way to use this app and must not throw. */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
