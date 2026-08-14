# Deploying

Start to finish, about 30 minutes. Do it in this order — step 4 depends on step 3,
and step 6 will fail confusingly if step 5 was skipped.

There are two things being deployed and they are independent:

- **the backend** — one Supabase project, shared by everyone who uses either app
- **the front ends** — two static PWAs on GitHub Pages, Bench at `/`, Zero at `/zero/`

---

## You do not need a terminal for any of this

GitHub Actions builds both apps on every push. Nothing here requires Node, npm or a
command line on your own machine — the only file you edit is one line of JSON, and
GitHub's own web editor does that fine.

Two ways in. Pick one:

**A — GitHub Desktop (recommended, no terminal at all)**

1. Install <https://desktop.github.com>
2. Unzip `zero-suite.zip` (double-click on Windows or macOS — no extra software)
3. GitHub Desktop → **File → Add local repository** → pick the unzipped `zero-suite`
   folder. It is already a git repository with its full history, so Desktop takes it
   as-is.
4. **Publish repository** → name it, choose public or private → Publish.

**B — Terminal, if you have one**

```bash
cd zero-suite
git remote add origin https://github.com/YOU/zero-suite.git
git push -u origin main
```

Optionally, before pushing:

```bash
npm install
npx playwright install chromium
npm run preflight        # a second; catches the silent mistakes
npm test                 # a few minutes; the real suites
```

`preflight` will report the backend as unconfigured. That is expected — it is step 4.

> **Avoid GitHub's drag-and-drop web uploader for the initial import.** Browsers have
> long excluded folders beginning with a dot from directory uploads, and `.github/` is
> exactly that — it holds the workflows that do the building. If you use it anyway,
> check afterwards that `.github/workflows/deploy.yml` is in the repo; if it is missing,
> nothing will ever build and the failure is silent.

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
**in name order**, one at a time, checking each succeeds before the next.

To get the text: open the file on GitHub, click **Raw**, select all, copy. (Or open it
from the unzipped folder in Notepad / TextEdit — they are plain text.) They are long;
paste each one whole rather than in pieces.

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

Put both in `supabase.config.json` — either in the unzipped folder before publishing, or
directly in GitHub's web editor afterwards (open the file → pencil icon → Commit changes,
which redeploys by itself):

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

If you have a terminal:

```bash
npm run preflight        # should now be clean
npm run build
```

If you do not, skip it. GitHub Actions runs the build, and the **Actions** tab shows a
green tick or a readable error.

## 5. Push to GitHub

You did this above, either with GitHub Desktop or `git push`.

If you have already published and are only changing `supabase.config.json`, the fastest
route is GitHub's own editor: open the file in the repo, click the pencil, paste the two
values, **Commit changes**. That commit triggers a rebuild and redeploy on its own.

Public or private: Pages works from a private repo on a paid plan; on a free plan the
repo needs to be public for Pages to serve it. Nothing sensitive is in the repo either
way — see the note about keys above.

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

**No terminal?** Skip to the manual check below — it covers the same ground by hand,
just less thoroughly. The script is worth borrowing a laptop for once.

**This is the test that counts.** Every other suite in this repo runs against a mock of
Supabase's endpoints, and that mock encodes an understanding that could itself be wrong.
This one talks to your actual project: schema applied, anonymous sign-in on, RLS closed
to the public key, a relay created and ended, the leaderboard readable but not spammable.

It cleans up after itself and cannot see your own rows.

### Checking by hand instead

1. Open Zero on your phone. If it asks for a server address, step 4 did not take.
2. Create your account in *Cloud sync*. If that works, the schema and keys are right.
3. Open a session, tap **● go live**. A code means anonymous sign-in is on — this is the
   step-3 check, and the one most likely to fail.
4. Join from a second device with that code and log a shot. Seeing it arrive exercises
   the relay, RLS and the polling loop in one go.

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
