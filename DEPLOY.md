# Deploying

Start to finish, about 30 minutes. Do it in this order — step 4 depends on step 3,
and step 6 will fail confusingly if step 5 was skipped.

There are two things being deployed and they are independent:

- **the backend** — one Supabase project, shared by everyone who uses either app
- **the front ends** — two static PWAs on GitHub Pages, Bench at `/`, Zero at `/zero/`

---

## Before you start

```bash
npm install
npx playwright install chromium
npm run preflight        # a second; catches the silent mistakes
npm test                 # a few minutes; the real suites
```

`preflight` will report the backend as unconfigured. That is expected — it is step 4.

---

## 1. Create the Supabase project

<https://supabase.com/dashboard> → **New project**.

- **Region**: nearest to where you shoot. This is round-trip latency on every relay
  poll; nothing else in the app cares.
- **Database password**: save it somewhere. You will not need it for the apps — they
  never see it — but you cannot recover it later.
- Free tier is fine. It pauses after ~7 days of inactivity, which step 7 handles.

Wait for it to finish provisioning before continuing.

## 2. Apply the migrations

**Dashboard → SQL Editor → New query.** Paste and run each file in `supabase/migrations/`
**in name order**, one at a time, checking each succeeds before the next:

| | what it creates |
|---|---|
| `0001_init.sql` | brass lots, recipes, batches, sessions, shots, groups; the two views Zero and Bench read each other through; RLS on everything |
| `0002_leaderboard.sql` | the one deliberately public table, and the handle system |
| `0003_keepalive.sql` | the function that stops the project pausing |
| `0004_relay.sql` | pair fire: relays, participants, shots, feed, and the join throttle |

If you have the Supabase CLI instead:

```bash
supabase link --project-ref YOUR-REF
supabase db push
```

> **Never run `supabase/test/harness.sql` against a real project.** It stubs the `auth`
> schema so the migrations can be tested in vanilla Postgres. Supabase provides the real
> one, and the stub would shadow it.

## 3. Enable anonymous sign-ins

**Dashboard → Authentication → Providers → Anonymous → enable.**

This ships **disabled**, and it is the single most likely thing to go wrong on a first
deploy. Pair fire's "no accounts needed" is *implemented* as anonymous sign-in: with this
off, a coach taps join and gets an error, and everything else works fine — so it looks
like a relay bug rather than a settings one.

The app names this failure specifically rather than showing a generic message, but you
will still lose ten minutes to it if you skip this step.

## 4. Point the apps at the project

**Dashboard → Project Settings → API.** Copy the **Project URL** and the
**publishable** key (`sb_publishable_…`; a legacy `anon` JWT also works).

Put both in `supabase.config.json`:

```json
{
  "url": "https://abcdefgh.supabase.co",
  "anonKey": "sb_publishable_..."
}
```

That is the only place. Both apps read it at build time.

**Committing this key is correct.** The publishable key is public by design — it
identifies the project and grants nothing on its own. Row Level Security is the access
control, which is why there are 123 SQL assertions on it.

**The `service_role` / secret key must never appear in this repo**, in a build, or in
anything a browser can load. It bypasses RLS entirely. `npm run preflight` scans for it
and refuses.

```bash
npm run preflight        # should now be clean
npm run build
```

## 5. Push to GitHub

If the repo does not exist yet:

```bash
gh repo create zero-suite --private --source=. --remote=origin --push
```

Or by hand:

```bash
git remote add origin git@github.com:YOU/zero-suite.git
git push -u origin main
```

Private is fine — GitHub Pages works from a private repo on any paid plan, and on free
plans you will need the repo public for Pages. Nothing sensitive is in it either way; see
the note about keys above.

## 6. Turn on Pages

**Repo → Settings → Pages → Source: GitHub Actions.**

That is the whole configuration. `.github/workflows/deploy.yml` already builds both apps
and publishes them on every push to `main`. Watch the first run under **Actions**.

When it finishes:

- **Bench** — `https://YOU.github.io/zero-suite/`
- **Zero** — `https://YOU.github.io/zero-suite/zero/`

Open each on your phone and **Add to Home Screen**. Both are installable PWAs with their
own icons; once installed they open with no signal.

## 7. Keep the project awake

**Repo → Settings → Secrets and variables → Actions → Variables → New variable:**

| name | value |
|---|---|
| `SUPABASE_URL` | `https://abcdefgh.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` |

Variables, not secrets — the publishable key is not one, and making it a secret only
makes the logs harder to read.

`.github/workflows/keepalive.yml` then calls `public.keepalive()` daily. It fails loudly
on anything other than a 200, so it cannot silently stop protecting the project.

Run it once by hand now: **Actions → supabase keepalive → Run workflow**.

## 8. Verify against the real thing

```bash
npm run verify
```

**This is the test that counts.** Every other suite in this repo runs against a mock of
Supabase's endpoints, and that mock encodes an understanding that could itself be wrong.
This one talks to your actual project: schema applied, anonymous sign-in on, RLS closed
to the public key, a relay created and ended, the leaderboard readable but not spammable.

It cleans up after itself and cannot see your own rows.

---

## Then, in this order

1. **Make your account.** Open Zero → *Cloud sync* → create account. Claim a leaderboard
   handle while you are there.
2. **Prove the relay works before you rely on it.** Open a session, tap **● go live**,
   read the code to a second device (a laptop browser is fine), tap **● join**. You are
   looking for shots appearing within a few seconds. Do this at home, not on the line.
3. **Then** put real data in.

---

## When something is wrong

| symptom | cause |
|---|---|
| App asks for a server address on first run | `supabase.config.json` was empty at build time. Fill it, rebuild, push. |
| "Anonymous sign-in is disabled on the server" | Step 3. |
| Coach joins, sees nothing, no error | Almost never the relay. Check both devices are on the same code and the shooter's device actually logged a shot — the relay only carries what Zero recorded. |
| Everything 5xx after a quiet fortnight | Project paused. Restore it in the dashboard, then check the keepalive workflow is green — it should have prevented this. |
| Old build after a deploy | Should be impossible now: cache names are hashes of what was built. If it happens, the deploy did not run — check Actions. |
| `npm test` fails on `embed-core --check` | `packages/zero-core/zero-core.js` was edited without rebuilding. `npm run build`. |

---

## What is not deployed yet

**Bench does not talk to the backend.** It is a complete, working reloading log that
stores everything locally on the device it runs on. What that means concretely:

- Bench's own data does not sync between your phone and anything else
- Zero's **⇣ Bench** picker will find no batches, because nothing is writing them

Zero itself is fully wired — sessions, groups, the leaderboard and pair fire all use the
backend today. Wiring Bench means mapping its local model onto the schema that is already
built and tested for it (`v_ballistic_profiles` exists and Zero reads it correctly; there
is simply nothing on the other end yet).

Deploying now is still worth it: it proves the backend, gets both apps on your home
screen, and makes pair fire usable this weekend. Bench keeps working exactly as it does
now, and gains sync later without a migration.
