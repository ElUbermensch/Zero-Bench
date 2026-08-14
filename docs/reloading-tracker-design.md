# Reloading Batch Tracker — Design Concept

**Status:** rev 3 — prototype built, awaiting feedback.
**Date:** 2026-08-13

*Rev 3 changes: brass is identified by **coloured bands on the case body**, not a
written code (§4.1–4.2) — the photographs showed two painted bands, one toward the
neck and one toward the head. Check character switched from Damm to a weighted mod-31
checksum, which is simpler and strictly stronger (§4.3). Component-lot prefix changed
from `L` to `C` because `L` is not in the alphabet. A working phone web app now exists
for testing; the Python build follows once the workflow is validated.*

---

## TL;DR

A local Python web application backed by a single SQLite file. You run one command on
your desktop; it serves a web UI to that machine and to your phone over your home
network. Every batch of loaded ammunition, every brass lot, and (optionally) every
individual case gets a short serial. The app prints label sheets carrying a QR code
plus that human-readable serial. Scanning the QR with your phone's stock camera app
opens that record's page directly. Typing the serial into the lookup box does the same
thing, so the system degrades gracefully to pen and paper.

The database is the product. The web UI is a convenience wrapper over it, and it lives
in one file you can copy to a thumb drive.

**Confidence this is the right architecture given your constraints: ~90%.** The one
real design risk is phone-to-desktop reachability, addressed in §6.

---

## 1. Confirmed decisions

| Decision | Choice |
|---|---|
| Platform | Python + SQLite desktop app |
| Identification | QR code **and** human-readable serial on every label |
| Granularity | Ammo batches + brass lots + individual cases |
| Data depth | Full record, cost accounting, safety flags |
| Brass marking | Two painted colour bands on the case body |
| Label stock | Plain paper, cut and taped or slipped into the box |
| Serials | Semantic batch serial + check character; brass keyed by colour |
| Chronograph | None yet (Garmin planned) → manual entry for v1 |

---

## 2. Architecture

```
┌─ Desktop (your PC) ──────────────────────────────┐
│                                                  │
│  python -m reloading                             │
│      │                                           │
│      ├── FastAPI + Uvicorn (binds 0.0.0.0:8737)  │
│      ├── Jinja2 server-rendered HTML + htmx      │
│      ├── segno  → QR SVGs                        │
│      └── sqlite3 → reloading.db  (WAL mode)      │
│                                                  │
└──────────────┬───────────────────────────────────┘
               │ home LAN
        ┌──────┴──────┐
        │  Your phone │  stock camera → QR → record page
        └─────────────┘
```

### Stack choices and what was rejected

**FastAPI + Uvicorn + Jinja2 + htmx.** Server-rendered HTML with htmx for partial
updates. No JavaScript build step, no npm, no bundler. Pages print correctly because
they are plain HTML with a print stylesheet.

- *Rejected: Tkinter/PyQt desktop GUI.* Would work on the desktop but gives you nothing
  on the phone, and printing is painful. Your QR requirement effectively mandates a
  browser somewhere.
- *Rejected: React/Vue SPA front end.* Adds a Node toolchain, a build step, and a
  second thing to keep working in five years. Nothing here needs client-side state
  beyond what htmx handles.
- *Rejected: Flask.* Perfectly viable and slightly lighter. FastAPI wins on Pydantic
  validation, which matters when the input is charge weights.

**SQLite, accessed through stdlib `sqlite3` with hand-written SQL and a thin row-mapping
layer.** Foreign keys enforced (`PRAGMA foreign_keys=ON`), WAL journaling, schema
versioned via `PRAGMA user_version` with a linear migration stepper.

- *Rejected: SQLAlchemy ORM.* The schema is ~15 tables with heavy reporting queries.
  An ORM buys little and obscures the SQL you'd want to read when the analytics get
  interesting. Pydantic covers the validation an ORM would otherwise justify.
- *Rejected: Postgres.* Single user, single machine. A server process is pure overhead,
  and "the database is one file I can copy" is a real feature for records you may want
  to keep for decades.

**Dependencies, total:** `fastapi`, `uvicorn`, `jinja2`, `pydantic`, `segno`,
`python-multipart`, and optionally `zeroconf`. Everything else is stdlib. Python 3.11+.

**Backups.** Timestamped copy via the `sqlite3` online-backup API on startup and on
demand, keeping the last N. Plus full JSON and per-table CSV export, so you are never
locked into this app.

---

## 3. Data model

Fifteen tables in five groups. Naming is descriptive rather than final.

### 3.1 Reference

**`cartridge`** — 308 Winchester, 6.5 Creedmoor, etc. Max COAL, max case length,
trim-to length, bullet diameter, default primer size. Gives you validation targets
and sane form defaults rather than free-text chaos.

**`firearm`** — name, cartridge, barrel length, twist rate, chamber spec, freebore,
serial, notes, baseline round count.

**`firearm_throat_measurement`** — `(firearm_id, date, cbto_at_lands, round_count)`.
Throats erode. Recording jam length over barrel life is what lets the app compute
*jump* correctly for a batch instead of assuming a number you measured two thousand
rounds ago. This is a small table that pays for itself.

### 3.2 Components

Products are separated from lots. A *product* is "Hornady 140gr ELD-M". A *lot* is
"the box of them I bought in March for $58".

**`bullet_product`** — mfr, model, weight (gr), diameter, G1 BC, G7 BC, construction,
SKU.
**`powder_product`** — mfr, name, type (ball/extruded/flake), temperature-stable flag,
relative burn rate, notes.
**`primer_product`** — mfr, model, size (SR/LR/SP/LP + magnum variants), match flag.
**`brass_product`** — mfr, headstamp, cartridge, primer pocket size, nominal weight.

**`component_lot`** — one unified table covering bullet/powder/primer lots:
lot code, vendor, purchase date, quantity purchased, unit, total cost, quantity
remaining, storage location, notes.

- *Trade-off, flagged:* this is a polymorphic reference (`product_type` +
  `product_id`), so SQLite cannot enforce the foreign key natively. Mitigated with a
  `CHECK` constraint on `product_type` plus validation triggers. The alternative —
  three near-identical lot tables — would give real FKs but triples the inventory and
  cost logic. I judge the unified table the better trade at this scale (~75%
  confidence; happy to flip it if you'd rather have hard FKs).

Brass does **not** use `component_lot`. It gets its own lifecycle, below.

### 3.3 Brass lifecycle

**`brass_lot`** — the central object for anything reusable.

- Identity: serial, brass product, cartridge, headstamp, origin (new / once-fired /
  range pickup / harvested from batch X), acquisition date and cost.
- Counts: initial qty, current qty, firings on the lot.
- Prep state: last trim date + length, last anneal date + firings-since, neck-turned,
  pocket uniformed, flash hole deburred, sizing type (full-length / bushing / neck),
  bushing size, shoulder bump in thousandths.
- Sorting: mean and SD of case weight, if you weight-sort.
- Lifecycle: expected firings (drives cost amortization), retired flag, retire reason.
- `track_individual` flag — see below.

**`brass_event`** — the audit trail, and the part that makes the whole thing
trustworthy. One row per thing that happens to a lot: `acquired`, `loaded`, `fired`,
`tumbled`, `annealed`, `sized`, `trimmed`, `pocket_uniformed`, `neck_turned`,
`culled`, `retired`. Each row carries date, quantity before/after, firing count after,
and notes. Firing count is *derived* from this log rather than being a mutable
counter, which means it can never silently drift.

**`case`** and **`case_event`** — individual case tracking, populated only when
`brass_lot.track_individual = 1`. Same event model, one level down. Kept behind a flag
so the 95% of your brass that doesn't need it doesn't drown the UI. Realistically this
is for a competition set of 50–100 cases.

### 3.4 Loads and batches

**`recipe`** — a load *specification*, independent of any particular loading session.

- Components by *product* (not lot): bullet, powder, primer, brass.
- Charge: target weight, plus the min/max of the working range.
- Seating: COAL, CBTO, and computed jump against a firearm's measured lands.
- Neck tension / bushing size, crimp type and die, sizing method, shoulder bump.
- **Source citation: manual name, edition, page, and the manual's listed max charge.**
  Mandatory. See §7.
- Status: `workup` / `proven` / `retired`. Intended firearm. Notes.

**`batch`** — an actual loading session. This is the thing that gets the printed serial.

- Serial, recipe, date loaded, quantity loaded, quantity remaining.
- **The specific lots consumed:** bullet lot, powder lot, primer lot, brass lot. This
  is the entire point of the system — the recipe says "H4350", the batch says
  "H4350 lot 8934-11", and when that lot turns out to be fast you can find every round
  you built with it.
- Charge QC: target, measured mean, measured SD, scale used, thrown vs. trickled vs.
  every-charge-weighed.
- Dimensional QC: measured COAL/CBTO mean and spread, concentricity (TIR) mean/max,
  loaded round weight sample.
- Setup: press, die set, seating die, shell holder.
- Environment: temperature, humidity, altitude at loading.
- Safety: over-max flag (computed), untested flag (auto-cleared by first range
  session), quarantine/hold flag, observed pressure signs.
- Cost per round (computed, §8). Storage location. Disposition notes.

### 3.5 Results

**`range_session`** — date, batch, firearm, location, distance, rounds fired,
conditions (temp, humidity, pressure, altitude, wind), chronograph model, velocity
summary (avg / SD / ES / min / max / n), group results, observed pressure signs, notes.

**`shot`** — `(session_id, shot_no, velocity, poi_x, poi_y)`. Per-shot data. Optional
per session, but having it means SD is computed rather than transcribed, and it makes
charge-ladder and seating-depth analysis real instead of anecdotal.

**Chronograph import is deferred.** You don't have a chronograph yet, so v1 ships
manual entry only: type in avg / SD / ES / shot count, or paste a column of per-shot
velocities into a textarea and the app parses and computes the statistics. The
importer *interface* gets built now (a small adapter protocol plus the paste path),
so when the Garmin Xero arrives the adapter is maybe thirty minutes of work — but I'd
want one real export file from your unit first. Writing a parser against a format I
can only read about is how you get a parser that silently drops the first row.

---

## 4. Serial and label design

### 4.1 Brass is identified by colour, not by writing

The photographs settle it: the marking is two painted bands on the **case body** — one
up toward the neck/shoulder, one down toward the head — not characters on the case
head. That changes the identification model entirely. There is nothing to read and
type; there is a colour combination to *match*. So the app's primary brass lookup is a
picture of a case with tappable colour swatches, and the answer appears as you tap.

A brass lot still carries a serial (`R-3CK`) because the database needs a stable key
and the lot tag needs something printable, but that serial is never written on a case.

**Two things worth flagging about marking the body rather than the head.** Paint there
sits inside the chamber when the round fires, and it gets wiped by the sizing die on
every resize — so expect these marks to need refreshing, and expect the head-end band
(which the die grips hardest) to fade first. Marks on the case head would survive
sizing untouched. Your system evidently works, so this is an observation, not a
recommendation; the app compensates by letting you mark a worn position "unknown"
during lookup instead of forcing a guess.

### 4.2 Capacity, and why blanks matter

With P positions and C enabled colours, capacity is `C^P`, or `(C+1)^P − 1` if an
unmarked position counts as a valid state. The defaults — 2 positions, 4 colours,
blanks allowed — give **24 codes**. Enabling all eight colours gives 80. The app shows
this live in Settings and refuses to issue a duplicate combination, because a collision
discovered at the bench is a collision discovered too late.

Treating blank as data is the tempting way to get more codes, and it is also the
riskiest one: a mark that wears off silently becomes a different valid code. That's why
it's a switch rather than a default assumption.

| Entity | Format | Example | Where it lives |
|---|---|---|---|
| Batch | `B` + YY + month + DD + `-` + seq + check | `B26H13-01D` | Printed box label |
| Brass lot | `R-` + 2 data + check | `R-3CK` | Bin tag — colour is on the case |
| Case | brass serial + `/` + 2 digits | `R-3CK/14` | Case head, if numbered |
| Component lot | `C-` + 2 data + check | `C-9M4` | Shelf tag |

Month letters run `A`–`H`, `J`, `K`, `M`, `N` — no `I` or `L`, because neither is in the
alphabet. August is `H`. The prefix letter is part of the checksummed body, so it must
be an alphabet symbol too; `L` for "lot" was the obvious choice and is exactly the one
that doesn't work.

### 4.3 The check character

Serials use **Crockford base32 minus `Z`, giving 31 symbols**. 31 is prime, so weighted
sums live in the field ℤ/31, and that buys a two-line proof. Data characters carry
weights 2, 3, 4, …; the check character carries weight 1, so all weights are distinct
and non-zero.

- A single-character error shifts the sum by `wᵢ·Δ`, which is non-zero in a field when
  both factors are non-zero. **Every single-character substitution is detected.**
- A transposition of positions i and j shifts the sum by `(wᵢ − wⱼ)(dᵢ − dⱼ)`, non-zero
  whenever the weights and the digits differ. **Every transposition is detected — at
  any distance, not just adjacent ones.**

Both properties are verified by brute force over the actual serial spaces, not merely
argued: 115,320 substitutions and 5,580 transpositions on the brass space, 81,000 and
10,365 on a sample of the batch space, all detected.

- *Changed from rev 2, which specified the Damm algorithm.* Damm needs a totally
  anti-symmetric quasigroup of order 32, which has to be found by search and embedded
  as a 1 KB table, and it only guarantees **adjacent** transpositions. The mod-31
  scheme is a handful of lines, needs no table, and catches strictly more errors. The
  cost is one alphabet symbol: 961 brass serials instead of 1,024. Irrelevant.

### 4.4 QR payload

Each QR encodes a URL: `http://reloader.local:8737/s/B26H13-04K`

Scanning with the stock camera app opens that record. The `/s/{serial}` route is
type-dispatching — it looks at the prefix and routes to the batch, brass lot, case, or
component lot page. The same route backs the manual lookup box, so typing and scanning
are literally the same code path.

Base URL is configurable, so if you later move to Tailscale or a static IP you reprint
nothing that matters — the serial is still printed in plain text underneath.

### 4.5 Printables

Plain paper, cut and taped or slipped under the box lid. This is a genuine
simplification: no adhesive stock means no Avery grid to hit within a millimeter, and
no printer-margin calibration page. Cut lines have tolerance that label die-cuts do not.

1. **Box label**, default 2.5″ × 1.5″ to sit in an MTM Case-Gard lid recess: cartridge,
   bullet and charge, serial, QR, load date, quantity, and a heavy `UNTESTED — WORK UP`
   or `DO NOT FIRE — QUARANTINED` band when those flags are set. Crop marks on all
   four corners.
2. **Label sheet** — 8-up on US Letter with cut guides, so a loading session's worth of
   labels comes off one page. Sizes are configurable; the layout is CSS grid, so
   changing dimensions is a config edit, not a rewrite.
3. **Batch data sheet** — one full page per batch, the entire record, QR in the corner.
   For a binder.
4. **Brass lot tag** — for the bin or bag: headstamp, firings, prep state, last anneal
   date, quantity, the 3-character head mark in large type, and a QR.

Everything renders as HTML with a print stylesheet. Print-to-PDF works identically, so
you can archive labels or print them somewhere else.

---

## 5. Screens

- **Dashboard** — untested batches, quarantined batches, components running low, brass
  lots due for annealing or trimming, recent sessions.
- **Lookup** — one big serial box, front and center.
- **Load session wizard** — the batch entry flow, ordered the way you actually work:
  pick recipe → confirm component lots → enter counts and charge QC → print label.
  Designed for entry on a phone at the bench.
- **Recipes** — list, detail, clone-and-modify (the ladder workflow).
- **Brass** — lots, event log, individual cases where enabled.
- **Inventory** — component lots, quantity remaining, cost, months-of-supply.
- **Firearms** — including throat measurement history.
- **Range** — sessions, per-shot data, charts.
- **Reports** — §9.
- **Print** — label queue and sheet builder.

---

## 6. Phone access — the one real technical risk

**Problem:** browser camera access (`getUserMedia`) requires a secure context. Over
plain HTTP on a LAN address, an in-page QR scanner will not work on your phone. Many
projects hit this and bolt on self-signed certificates, which then produce browser
warnings forever.

**Solution:** don't build an in-app scanner. Because the QR encodes a URL, your
phone's *native* camera app scans it and opens the link. Native camera has no secure
context requirement. This is simpler and more reliable than anything in-browser.

**Secondary problem:** your desktop's LAN IP can change, which would break every
previously printed QR.

**Mitigations, in order of preference:**

1. **mDNS** — the app advertises `reloader.local` via `zeroconf`. iOS handles this
   well; Android 12+ does too. Confidence it works on your phone: ~85%.
2. **DHCP reservation** on your router pinning the desktop's IP. Bulletproof, five
   minutes of setup, requires touching the router.
3. **Tailscale** — works away from home too, e.g. at the range. Overkill unless you
   want it.

Regardless of which, the human-readable serial is printed below the QR, so a failed
scan costs you nine keystrokes rather than the record.

**Security note:** the app binds to your LAN with no authentication by default. That is
appropriate for a home network and inappropriate for anything else. Do not port-forward
it. An optional shared-token mode is cheap to add if you want it.

---

## 7. Safety model

This application is a **record keeper**. It will never suggest, recommend, extrapolate,
or interpolate a powder charge, and it will not ship with any load data. That is a hard
design boundary, not a disclaimer.

What it *does* enforce:

- **Mandatory source citation on every recipe** — manual, edition, page, and that
  source's listed maximum charge. A recipe can alternatively be marked
  "self-developed, no published source," but that requires an explicit acknowledgment
  rather than leaving the field blank.
- **Percent-of-max computed and displayed** on every recipe and batch view. Anything
  at or over the cited maximum renders in red and prints an over-max marker on the
  label.
- **Untested until proven.** A batch with no linked range session is flagged
  `UNTESTED` on screen and on its printed label.
- **Quarantine.** Any batch can be flagged hold/do-not-fire with a reason. Its page and
  label both show it unmissably. Survives everything.
- **Pressure sign logging** per range session (none / flattened primers / ejector mark
  / stiff bolt lift / case head expansion / cratered primers), and recording any of
  them flags the recipe for review.
- **Component mismatch warnings** — small-primer brass with a large-primer lot,
  pistol primers in a rifle recipe, bullet diameter against cartridge, COAL over the
  cartridge maximum. Warnings, not blocks; you may have a reason.

---

## 8. Cost model

Per-round cost is computed from the lots actually consumed:

```
bullet   = lot_cost / lot_qty
primer   = lot_cost / lot_qty
powder   = (lot_cost / (lot_lbs × 7000)) × charge_grains
brass    = lot_cost / (lot_qty × expected_firings)      [amortized]
overhead = configurable flat per-round (media, lube, gas checks)
```

Brass is the interesting one. Default is amortization over `expected_firings`, with a
toggle to compute against *actual* firings to date, which gives you a cost figure that
falls every time you reload the same lot. Both views are useful; both will be
available.

Outputs: cost per round and per batch, cost per range session, cost per cartridge over
time, and factory-ammo comparison if you enter a reference price.

---

## 9. Analytics

Descriptive only — the app plots what happened, it does not tell you what to load.

- **Charge ladder** — velocity vs. charge weight from a series of batches sharing a
  recipe lineage.
- **Seating depth vs. group size** — same idea on the CBTO axis.
- **SD and ES trends by powder lot** — catches lot-to-lot variance, which is the single
  most common cause of "my proven load stopped working."
- **Velocity vs. temperature** — your powder's actual temperature sensitivity, from
  your data, in your barrel.
- **Brass survival curve** — firings-to-failure by headstamp and by prep regimen. Tells
  you whether annealing is earning its keep.
- **Barrel round count vs. velocity** — throat erosion tracking.
- **Component burn rate** — months of supply remaining at your current pace.

Charts render as inline SVG generated server-side. No charting library, no CDN, prints
correctly.

---

## 10. Build plan

```
reloading/
  __main__.py          # launcher: migrate, backup, advertise mDNS, serve
  config.py            # config.toml loading
  db/
    schema.sql
    migrations/        # 001_initial.sql, ...
    connection.py      # WAL, FKs, row factory, backup API
  models.py            # Pydantic models
  serials.py           # generation, Crockford base32, Damm check char, parsing
  labels.py            # QR (segno), label layouts, cut-sheet geometry
  cost.py
  analytics.py
  routes/              # dashboard, lookup, batches, recipes, brass, components,
                       #   firearms, sessions, reports, print
  templates/
  static/              # style.css, print.css, htmx.min.js (vendored)
  importers/           # adapter protocol + paste-a-column parser
                       #   (Garmin Xero adapter added once a real export exists)
  exporters/           # JSON + CSV
tests/                 # pytest: exhaustive check-character verification, serial
                       #   round-tripping, cost math, brass firing derivation from
                       #   the event log, safety flag propagation, label geometry
requirements.txt
README.md
seed_demo.py           # sample data so you can click around before entering real data
```

Suggested build order: schema → serials → core CRUD → labels/printing → range and
analytics → importers → polish. Roughly six work chunks; I'd deliver and let you test
after each.

---

## 11. Non-goals

Stated explicitly so scope stays honest:

- No load data, no charge recommendations, no pressure modeling, no QuickLOAD-style
  internal ballistics.
- No cloud sync, no accounts, no multi-user.
- No ballistic solver / dope card generation. (Adjacent and tempting. Separate project.)
- No inventory *purchasing* workflow beyond recording what you bought.
- No mobile app. The web UI is responsive; that's the extent of it.

---

## 12. Assumptions I'm proceeding on

Flagged rather than asked, because each has an obvious default and none is expensive
to change later:

- **Units** — grains, inches, fps, °F, feet of altitude. Metric display toggle is a
  later config flag, not a v1 concern.
- **Clean start** — no existing spreadsheet or notebook to import. If you do have one,
  say so now; retrofitting an importer after the schema settles is easy, but knowing
  your existing column names might change a field or two.
- **Load manual sources** — the recipe citation field will be a dropdown seeded with
  the common manuals (Hornady, Sierra, Nosler, Lyman, Speer, Barnes, Berger, Hodgdon's
  online data) plus free-text entry, with edition and page as separate fields. Tell me
  which manual you're actually working from and I'll make it the default.
- **Cartridge reference table** — seeded with the common suspects. Tell me which
  cartridges you load and I'll seed those specifically with correct max COAL, trim-to,
  and case length values rather than a generic list.
- **Individual case tracking** — built behind the per-lot flag, off by default. Turn it
  on for a numbered set when you want it.
- **Single user, home LAN, no authentication.** See §6.

## 13. Remaining open question

Only one that actually blocks anything:

**Which cartridges do you load?** It determines what I seed the reference table with,
and those values (max COAL, trim-to length, case length, bullet diameter, primer size)
should be correct from a real source rather than approximated. Everything else in this
document can proceed without an answer.
