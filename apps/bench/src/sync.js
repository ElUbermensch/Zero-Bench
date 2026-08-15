/* ==========================================================================
 * BENCH → the shared schema.
 *
 * Bench's local model and the database disagree in three places, and each
 * disagreement is a real modelling difference rather than a naming one:
 *
 *  1. A Bench "component lot" conflates the PRODUCT with the PURCHASE. One
 *     record holds both "Berger 140gr Hybrid, G7 0.311" and "lot BG-0326, 500
 *     of them for $289". The schema separates them, because the product is
 *     what a recipe references and the purchase is what runs out. Each Bench
 *     lot therefore becomes two rows: a product and a component_lots.
 *
 *  2. Bench recipes name their components as free text. The schema wants
 *     foreign keys. Names are resolved against the lots you have recorded;
 *     an unmatched name is reported, not invented, because a recipe silently
 *     pointing at the wrong bullet is worse than one that fails to sync.
 *
 *  3. Bench ids are short local strings ('cl1', 'ba7'). The schema wants
 *     UUIDs. Each record is given one ONCE and keeps it, so a second sync
 *     updates rows rather than duplicating them. That id is written back into
 *     local storage, which is why push returns a possibly-mutated DB.
 *
 * Nothing here throws on bad data. A record that cannot be represented is
 * returned in `blocked` with a reason a human can act on, and everything else
 * still goes. One unsyncable lot must not strand an entire bench.
 * ========================================================================*/
const BenchSync = (() => {

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
        const r = Math.random() * 16 | 0;
        return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));

  /* A stable remote id, minted once and kept. Mutates the record, and the
   * caller persists — assigning ids without saving them would mint fresh ones
   * on the next sync and duplicate every row. */
  const rid = (rec, key) => (rec[key || 'remote'] ||= uuid());
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const nn = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
  const iso = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

  /* Bench stores powder by the pound and the schema wants a unit named on the
   * row, so the two agree as long as the unit travels with the number. */
  const unitOf = (lot) => (lot.unit === 'lb' ? 'lb' : lot.kind === 'powder' ? 'gr' : 'ea');

  /* What is left of a component lot, derived the same way the app derives it.
   * Passed in rather than recomputed so there is one definition of "left". */
  function buildRows(DB, left) {
    const out = [];       // [{table, row}] in FK-safe order
    const blocked = [];   // [{what, why}]
    const add = (table, row) => out.push({ table, row });

    /* ---------------------------------------------------- profile + scheme */
    // The marking scheme is what makes a colour code mean anything, so it
    // travels with the account rather than living only on one phone.
    add('profiles', { id: null, marking_scheme: DB.meta?.scheme || {} });

    /* ------------------------------------------------------------ firearms */
    for (const f of DB.firearms || []) {
      if (!f.name || !f.cartridge) {
        blocked.push({ what: `firearm ${f.name || '(unnamed)'}`,
                       why: 'a firearm needs a name and a cartridge' });
        continue;
      }
      add('firearms', {
        id: rid(f), name: f.name, cartridge: cartName(f.cartridge),
        barrel_in: nn(f.barrel), twist: f.twist || null,
        sight_height_in: nn(f.sightHeight), zero_range_yd: nn(f.zeroRange),
        notes: f.notes || null,
      });
    }

    /* -------------------------------------------- components: product + lot */
    const productOf = new Map();     // normalised name -> {kind, id}
    for (const c of DB.componentLots || []) {
      const kind = c.kind;
      if (!['bullet', 'powder', 'primer'].includes(kind)) continue;

      // The product identity, deduplicated by name: two purchases of the same
      // bullet are two lots of one product, which is the entire reason the
      // schema keeps them apart.
      const key = kind + '|' + norm(c.name);
      let prod = productOf.get(key);
      if (!prod) {
        const pid = rid(c, 'remoteProduct');
        if (kind === 'bullet') {
          const w = nn(c.weightGr);
          if (!(w > 0)) {
            // Not faked: bullet weight is required by the schema because a
            // ballistic solution cannot be built without it, and inventing
            // one would put a wrong number in front of a shooter.
            blocked.push({ what: `bullet ${c.name}`,
                           why: 'needs a bullet weight in grains before it can sync' });
            continue;
          }
          add('bullet_products', { id: pid, model: c.name, weight_gr: w,
                                   bc_g1: nn(c.bcG1), bc_g7: nn(c.bcG7) });
        } else if (kind === 'powder') {
          add('powder_products', { id: pid, name: c.name });
        } else {
          add('primer_products', { id: pid, model: c.name });
        }
        prod = { kind, id: pid };
        productOf.set(key, prod);
      }

      const qty = nn(c.qty);
      if (!(qty > 0)) {
        blocked.push({ what: `lot ${c.name}`, why: 'quantity purchased must be greater than zero' });
        continue;
      }
      add('component_lots', {
        id: rid(c), kind,
        bullet_id: kind === 'bullet' ? prod.id : null,
        powder_id: kind === 'powder' ? prod.id : null,
        primer_id: kind === 'primer' ? prod.id : null,
        lot_code: c.lot || null, serial: c.serial || null, vendor: c.vendor || null,
        qty_purchased: qty,
        qty_remaining: Math.max(0, left ? left(c) : qty),
        unit: unitOf(c), cost_total: nn(c.cost) || 0,
      });
    }

    /* ---------------------------------------------------------- brass lots */
    for (const b of DB.brassLots || []) {
      if (!b.headstamp || !(nn(b.initialQty) > 0)) {
        blocked.push({ what: `brass ${b.serial}`,
                       why: 'a brass lot needs a headstamp and a starting case count' });
        continue;
      }
      add('brass_lots', {
        id: rid(b), serial: b.serial, cartridge: cartName(b.cartridge),
        headstamp: b.headstamp, maker: b.maker || null,
        marks: b.marks || {},
        origin: ['new', 'once-fired', 'range pickup', 'harvested'].includes(b.origin)
          ? b.origin : null,
        acquired_on: iso(b.acquired),
        qty_initial: nn(b.initialQty),
        // Derived locally from the cull log; the schema stores the figure.
        qty_on_hand: Math.max(0, nn(b.qty) ?? nn(b.initialQty)),
        firings: Math.max(0, Math.round(nn(b.firings) || 0)),
        expected_firings: Math.max(1, Math.round(nn(b.expectedFirings) || 6)),
        cost_total: nn(b.cost) || 0,
        last_anneal_on: iso(b.lastAnneal),
        retired: !!b.retired, notes: b.notes || null,
      });
    }

    /* ------------------------------------------------------------- recipes */
    const findProduct = (kind, name) => productOf.get(kind + '|' + norm(name)) || null;
    for (const r of DB.recipes || []) {
      const charge = nn(r.charge);
      if (!r.name || !r.cartridge || !(charge > 0)) {
        blocked.push({ what: `recipe ${r.name || '(unnamed)'}`,
                       why: 'a recipe needs a name, a cartridge and a charge weight' });
        continue;
      }
      // The schema refuses a recipe that cites no source and does not admit to
      // being self-developed. Bench requires the citation, so this only fires
      // on records written before that rule existed.
      if (!r.source) {
        blocked.push({ what: `recipe ${r.name}`,
                       why: 'needs a load-data source, or marking as self-developed' });
        continue;
      }
      const miss = [];
      const bp = findProduct('bullet', r.bullet), pw = findProduct('powder', r.powder),
            pr = findProduct('primer', r.primer);
      if (r.bullet && !bp) miss.push(`bullet "${r.bullet}"`);
      if (r.powder && !pw) miss.push(`powder "${r.powder}"`);
      if (r.primer && !pr) miss.push(`primer "${r.primer}"`);
      if (miss.length) {
        // Reported rather than invented. A recipe pointing at the wrong
        // component is worse than one that did not sync.
        blocked.push({ what: `recipe ${r.name}`,
          why: `no component lot matches ${miss.join(', ')} — record the lot, or fix the spelling` });
        continue;
      }
      add('recipes', {
        id: rid(r), name: r.name, cartridge: cartName(r.cartridge),
        bullet_id: bp?.id || null, powder_id: pw?.id || null, primer_id: pr?.id || null,
        charge_gr: charge, coal_in: nn(r.coal), cbto_in: nn(r.cbto),
        source_name: r.source, source_page: r.page || null,
        source_max_gr: nn(r.sourceMax), self_developed: false,
        status: 'workup', notes: r.notes || null,
      });
    }

    /* ------------------------------------------------------------- batches */
    const syncedRecipe = new Set(out.filter(x => x.table === 'recipes').map(x => x.row.id));
    for (const b of DB.batches || []) {
      const r = (DB.recipes || []).find(x => x.id === b.recipe);
      if (!r || !r.remote || !syncedRecipe.has(r.remote)) {
        blocked.push({ what: `batch ${b.serial}`,
                       why: 'its recipe could not sync, so the batch cannot either' });
        continue;
      }
      const lotRemote = (id) => {
        const l = (DB.componentLots || []).find(x => x.id === id);
        return l && l.remote ? l.remote : null;
      };
      const brass = (DB.brassLots || []).find(x => x.id === b.brassLot);
      add('batches', {
        id: rid(b), serial: b.serial, recipe_id: r.remote,
        brass_lot_id: brass?.remote || null,
        bullet_lot_id: lotRemote(b.bulletLot),
        powder_lot_id: lotRemote(b.powderLot),
        primer_lot_id: lotRemote(b.primerLot),
        loaded_on: iso(b.date) || iso(new Date().toISOString()),
        qty_loaded: Math.max(1, Math.round(nn(b.qty) || 1)),
        qty_remaining: Math.max(0, Math.round(nn(b.remaining) ?? nn(b.qty) ?? 0)),
        charge_actual_gr: nn(b.chargeActual), charge_sd_gr: nn(b.chargeSd),
        coal_mean_in: nn(b.coalMean), runout_in: nn(b.runout),
        press: b.press || null, storage: b.storage || null,
        quarantined: !!b.quarantine, quarantine_reason: b.quarantineReason || null,
        notes: b.notes || null,
      });
    }

    /* ------------------------------------------------------------ sessions */
    const syncedBatch = new Set(out.filter(x => x.table === 'batches').map(x => x.row.id));
    for (const s of DB.sessions || []) {
      const b = (DB.batches || []).find(x => x.id === s.batch);
      if (!b || !b.remote || !syncedBatch.has(b.remote)) {
        blocked.push({ what: `session on ${s.date}`,
                       why: 'its batch could not sync, so the session cannot either' });
        continue;
      }
      const fa = (DB.firearms || []).find(x => x.id === s.firearm);
      /* Chronograph SUMMARIES are written directly. The trigger that keeps a
       * session's velocity honest recomputes from the `shots` table, and only
       * fires when shots change — Bench records no per-shot string, so nothing
       * will overwrite these. Zero, which does record shots, writes its own
       * sessions and the trigger governs those. */
      add('range_sessions', {
        id: rid(s), batch_id: b.remote, firearm_id: fa?.remote || null,
        occurred_on: iso(s.date) || iso(new Date().toISOString()),
        temp_f: nn(s.temp),
        velocity_avg_fps: nn(s.vAvg), velocity_sd_fps: nn(s.vSd),
        velocity_es_fps: nn(s.vEs),
        velocity_n: nn(s.rounds),
        pressure_signs: s.pressureSigns || 'none',
        notes: s.notes || null, source_app: 'bench',
      });
      // A group needs at least two shots and a distance; a chronograph-only
      // session legitimately has neither.
      const g = nn(s.group), dist = nn(s.distance), n = Math.round(nn(s.rounds) || 0);
      if (g > 0 && dist > 0 && n >= 2) {
        add('groups', {
          id: rid(s, 'remoteGroup'), session_id: s.remote,
          distance_yd: dist, shot_count: n, group_es_in: g, source_app: 'bench',
        });
      }
    }

    return { rows: out, blocked };
  }

  /* Queue everything onto zero-core's outbox. The outbox already pushes in FK
   * order, retries, and dead-letters what the server refuses, so this layer
   * only has to get the mapping right. */
  function push(core, DB, left) {
    const { rows, blocked } = buildRows(DB, left);
    let queued = 0;
    const me = core.getUser && core.getUser();
    for (const { table, row } of rows) {
      if (table === 'profiles') {
        // profiles.id IS the auth user id; letting the outbox mint a random
        // one would write a row that RLS then refuses, forever.
        if (!me || !me.id) continue;
        core.upsert('profiles', { ...row, id: me.id });
        queued++;
        continue;
      }
      core.upsert(table, row);
      queued++;
    }
    return { queued, blocked };
  }

  return { buildRows, push, uuid };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BenchSync;
