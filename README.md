# Zero Suite

Two offline-first shooting PWAs over one shared Supabase backend.

- **Zero** — precision shooting log: sessions, shot plotting, DOPE, analytics, leaderboard,
  and pair fire: two shooters and a coach on one 4-character code, each seeing the
  others' shots live.
- **Bench** — the reloading log: brass lots by colour code, load recipes, serialised
  batches, printable QR labels.

They are not two copies of one app. Zero records what happened downrange; Bench
records what you loaded. The interesting part is the seam: a batch loaded in Bench
becomes a selectable load in Zero, and the group it shoots flows back to that batch.

```
apps/bench           the reloading PWA (vanilla, single-file build)
apps/zero            Zero (React, bundled with esbuild)
packages/zero-core   shared auth + offline sync, embedded byte-identically in both
supabase/            migrations and the RLS test suites
tools/               preflight, live verification, the zero-core embed step
docs/                integration contract and design notes
DEPLOY.md            start-to-finish deployment
```

## Deploying

**[DEPLOY.md](DEPLOY.md) is the walkthrough** — Supabase project, migrations, Pages,
verification, in the order that works.

Every install points at **one** Supabase project, set in **one** file:

```jsonc
// supabase.config.json
{ "url": "https://abcdefgh.supabase.co", "anonKey": "sb_publishable_..." }
```

Both apps read it at build time.

```bash
npm run preflight    # config, secrets, icons, workflows — a second
npm test             # the suites — a few minutes
npm run build
npm run verify       # once the project exists: checks the REAL backend
```

**Committing this key is correct.** The publishable/anon key is public by design — it
identifies the project and grants nothing on its own. Row Level Security is the access
control. What must *never* appear in this repo is the **secret / `service_role`** key,
which bypasses RLS entirely.

## Setting up the database

See [DEPLOY.md](DEPLOY.md). In short: apply `supabase/migrations/*.sql` in name order,
then **enable anonymous sign-ins** (Authentication → Providers → Anonymous), which ships
disabled and which pair fire needs.

Do **not** run `supabase/test/harness.sql` against a real project — it stubs the `auth`
schema so the migrations can be tested in vanilla Postgres, and Supabase provides the
real thing.

## Develop

```bash
npm install
npx playwright install chromium
npm run build          # both apps -> apps/*/dist
npm test               # zero-core, Bench, Zero, leaderboard, relay
npm run test:sql       # needs a local PostgreSQL 16
```

`Zero.jsx` embeds zero-core inline so the single-file build needs no bundler. That
region is **generated** — fenced by `//#region zero-core` and rewritten by
`tools/embed-core.mjs` during `npm run build`. Edit `packages/zero-core/zero-core.js`,
never the copy. `npm test` fails if the two have drifted.

## Deploy

`.github/workflows/deploy.yml` builds both apps and publishes to GitHub Pages on every
push to `main` — Bench at `/`, Zero at `/zero/`. Enable it under
**Settings → Pages → Source: GitHub Actions**.

Both service workers are cache-first, and their cache names are **hashes of what was
actually built**. There is nothing to bump: shipping an update cannot depend on
remembering a manual step.

## What is verified

| Suite | Assertions | What it actually proves |
|---|---|---|
| `supabase/test/` | 123 | Two users cannot see each other's private rows; the leaderboard is public-read and own-write; a negative control shows the `security_invoker` view guard is load-bearing; a relay code grants nothing on its own; each shooter in a pair owns exactly one string |
| `packages/zero-core` | 98 | Single-flight token refresh, FK-ordered push, cursor correctness, poison-pill rejection handling |
| `apps/bench` | 105 | Empty-start, one route per destination, persistence across a real reload, offline via service worker. Loading a batch draws its bullets, primers and powder off the shelf (powder converted into the unit the lot was bought in), brass is committed rather than consumed and returns when fired, deleting a batch puts everything back, and a batch bigger than the stock on hand is refused with the count that would fit. Brass life is counted in partial firings — fire 50 of 100 and the lot is at 0.5 — with the spread that partial draws create, so a lot is flagged on its worst case rather than its average. Cases can be removed with a reason, which changes the count and nothing else — each firing is measured against the lot as it stood at the time, so a cull cannot retroactively age the survivors |
| `apps/zero` integration | 41 | A Bench batch becomes a Zero load carrying BC, muzzle velocity and its SD, firearm geometry and the load citation; group size flows back in inches; a batch quarantined on the bench after import reaches Zero on the next refresh and is blocked from starting a new session, without touching sessions already shot |
| `apps/zero` leaderboard | 16 | Two separate browser profiles, one backend: A publishes, B sees it, B cannot alter it, private tables stay private |
| `apps/zero` relay | 62 | **Three** browser profiles driving the real buttons: two shooters and a coach on one code. Each shooter's shots reach the other two; neither can write the other's string (attempted with their own real token); the coach sees both and can log nothing; the call-vs-impact correction is exact minutes at each shooter's own distance, always printed but marked unconfirmed while the offset is inside its own noise; the code dies with the relay |

Everything runs against a mock of GoTrue and PostgREST (`packages/zero-core/mock-supabase.mjs`).
That mock encodes an understanding of Supabase's endpoints, which is exactly the thing
that could be wrong — so **`npm run verify` checks the real project**: schema applied,
anonymous sign-in on, RLS closed to the public key, a relay created and ended, the
leaderboard readable but not spammable. Run it after deploying. It is the test that counts.

## Keeping the free project awake

Supabase pauses a free project after ~7 days of low activity.
`.github/workflows/keepalive.yml` calls `public.keepalive()` daily to prevent it.
Set two **repo variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` |

Variables, not secrets — the publishable key is not one. The job fails loudly on a
non-200 so it cannot silently stop protecting the project.

This addresses project *pausing* only. It is not a fix for a live connection dropping
mid-session — the relay solves that by not holding a connection at all. See
`docs/PAIR-FIRE.md`.

## Status

- Zero: synced, Bench-linked, leaderboard, live relay — done.
- Bench: fully working standalone; **not yet wired to zero-core.** It stores locally
  only, so Zero's ⇣ Bench picker has nothing to read yet. The schema and the view it
  reads through are built and tested; only the client side is missing. Next piece of
  work — see the end of DEPLOY.md.
- Pair fire: **built** — two shooters and a coach, mutually visible, partner's shots
  overlaid on your own target in their colour. Polling, not WebSockets, on purpose;
  `docs/PAIR-FIRE.md` explains why the obvious fix for the reported symptom is the
  wrong one. Needs anonymous sign-ins enabled on the project.
- Scores on the leaderboard are self-reported. Constraints reject the implausible
  (a 10-shot 700); nothing makes a score *true*. It is a scoreboard among people who
  know each other, and the app says so rather than implying verification.

## Licence

MIT.
