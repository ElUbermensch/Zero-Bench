# Zero ↔ Bench — shared Supabase backend

**Status:** schema + leaderboard executed against PostgreSQL 16. **54 SQL assertions**
pass, including an adversarial two-user isolation suite and a negative control proving
the view guard is load-bearing. Clients wired: zero-core 60, Bench 53, Zero↔Bench
21, leaderboard two-user 16.

---

## TL;DR

One Postgres database, one account, two PWAs. Both talk to PostgREST directly, so the
same-origin problem disappears — they never touch each other's storage, they touch the
same tables.

- **Zero reads `v_ballistic_profiles`** to list selectable loads when you're picking a
  bullet. One row per live batch, carrying bullet BC, muzzle velocity and its spread,
  firearm geometry, and Bench's safety flags.
- **Zero writes `range_sessions`, `shots`, `groups`, `dope_entries`.**
- **Bench reads `v_batch_performance`** to answer "which load actually shot best",
  and reads the same `range_sessions` rows to clear its untested flag.

Files: `migrations/0001_init.sql` (the migration), `test/harness.sql` (local stand-in
for Supabase's `auth` schema — do not deploy), `test/rls_test.sql`, `run_tests.sh`.

---

## 1. The thing that will bite you

Both apps ship the **anon key in the client bundle**. It is public by design; anyone
who opens devtools has it. Row level security is therefore not a hardening measure
here, it is the entire access control system.

Three rules, all enforced in the migration:

1. **Every table has RLS enabled and forced**, scoped to `auth.uid()`. A table added
   later without RLS is world-readable to anyone who has ever loaded either app.
2. **Every view is `security_invoker = true`.** A Postgres view runs with its *owner's*
   privileges by default and silently bypasses RLS on its base tables. The negative
   control in the test suite demonstrates this: the same view definition without the
   flag returns every user's rows to every user.
3. **The `service_role` key never goes in a PWA.** It bypasses RLS entirely. It belongs
   in Edge Functions or nothing.

---

## 2. What Zero reads: `v_ballistic_profiles`

One row per live batch. Zero should list these when the user picks a load.

| Column | Type | Note |
|---|---|---|
| `batch_id` | uuid | join key for everything else |
| `serial` | text | `B26H13-01D` — what's in the box QR |
| `cartridge`, `load_name` | text | display |
| `bullet_name`, `bullet_weight_gr`, `diameter_in`, `bullet_length_in` | | |
| `bc_g1`, `bc_g7` | numeric | prefer G7 for modern boat-tails |
| `coal_mean_in`, `cbto_in` | numeric | as actually loaded, not the recipe target |
| `muzzle_velocity_fps` | numeric | from the most recent session that has one |
| `velocity_sd_fps` | numeric | **this is what drives vertical dispersion** |
| `velocity_es_fps` | numeric | max − min, for display |
| `velocity_n` | int | shots behind those statistics |
| `velocity_es_sigma_fps` | numeric | ES normalised to a comparable σ — see §4 |
| `velocity_temp_f`, `velocity_measured_on` | | correct for powder temp sensitivity |
| `firearm_id`, `firearm_name`, `barrel_in`, `twist` | | |
| `sight_height_in`, `zero_range_yd` | numeric | Zero needs both for a solution |
| `qty_remaining` | int | don't offer a load you're out of |
| `quarantined` | bool | **refuse to build a solution; Bench pulled this ammo** |
| `untested` | bool | no chronograph data — velocity is null or assumed |
| `over_published_max` | bool | charge exceeds the cited manual maximum |
| `recipe_status` | text | `workup` / `proven` / `retired` |
| `powder_name`, `charge_gr`, `charge_actual_gr`, `charge_sd_gr` | | the recipe target and what was **actually weighed** — prefer the actual |
| `primer_name`, `powder_temp_stable` | | |
| `source_name`, `source_edition`, `source_page`, `source_max_gr`, `self_developed` | | the load-data citation; a charge without its source is not something to hand a solver |
| `quarantine_reason` | text | why it was pulled, so Zero can say so rather than just refusing |
| `qty_loaded`, `recipe_id` | | |

```js
const { data } = await supabase
  .from('v_ballistic_profiles')
  .select('*')
  .eq('quarantined', false)
  .gt('qty_remaining', 0)
  .order('loaded_on', { ascending: false });
```

Scanning the box QR gives you the serial directly:

```js
const { data } = await supabase
  .from('v_ballistic_profiles').select('*').eq('serial', scanned).single();
```

**Zero should hard-refuse on `quarantined`.** That flag exists because Bench decided the
ammunition shouldn't be fired; a ballistic solution for it is worse than useless.

Zero's implementation of that is worth stating precisely, because the obvious version is
wrong in two directions:

- A linked load keeps a **structured snapshot** of this view, refreshed on every sync and
  on demand — not a copy frozen at import. A batch quarantined on the bench three weeks
  after Zero imported it must stop being selectable, and it cannot if Zero is reading a
  boolean it cached once.
- Quarantining **does not delete or hide the load**, and does not touch sessions already
  shot with it. Quarantining after the fact is exactly how you discover a batch was bad;
  removing it from the record destroys the evidence that would tell you. The load stays
  visible, marked, with its reason — and is refused only as the ammunition for *new*
  work.

`untested` and `over_published_max` warrant a visible warning rather than a refusal.

---

## 3. What Zero writes

A shooting session is one `range_sessions` row plus its children.

```js
const { data: session } = await supabase.from('range_sessions').insert({
  id: crypto.randomUUID(),          // client-generated: works offline
  batch_id, firearm_id,
  occurred_on: '2026-08-13',
  temp_f: 86, humidity_pct: 24, pressure_inhg: 29.92, altitude_ft: 1100,
  source_app: 'zero',
}).select().single();

// per-shot velocities — do NOT also send the summary
await supabase.from('shots').insert(
  velocities.map((v, i) => ({ session_id: session.id, shot_no: i + 1, velocity_fps: v }))
);

// group dispersion, in INCHES
await supabase.from('groups').insert({
  session_id: session.id, distance_yd: 100, shot_count: 5,
  group_es_in: 0.42, mean_radius_in: 0.16, source_app: 'zero',
});
```

**Don't write `velocity_avg_fps` / `velocity_sd_fps` / `velocity_es_fps` yourself.** A
trigger recomputes them from `shots` on every insert, update and delete, so a
hand-written summary would just be overwritten — and could disagree with the underlying
data in the meantime. Write the shot string; the database does the statistics.

Mark a flyer with `shots.excluded = true` rather than deleting it. It drops out of the
statistics and stays in the record. (Verified: excluding one shot of five moved n from
5→4 and ES from 20→15 while all five rows remained.)

---

## 4. "ES" means two different things — name them apart

This is the single most likely source of a silent bug between these two apps, so the
schema refuses to let them share a name:

- `range_sessions.velocity_es_fps` — **muzzle velocity** extreme spread, in fps.
- `groups.group_es_in` — **group size**, widest centre-to-centre, in inches.

And a statistical point worth building around rather than papering over. Extreme spread
is `max − min`, so it is a function of how many shots you fired: its expected value is
`d₂(n)·σ`, and d₂ grows monotonically — 2.326 at 5 shots, 3.078 at 10, 3.735 at 20. A
20-shot string will read a larger ES than a 5-shot string **from identical
ammunition**. Comparing raw ES between strings of different length is meaningless.

`es_to_sigma(es, n)` divides it back out, so `velocity_es_sigma_fps` *is* comparable
across string lengths. The test suite pins the equivalence: 20 fps over 5 shots and
26.5 fps over 10 shots both come back at ≈8.6.

SD is the better statistic and is what should drive Zero's vertical dispersion band.
Show ES because it's the number shooters quote; compute with SD.

MOA in `v_batch_performance` uses the true minute of angle, 1.047 in per 100 yd — not
the 1.000 shorthand. At 1000 yd that shorthand is a 4.7% error.

---

## 5. What Bench reads back: `v_batch_performance`

| Column | Note |
|---|---|
| `batch_id`, `serial` | |
| `session_count`, `group_count` | |
| `best_group_in`, `avg_group_in` | inches |
| `best_group_moa`, `avg_group_moa` | true MOA |
| `avg_mean_radius_in` | better dispersion metric than extreme spread |
| `last_fired_on` | |

Mean radius is a materially better group statistic than extreme spread for the same
reason as velocity ES: extreme spread uses two shots and throws the rest away, so it
has high variance and grows with shot count. If Zero can compute mean radius from
impact coordinates, prefer it.

---

## 6. Sync model

Supabase has no first-party offline sync; the ecosystem answers are PowerSync, RxDB and
WatermelonDB, all of which are heavy for a single-user app. Both apps therefore
hand-roll it, and the schema is built for that:

- **Client-generated UUID primary keys** — a create works with no network and needs no
  round trip to get an id.
- **`updated_at`** stamped by a server-side trigger, never by the client. Phone clocks
  drift and a device that is offline for a day would otherwise win every conflict.
  Reconciliation is last-write-wins on this column.
- **`deleted_at` soft deletes.** A hard `DELETE` is invisible to a device that was
  offline when it happened — it would resurrect the row on next push. Views filter
  `deleted_at is null`; sync pulls include them so the tombstone propagates.
- **`(user_id, updated_at desc)` index on every table** — incremental pull is
  `select * from t where updated_at > :last_sync`.
- **`source_app`** on `range_sessions` and `groups` records which app wrote the row.

Serial uniqueness is `(user_id, serial)` where `deleted_at is null` — two accounts may
hold the same serial, one account may not.

---

## 7. Deploying

```bash
supabase db push          # or paste 0001_init.sql into the SQL editor
```

Do **not** deploy `test/harness.sql`. It stubs `auth.users` and `auth.uid()` so the
migration can be tested in vanilla Postgres; Supabase provides both.

To re-run the suite locally:

```bash
./run_tests.sh
```

It drops and rebuilds the database from the migration every time, so a green run also
proves the migration applies cleanly from nothing.

---

## 8. Still open

- **I haven't seen Zero's code.** Everything above is the contract from the database
  side. Wiring Zero's bullet picker to `v_ballistic_profiles` needs its data model in
  front of me — send the file or a repo URL.
- **Cartridge reference data** is still free text (`batches.cartridge` etc.) pending
  confirmation of which cartridges you actually load.
- **Auth method** — email + password vs magic link. Magic link avoids a password but
  needs mail delivery configured; password works offline-ish because the refresh token
  is cached. I lean password for a range-side app on bad signal.


---

## 9. Shared deployment and the leaderboard (migration 0002)

Every install points at **one** Supabase project with **one** anon key, baked into
`SHARED_SUPABASE` at the top of each app. That key is public by design and grants
nothing on its own — RLS is the access control. The `service_role` key never ships.

`0001` is private-per-user throughout. `0002` adds the one deliberate exception:

| Table | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| everything in 0001 | `auth.uid() = user_id` | `auth.uid() = user_id` |
| `leaderboard_profiles` | **`true`** | `auth.uid() = id` |
| `leaderboard_entries` | **`true`** | `auth.uid() = user_id` |

**That asymmetry is the whole feature**, and it is verified in both directions: B can
read A's entry, and B cannot rewrite A's score, delete A's entry, rename A, or plant an
entry under A's account. Crucially, the same suite re-checks that opening the
leaderboard changed *nothing* for the private tables.

**Publishing is explicit.** Nothing reaches `leaderboard_entries` except by tapping
publish on a specific session. Handles are the only identity other shooters see —
3–24 chars, case-insensitively unique, so `JAXON` cannot squat on `Jaxon`.

**Ranking is per class.** Score across different positions, distances and shot counts
is not comparable, so the leaderboard filters on `(position, distance_yd)` and ranks by
score → X count → mean radius. Indexed on exactly that triple.

**What the constraints can and cannot do.** `score <= shot_count * 10` and
`x_count <= shot_count` reject the *implausible*; nothing in a schema can make a
self-reported score *true*. This is a scoreboard among people who know each other. The
app says so on the card rather than implying verification it doesn't have.

**Retraction** is a soft delete: the entry leaves the board for every viewer while the
row survives for sync.

### One client-side consequence worth knowing

Adding a table the server can legitimately *refuse* (a taken handle, an implausible
score, someone else's row) exposed a flaw in the sync layer: a rejected write sat in the
outbox forever, and since a failed push aborts the whole sync, **one poisoned row
permanently blocked every other pending write from ever leaving the device.**

`zero-core` now dead-letters 4xx rejections — they will never succeed, so it drops them
from the queue, surfaces them via `outbox:rejected` and `rejectedList()`, and lets the
sync continue. 5xx and network failures are still retried, because those are transient.
Tested by queueing a doomed write alongside a legitimate one and asserting the
legitimate one still lands.
