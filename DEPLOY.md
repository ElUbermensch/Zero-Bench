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

**B — Windows PowerShell**

```powershell
# Prerequisites, if you do not already have them.
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
# then CLOSE and REOPEN PowerShell so the new PATH takes effect

# PowerShell opens in your home folder; the browser saved the zip to Downloads.
# Give both ends a full path rather than assuming where you are standing.
Expand-Archive -Path "$HOME\Downloads\zero-suite.zip" -DestinationPath $HOME -Force
cd "$HOME\zero-suite"

git --version        # both should print a version.
node --version       # if not, the PATH has not refreshed — reopen PowerShell.

npm install
npm run preflight
```

`preflight` reports the backend as unconfigured. That is expected — it is step 4.

> **"The path ... does not exist or is not a valid file system path"** means the zip is
> not where the command looked. Find it, whatever your browser named it:
>
> ```powershell
> Get-ChildItem $HOME -Filter "zero-suite*.zip" -Recurse -ErrorAction SilentlyContinue |
>   Select-Object -ExpandProperty FullName
> ```
>
> Then put that exact path in the `-Path` argument. A second download often arrives as
> `zero-suite (1).zip`, which no amount of retyping the original name will find.

Then publish. `gh` is optional; without it, create the empty repo on github.com first
(no README, no .gitignore — this folder already has both) and use the remote it shows you:

```powershell
git remote add origin https://github.com/YOU/zero-suite.git
git push -u origin main
```

> **If `npm` fails with "running scripts is disabled on this system"** — that is
> PowerShell's execution policy blocking `npm.ps1`, not anything to do with this repo.
> It catches almost everyone once:
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```
>
> Answer `Y`. It applies to your user only and needs no administrator rights.

**What does and does not run on Windows**

| | |
|---|---|
| `npm run preflight` | works |
| `npm run build` | works |
| `npm test` | works — add `npx playwright install chromium` first, it downloads a browser |
| `npm run verify` | works, and is the one worth running |
| `npm run test:sql` | **no** — it needs bash and a local PostgreSQL. GitHub Actions runs it on every push instead, which is enough. |

**C — macOS or Linux terminal**

```bash
cd zero-suite
npm install
npx playwright install chromium
npm run preflight
npm test
git remote add origin https://github.com/YOU/zero-suite.git
git push -u origin main
```

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
| `0015_admin_role.sql` | `profiles.is_admin`, and the `is_admin()` the analytics policies ask |
| `0016_analytics_events.sql` | `analytics_event` and the four rollups the owner dashboard reads |
| `0017_admin_mfa.sql` | requires a verified second factor (`aal2`) to read the analytics |
| `0021_access_requests.sql` | the beta gate: `access_request`, the trigger that files one per sign-up, and the restrictive policies that refuse every table until you approve it |

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

Then, if you have a terminal:

```
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

Works in PowerShell. **No terminal at all?** Skip to the manual check below — it covers
the same ground by hand, just less thoroughly.

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
3. **Make yourself the admin** (see below), if you want the dashboard.
4. **Then** put real data in.

---

## The owner dashboard

`/admin/` is a read-only page showing traffic, sign-ups and feature usage across both
apps. It is not a PWA and ships no service worker: every number on it is a query, so
there is nothing useful to cache.

**Nobody is an admin until you say so, and there is no in-app way to become one.**
After creating your account, run this once in **SQL Editor** — the web page in the
Supabase dashboard, the same one the migrations went into. It is SQL, not a shell
command; pasting it into PowerShell gets you `The term 'update' is not recognized`.

```sql
insert into public.profiles (id, is_admin)
select id, true from auth.users where email = 'you@example.com'
on conflict (id) do update set is_admin = true;
```

**An `update` will not do here, and the reason is a trap.** Nothing creates a
`profiles` row for you — there is no trigger on `auth.users`; a row appears the
first time an app syncs one. So a fresh account that has signed up but not yet
used Zero or Bench has no profile at all, and `update ... where id = (...)` matches
nothing, reports success, and changes nothing. You would then be told you are not an
admin by a dashboard that is working correctly. The insert above covers both cases.

Check it took, rather than assuming:

```sql
select u.email, coalesce(p.is_admin, false) as is_admin
  from auth.users u
  left join public.profiles p on p.id = u.id
 where u.email = 'you@example.com';
```

One row, `is_admin` true. No row at all means the email does not match an account —
check for a typo, or that you signed up with a different address.

Then open `/admin/` and sign in with that account. Anyone else who finds the URL gets
a sign-in box and, if they sign in, a page telling them they are not an admin — the
row-level security in `0016` is what actually withholds the data, so this holds even
against someone calling the REST API directly.

### Letting people in — the beta gate

Since migration `0021` the apps are **invitation-only**. Signing up no longer gets
anybody in; it files a request, and nothing in either app works until you approve it.

What a new user does:

1. opens Zero or Bench and gets a gate instead of the app,
2. picks **Request access**, gives an email, a password twice, and answers one
   question — how they heard about the product,
3. lands on a hold screen that polls, and lets them in by itself the moment you say
   yes. They never have to be told, and never have to reinstall anything.

What you do: open `/admin/`, go to the **Access** tab, and press **Approve**.
Waiting requests sort to the top. **Deny** refuses; **Revoke** takes access back from
somebody who had it, and takes effect on their next request — there is no session to
wait out.

**Billing is on the same row, ready for when the apps are paid for.** Each request
carries an amount due and an amount paid, both in cents, and the difference is the
`balance` shown beside the buttons. Press **Billing** to set them. Nothing is
automatic on purpose: recording a payment does not approve anybody and approving
somebody does not claim a payment. The workflow is "approve once the balance is met",
and the number is put in front of you at the moment you press the button — including
in the confirmation, which says what they still owe.

The **How they heard about it** table underneath counts the sign-up answers. That is
the only marketing question the product asks anybody.

**None of this is enforced by the dashboard, and that matters.** Both apps are static
bundles served with the publishable key, so a hold screen is only a courtesy — the
refusal is a set of restrictive row-level-security policies applied to every table in
`0021`, which a browser cannot argue with. `supabase/test/rls_test11.sql` is the
adversarial suite for it: a waiting account cannot read or write anything, cannot
approve itself through the table, the RPC or the sign-up form, and cannot open a pair
fire relay through the security-definer functions that never see a policy at all.

**Existing accounts were let in automatically.** The migration backfills everybody who
had an account when it ran as `approved`, with a note saying so. Locking out people
who already have a logbook in the app is not a beta gate, it is an outage. The gate is
for who comes next. If you want somebody out, revoke them from the Access tab.

**Approving requires the second factor**, the same as the analytics — see below. So
does reading the queue at all.

### The second factor

**The dashboard also asks for a code from an authenticator app**, on top of the
password. It reads every user's usage history, which is the most sensitive read in the
project, and one password is thin cover for it.

On first sign-in it shows a QR code. Scan it with **Microsoft Authenticator** —
*Add account → Other (Google, Facebook, etc.)* — or any TOTP app (Google
Authenticator, Authy, 1Password all work; nothing here is tied to one). If the camera
will not cooperate, the setup key is printed underneath to type in by hand. Enter the
six digits to finish. After that, every sign-in asks for the current code.

**This is enforced by the database, not by the page.** `0017` requires the `aal2`
claim on the token to read `analytics_event`, and only Supabase issues that claim, and
only after it has checked a code. Someone who skips the page and calls the REST API
with a password-only token gets an empty array. A client-side MFA gate would be worth
nothing here, because the dashboard is a static page served with the public key.

Two things worth knowing:

- **Enrolment happens before you have a factor**, on the password-only session. That is
  deliberate: requiring a code in order to set up the code would lock the only admin
  out with no way back except editing the database by hand.
- **The check is per sign-in, not once per account** — that is the point of it. If you
  lose the phone, clear the factor as `postgres` in the SQL editor
  (`delete from auth.mfa_factors where user_id = '<your uuid>';`) and the dashboard
  will offer enrolment again on the next sign-in.

The apps themselves are untouched by this. Zero and Bench are used at a range with no
signal, and demanding a rotating code to open your own logbook would be a way of
locking people out of their own data.

**What is collected.** Sign-ups, sign-ins, sign-outs, one `app_open` per visit, a
best-effort `app_background` carrying visit duration, screens opened, and the feature
actions each app tracks (records created and edited, labels printed, QR scans, shots
logged, sessions and matches created, relays hosted and joined, leaderboard posts).
No IP addresses, no device fingerprints, no free-text content — the `metadata` column
carries small facts like `{"kind":"batch"}`, never what was typed.

**Three things worth knowing before you rely on the numbers:**

- **A signed-out visit is not counted.** Events are attributed to a user, and the
  insert policy requires it, so someone who opens an app and never signs in leaves no
  trace. Visit counts are of *signed-in* visits.
- **Visit duration is an estimate, and visit count is not.** Duration comes from
  `visibilitychange`/`pagehide`, and a mobile browser killing a backgrounded tab is
  free to run neither. The dashboard says which visits reported.
- **Daily user counts cannot be added up.** The same person on Monday and Tuesday is
  one person, not two. The dashboard shows the busiest day rather than a sum, on
  purpose.

**It grows.** Screen views make this the busiest table in the schema by a wide margin.
Nothing prunes it today; on the free tier's 500 MB, keep an eye on it and add a
retention job (delete rows older than N months) before it becomes the reason you need
a bigger plan.

**Monetising this is a disclosure question as well as a technical one.** Once real
customers are being measured, a privacy policy saying what is collected and why is a
business step this repo cannot do for you.

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

## Where the two apps live

`tools/build-site.mjs` assembles one directory that every host serves:

```
site/            Zero
site/bench/      Bench
site/admin/      the owner dashboard
```

Zero is at the root because it is the app with existing users. They are bookmarked
at the origin, their home screens point there, and the PWA they installed has that
scope. Serving Bench at `/` would send every returning shooter to a reloading app
they have never seen, with their logbook apparently gone — it is still in
localStorage, which is per-origin, so nothing is lost, but they would have no way
to know that.

Two consequences follow from that layout, and both are easy to get wrong:

**The service worker guard belongs to whichever app is at the root.** Zero's worker
has a scope that contains `/bench/`, and its offline fallback would happily answer
for Bench on a phone that has only ever opened Zero. `apps/zero/src/sw.js` declines
anything under `/bench/`. Bench's worker needs no such guard — it is scoped to
`/bench/` and cannot reach above it.

**Bench's label QR uses the directory it was served from,** not the origin. An
origin-only base URL would print labels pointing at `host/#/s/SERIAL`, which opens
Zero with a fragment it has never heard of. The label would look right, scan fine,
and land on the wrong app.

## Cache headers, and why vercel.json looks the way it does

`vercel.json` sets `Cache-Control: public, max-age=0, must-revalidate` on three
paths. The reasoning, which cannot live in the file itself:

- **`/(.*)sw.js`** — a service worker must never be served stale. The bundle is
  content-hashed *by the worker*, so if the worker script itself is cached, a
  returning user is pinned to an old build indefinitely with no way to tell.
- **`/(index.html)?`** and **`/bench/(index.html)?`** — the shells name the bundle,
  so a stale shell points at a stale bundle. Same failure, one step removed.
- **`/admin/(index.html)?`** — for the opposite reason to the other two, and it is
  the one that would have been missed. The dashboard is a single self-contained
  file: no worker, no hashed bundle name, nothing downstream to invalidate it. So
  there is no second chance — cache that page and the owner reads an old dashboard
  with no way to tell, which for a page whose entire job is reporting numbers is the
  worst possible failure. `/admin` also gets the trailing-slash redirect `/bench`
  has, or Vercel answers the slashless form with a 404.

JSON has no comments. An earlier version of this file carried `"//"` keys inside the
`headers` entries as a comment convention; Vercel validates `vercel.json` against a
schema that forbids unknown properties, and rejected the deploy with
`headers[0] should NOT have additional property //`. The check happens at deploy
time, so the file looks fine locally and the build simply never starts.
`tools/preflight.mjs` now fails on any property the schema does not recognise.

## Vercel

The project deploys from `vercel.json`: build command and output directory come from
there, so leave Build Command and Output Directory unset in the dashboard, and leave
Root Directory empty (or `./`).

Two environment variables are required, on Production **and** Preview:

```
SUPABASE_URL       https://<ref>.supabase.co
SUPABASE_ANON_KEY  sb_publishable_...
```

Variables never apply retroactively — they affect new deployments only. Set them
before the first build, or redeploy after adding them. A build without them still
succeeds and prints `⚠ NO BACKEND`, shipping apps that ask every user to type a
server address. That line in the build log is the thing to check.

The publishable key is public by design and ships in the client bundle, which is why
RLS does all the access control. The secret / `service_role` key must never appear
in an environment variable, the repository, or any bundle.
