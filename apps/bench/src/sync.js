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
  function buildRows(DB, left, roundsLeft) {
    const out = [];       // [{table, row, mark}] in FK-safe order
    const blocked = [];   // [{what, why}]
    /* `mark` is the local record to stamp as sent once the row is queued. Only
     * the two-way collection needs it; everything else passes nothing. */
    const add = (table, row, mark) => out.push({ table, row, mark });

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
      /* Firearms sync BOTH ways, so only what changed here since this device
       * last agreed with the server goes up. Pushing every firearm every time
       * is not just noise: push runs before pull, so an untouched local copy
       * would overwrite a newer edit made in Zero, and the pull would then
       * read the stale value back as though it were the truth. A record with
       * no syncedAt has never been up -- including one that came from an
       * import -- so it goes.
       *
       * Everything else in this file is push-only and has no such hazard: the
       * server cannot contradict it, so there is nothing to lose by re-sending
       * it and no local modification time to maintain. */
      const dirty = !f.remote || !f.syncedAt || Number(f.mtime || 0) > Number(f.syncedAt);
      if (!dirty) continue;
      add('firearms', {
        id: rid(f), name: f.name, cartridge: cartName(f.cartridge),
        barrel_in: nn(f.barrel), twist: f.twist || null,
        sight_height_in: nn(f.sightHeight), zero_range_yd: nn(f.zeroRange),
        notes: f.notes || null,
      }, f);
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
        trim_to_in: nn(b.trimTo), max_length_in: nn(b.maxLength),
        weight_sort: b.weightSort || null,
        anneal_every: b.annealEvery == null ? null : Math.max(0, Math.round(+b.annealEvery)),
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
        // Rounds left is derived in the app from sessions and adjustments;
        // there is no stored counter here to disagree with it.
        qty_remaining: Math.max(0, Math.round(roundsLeft ? roundsLeft(b) : (nn(b.qty) ?? 0))),
        charge_actual_gr: nn(b.chargeActual), charge_sd_gr: nn(b.chargeSd),
        coal_mean_in: nn(b.coalMean), cbto_mean_in: nn(b.cbtoMean),
        runout_in: nn(b.runout), bump_in: nn(b.bump),
        bushing: b.bushing || null, primer_depth_in: nn(b.primerDepth),
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
      /* Sessions are two-way now, so the same rule as firearms applies: only
       * what changed HERE since this device last agreed with the server. Push
       * runs before pull, so re-sending an untouched copy of a session that
       * came FROM Zero would overwrite Zero's richer row -- its shot count, its
       * group -- with Bench's narrower mapping, and the pull would then read
       * the damage back as truth. */
      const dirtyS = !s.remote || !s.syncedAt || Number(s.mtime || 0) > Number(s.syncedAt);
      if (!dirtyS) continue;
      const fa = (DB.firearms || []).find(x => x.id === s.firearm);
      /* Chronograph SUMMARIES are written directly. The trigger that keeps a
       * session's velocity honest recomputes from the `shots` table, and only
       * fires when shots change — Bench records no per-shot string, so nothing
       * will overwrite these. Zero, which does record shots, writes its own
       * sessions and the trigger governs those. */
      /* rounds_fired is the column that means what Bench's `rounds` means, and
       * it was being left null while the round count went into `velocity_n`.
       * Those are different quantities: velocity_n is how many readings the
       * chronograph took, which is zero on a session that had no chronograph
       * out. The consequence was that Bench's round usage never reached the
       * server at all -- so Zero could not see it, and neither could a second
       * device -- while a session with no velocity data claimed a sample size
       * equal to its round count. */
      const chrono = nn(s.vAvg) != null || nn(s.vSd) != null || nn(s.vEs) != null;
      add('range_sessions', {
        id: rid(s), batch_id: b.remote, firearm_id: fa?.remote || null,
        occurred_on: iso(s.date) || iso(new Date().toISOString()),
        rounds_fired: Math.max(0, Math.round(nn(s.rounds) || 0)),
        temp_f: nn(s.temp),
        velocity_avg_fps: nn(s.vAvg), velocity_sd_fps: nn(s.vSd),
        velocity_es_fps: nn(s.vEs),
        velocity_n: chrono ? Math.max(0, Math.round(nn(s.rounds) || 0)) : null,
        pressure_signs: s.pressureSigns || 'none',
        notes: s.notes || null, source_app: 'bench',
      }, s);
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
  function push(core, DB, left, roundsLeft) {
    const { rows, blocked } = buildRows(DB, left, roundsLeft);
    let queued = 0;
    const me = core.getUser && core.getUser();
    for (const { table, row, mark } of rows) {
      if (table === 'profiles') {
        // profiles.id IS the auth user id; letting the outbox mint a random
        // one would write a row that RLS then refuses, forever.
        if (!me || !me.id) continue;
        core.upsert('profiles', { ...row, id: me.id });
        queued++;
        continue;
      }
      core.upsert(table, row);
      /* Stamped at QUEUE time, like the remote id: the outbox is durable, so
       * queued means delivered unless the server refuses it -- and a refusal
       * is visible in the rejected list rather than silently re-pushing the
       * same row on every sync forever. The caller persists. */
      if (mark) mark.syncedAt = Date.now();
      queued++;
    }
    return { queued, blocked };
  }

  /* ========================================================================
   * The shared schema → BENCH.
   *
   * Push was one-way for a long time and it showed: a firearm entered in Zero
   * had to be entered again in Bench, with the same name, the same chambering
   * and a second chance to get one of them wrong. Two apps over one account
   * that make you type the same rifle twice are two apps, not one product.
   *
   * FIREARMS FIRST, and for now only firearms. It is the record both apps
   * genuinely own -- Bench needs it because a batch is fired from it, Zero
   * needs it because a group is attributed to it -- and it is small enough
   * that the mapping is honest in both directions. The rest of the schema is
   * not symmetric: a Bench component lot is two rows there, a recipe resolves
   * names to keys, and inventing a Bench lot from a purchase row would create
   * records the user never entered. Those stay push-only until each one has a
   * defensible inverse.
   *
   * WHY THIS DOES NOT CLOBBER: each app writes only the columns it owns, and
   * PostgREST updates only the columns present in the payload. Bench sends
   * barrel/twist/sight height/zero range; Zero sends barrel life and the
   * starting round count; neither sends the other's. Name, cartridge and notes
   * are shared, and there last write wins -- which is the honest answer for a
   * field two apps both edit and there is no third place to arbitrate.
   *
   * `helpers.ensureCartridge` is injected rather than reached for: Bench's
   * cartridges live in app.js, and a function in this file that silently
   * depends on load order is how the whole app once failed to boot.
   * ======================================================================*/
  /* A row this device pulled and could NOT place. Reporting it holds the pull
   * cursor short of it, so it is offered again next sync -- see commitCursor in
   * zero-core. Reporting nothing means "I took every row", which is what these
   * readers used to claim while quietly dropping rows on the floor. */
  const defer = (stat, row) => {
    if (row && row.updated_at) (stat.deferred = stat.deferred || []).push(row.updated_at);
  };

  function applyFirearms(DB, rows, helpers) {
    const stat = { added: 0, updated: 0, removed: 0 };
    if (!Array.isArray(rows) || !rows.length) return stat;
    DB.firearms = DB.firearms || [];

    for (const row of rows) {
      if (!row || !row.id) continue;
      const local = DB.firearms.find(f => f.remote === row.id) || null;

      /* A tombstone. Removing the local record is right -- it is the same
       * firearm, deleted deliberately on another device -- but only when
       * nothing here still points at it, because a session that loses its
       * firearm loses the attribution that made it worth recording. */
      if (row.deleted_at) {
        if (local) {
          const used = (DB.sessions || []).some(s => s.firearm === local.id);
          if (!used) {
            DB.firearms = DB.firearms.filter(f => f !== local);
            stat.removed++;
          } else {
            /* Held, not dropped: the sessions pinning it here may themselves be
             * deleted tomorrow, and a tombstone that has already been stepped
             * over leaves a rifle that was deleted on the other device standing
             * in this one forever, with no way to remove it. */
            defer(stat, row);
          }
        }
        continue;
      }

      if (!row.name) continue;                 // not representable; leave it alone
      const patch = {
        name: row.name,
        cartridge: helpers.ensureCartridge(row.cartridge) || (local ? local.cartridge : null),
        barrel: nn(row.barrel_in),
        twist: row.twist || '',
        sightHeight: nn(row.sight_height_in),
        zeroRange: nn(row.zero_range_yd),
        notes: row.notes || '',
      };

      if (local) {
        const before = JSON.stringify([local.name, local.cartridge, local.barrel,
          local.twist, local.sightHeight, local.zeroRange, local.notes]);
        Object.assign(local, patch);
        const after = JSON.stringify([local.name, local.cartridge, local.barrel,
          local.twist, local.sightHeight, local.zeroRange, local.notes]);
        if (before !== after) stat.updated++;
      } else {
        /* A local id is minted here, not taken from the remote row: every
         * other Bench record references firearms by the short local id, and
         * swapping the id scheme for imported rows would be a second kind of
         * key in the same collection. The remote id is kept in `remote`, which
         * is exactly what push already does for records created here. */
        DB.firearms.push(Object.assign({ id: helpers.uid('f'), remote: row.id }, patch));
        stat.added++;
      }
    }
    return stat;
  }

  /* The apply handler zero-core calls with each table's pulled rows. Unknown
   * tables are ignored rather than refused: the cursor only advances for a
   * sync that HAS a handler, and a handler that throws on a table it does not
   * know would abort every table after it. */
  /* Range sessions, coming BACK.
   *
   * Zero pushes a session for every string shot with a Bench-linked load, and
   * that row carries the one number Bench most wants and cannot derive: how
   * many rounds actually left the box. Bench had no reader for it, so a batch
   * shot forty times in Zero still showed a full box here, and the brass never
   * aged. Rounds fired and brass wear are both DERIVED from sessions in Bench,
   * so applying the session is all it takes to make both correct.
   *
   * Only sessions whose batch this device actually has are applied. A row about
   * a batch that is not here is not something to invent a local record for.
   */
  function applyRangeSessions(DB, rows, helpers) {
    const stat = { added: 0, updated: 0, removed: 0 };
    if (!Array.isArray(rows) || !rows.length) return stat;
    DB.sessions = DB.sessions || [];

    for (const row of rows) {
      if (!row || !row.id) continue;
      const local = DB.sessions.find(x => x.remote === row.id) || null;

      if (row.deleted_at) {
        if (local) { DB.sessions = DB.sessions.filter(x => x !== local); stat.removed++; }
        continue;
      }

      const batch = (DB.batches || []).find(b => b.remote === row.batch_id);
      /* Not a batch this device knows -- YET. Bench files every session under
       * the batch it was shot with; there is no other place to put one, and
       * inventing a batch from a session row would create a load record the
       * user never entered. So the row is held rather than discarded: the
       * batch may arrive from the other device on the next sync, and the
       * sessions that belong to it must still be on the near side of the
       * cursor when it does. */
      if (!batch) { defer(stat, row); continue; }
      const firearm = (DB.firearms || []).find(f => f.remote === row.firearm_id);

      const patch = {
        batch: batch.id,
        firearm: firearm ? firearm.id : (local ? local.firearm : null),
        date: (row.occurred_on || '').slice(0, 10) || (local ? local.date : null),
        /* rounds_fired is the honest column. velocity_n is how many readings a
         * chronograph took, which is not the same number and is null on a
         * session that had no chronograph out. */
        rounds: nn(row.rounds_fired) ?? (local ? local.rounds : null),
        temp: nn(row.temp_f),
        vAvg: nn(row.velocity_avg_fps), vSd: nn(row.velocity_sd_fps),
        vEs: nn(row.velocity_es_fps),
        pressureSigns: row.pressure_signs || 'none',
        notes: row.notes || '',
        /* The paper it was shot on, denormalised onto the session by the app
         * that shot it. Bench has no target library and should not grow one --
         * it is a loading bench. Without this a hole at (0.4,-1.1) cannot be
         * drawn anywhere meaningful. */
        targetName: row.target_name || null,
        targetFace: (row.target_face && Array.isArray(row.target_face.rings))
          ? row.target_face : null,
        /* Arrived from the server, so it is clean by definition: stamping it
         * as sent is what stops Bench pushing Zero's own session back with
         * Bench's narrower mapping on the very next sync. */
        mtime: 0, syncedAt: Date.now(),
      };

      if (local) {
        const before = JSON.stringify([local.rounds, local.date, local.batch, local.notes]);
        Object.assign(local, patch);
        if (before !== JSON.stringify([local.rounds, local.date, local.batch, local.notes])) stat.updated++;
      } else {
        DB.sessions.push(Object.assign({ id: helpers.uid('se'), remote: row.id }, patch));
        stat.added++;
      }
    }
    return stat;
  }

  /* A group carries the two things a session row does not: the distance it was
   * shot at, and how big the group was. Bench shows both on the batch. */
  function applyGroups(DB, rows) {
    const stat = { added: 0, updated: 0, removed: 0 };
    if (!Array.isArray(rows) || !rows.length) return stat;
    for (const row of rows) {
      if (!row || !row.session_id || row.deleted_at) continue;
      const s = (DB.sessions || []).find(x => x.remote === row.session_id);
      if (!s) { defer(stat, row); continue; }   // its session was held above
      const dist = nn(row.distance_yd), grp = nn(row.group_es_in);
      const before = [s.distance, s.group].join('|');
      if (dist != null) s.distance = dist;
      if (grp != null) s.group = grp;
      s.remoteGroup = row.id;
      if ([s.distance, s.group].join('|') !== before) stat.updated++;
    }
    return stat;
  }

  /* The string, one row per hole.
   *
   * Merged by remote id rather than replaced wholesale: rows arrive a page at
   * a time, so a session's shots can span two pulls and the second page must
   * not throw away the first. A tombstone removes the hole -- a shot the
   * shooter deleted in Zero that stayed here would be a hole in the paper that
   * is not in the barrel.
   *
   * Bench does not own any of this. It never writes a shot; the string belongs
   * to the app where the trigger was pulled. Bench reads it because a group
   * size on its own cannot tell you whether the load is inconsistent or the
   * wind call was. */
  function applyShots(DB, rows) {
    const stat = { added: 0, updated: 0, removed: 0 };
    if (!Array.isArray(rows) || !rows.length) return stat;

    for (const row of rows) {
      if (!row || !row.id || !row.session_id) continue;
      const s = (DB.sessions || []).find(x => x.remote === row.session_id);
      /* A session this device has not placed. The holes are held with it --
       * a string that arrives after its session has been stepped over is a
       * session that can never be plotted here. */
      if (!s) { defer(stat, row); continue; }
      s.shots = s.shots || [];
      const at = s.shots.findIndex(x => x.remote === row.id);

      if (row.deleted_at) {
        if (at >= 0) { s.shots.splice(at, 1); stat.removed++; }
        continue;
      }

      const shot = {
        remote: row.id,
        n: nn(row.shot_no),
        x: nn(row.poi_x_in), y: nn(row.poi_y_in),
        ring: row.ring == null ? null : String(row.ring),
        sighter: !!row.is_sighter,
        callX: nn(row.call_x_in), callY: nn(row.call_y_in),
        windMoa: nn(row.wind_call_moa),
        windDir: row.wind_call_dir === 'L' || row.wind_call_dir === 'R' ? row.wind_call_dir : null,
        v: nn(row.velocity_fps),
        excluded: !!row.excluded,
      };
      if (at >= 0) { s.shots[at] = shot; stat.updated++; }
      else { s.shots.push(shot); stat.added++; }
    }

    /* Ordered by shot number, because a string is a sequence: the second half
     * of a 20-shot string drifting off call is the thing worth seeing, and it
     * is invisible if the holes arrive in whatever order the server paged
     * them. */
    for (const s of DB.sessions || []) {
      if (s.shots) s.shots.sort((a, b) => (a.n || 0) - (b.n || 0));
    }
    return stat;
  }

  function applyPulled(DB, table, rows, helpers) {
    if (table === 'firearms') return applyFirearms(DB, rows, helpers);
    if (table === 'range_sessions') return applyRangeSessions(DB, rows, helpers);
    /* Groups are applied AFTER their sessions, which the table order in
     * zero-core already guarantees: range_sessions comes before groups. */
    if (table === 'groups') return applyGroups(DB, rows);
    /* Shots come after their sessions in zero-core's table order, so the
     * session a hole belongs to is already here by the time the hole is. */
    if (table === 'shots') return applyShots(DB, rows);
    return null;
  }

  return { buildRows, push, applyPulled, applyFirearms, applyShots, uuid };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BenchSync;
