# Deploying the information page

Two pages — the overview (`site-info/index.html` → `/`) and the manual
(`site-info/manual.html` → `/manual/`). They ship as **their own Vercel
project**, on their own origin, not as a path on `zero-wine-one.vercel.app`.

Why, in one paragraph, because it is the only thing here that is not obvious:

> Zero's service worker is registered from the root, so its scope is `/` and its
> fetch handler answers for **every** same-origin GET except the one path it
> excludes by hand (`/bench`). A page at `/info` would be runtime-cached by that
> worker on first view and served from that cache afterwards — and the cache
> name is a hash of Zero's *bundle*, so editing the page does not invalidate it.
> Every user who has opened Zero would be pinned to the first copy of the page
> they ever saw, until Zero ships unrelated code. Offline, the same handler
> answers `/info` with **Zero's app shell**. This was measured by executing the
> shipped `sw.js` against a fake worker global, not reasoned about. The fix is
> one line in `apps/zero/src/sw.js`; until that line exists, these pages belong
> on an origin with no service worker on it.

That is also where they want to be when they get a domain: attaching a domain to
the app's project would make Zero answer on that hostname too — a second origin,
a second `localStorage`, a second installable copy of the app.

---

## Current state, verified 2026-09-03

| | |
|---|---|
| Vercel team | `leander-s-projects4` (`team_4IgMTpoPK9SsLUCJ9gxzlKsC`) |
| Apps project | `zero` (`prj_50uTRiZxLcd64HkA3Uf0vJg8SnA2`) → `ElUbermensch/Zero-Bench` |
| Apps domain | `zero-wine-one.vercel.app` — last production deploy READY |
| Info project | **does not exist yet** — step 1 below creates it |
| Other project | `reticle-cam`, unrelated |

The apps project's dashboard **Framework Preset still says `vite`**, left over
from the old Vite repo. `vercel.json` sets `framework: null` with an explicit
build command and output directory, and those take precedence, which is why the
current deploy works. Worth correcting to **Other** at some point; it is not
blocking and this push does not change it.

## 0. No manual edit needed before the first deploy

Earlier revisions of this file told you to paste a doctype, charset and viewport
at the top of the page. **Do not.** The source must stay Artifact-shaped — an
Artifact is wrapped by its host, and a second `<html>` in the body is a parse
error — so `site-info/build.mjs` supplies the wrapper at build time instead,
splitting head from body at the single `</style>`. `tools/preflight.mjs` checks
both halves of that contract: that the source carries no `<html>`/`<body>`, and
that the emitted file does.

## 1. Create the Vercel project (once, ~3 minutes)

Same GitHub repo as the app, different root directory. Vercel supports several
projects from one repository; each reads the `vercel.json` in **its own** root
directory, so this project reads `site-info/vercel.json` and never sees the
app's.

- Vercel → **Add New… → Project** → import `ElUbermensch/Zero-Bench`
- Project name: `zero-info` (anything; it becomes `zero-info.vercel.app`)
- **Root Directory: `site-info`** ← the only setting that matters
- Framework Preset: **Other**. Leave Build Command and Output Directory blank —
  `site-info/vercel.json` sets them (`npm run build`, `dist`)
- Environment variables: **none**. The pages have no backend
- Production branch: `main`
- Deploy

Nothing about the app's project changes. Its `vercel.json`, its build command,
its output, Zero's scope, Zero's manifest and both service workers are untouched
by this work.

## 2. After the first deploy — check these

- `/` serves the overview; `/manual/` serves the manual
- The overview's **Read the manual** button reaches `/manual/`, and the manual's
  breadcrumb reaches `/`
- View source on `/`: the first line is `<!doctype html>`, and there is a
  `<meta name="viewport">`. If either is missing the page renders in quirks mode
  and a phone lays it out at 980px
- The theme toggle flips, and the page respects the OS theme before you touch it
- On a phone, nothing scrolls sideways
- Nothing but the two pages is fetchable — `/DEPLOY.md` and `/build.mjs` must
  404. The output directory is `dist/`, which is why

## 3. When you pick a domain

- Vercel → the **`zero-info`** project → Settings → Domains → Add
- Point DNS as Vercel instructs (an `A` record for an apex, a `CNAME` for a
  subdomain)
- Add **only to `zero-info`**. Adding it to the apps project as well would make
  Zero answer there too, which is the second-origin problem above
- Nothing in the repo needs editing. The pages carry no absolute self-links; the
  two cross-links are relative and the buttons to the apps are absolute to
  `zero-wine-one.vercel.app`, which stays correct
- If the apps later get a domain of their own, update those two button hrefs in
  `site-info/index.html` and `site-info/manual.html`

## 4. What can and cannot break the app deploy

`npm run build:site` is the **apps'** build command and it also builds these
pages. Failure is deliberately **non-fatal there**: a truncated marketing page
must not stop a deploy of Zero and Bench. It prints

```
⚠ the information page did not build — the apps below are unaffected,
  but its own deploy will fail until this is fixed.
```

and carries on. In *this* project's own build the same failure is fatal, because
here the page is the deliverable. One assembly step still produces everything;
what changes is who a failure is allowed to stop.

## 5. Editing the pages afterwards

Edit `site-info/index.html` or `site-info/manual.html`, push, and Vercel
redeploys both projects — the apps project rebuilds unnecessarily but harmlessly.

Two rules the build enforces, so breaking them fails loudly rather than
silently:

1. **No `<html>` or `<body>` in the source.** The build adds them.
2. **Exactly one `</style>` per page.** That is where the build splits head from
   body; a second style block would put the whole page inside `<head>` and
   render a blank document.

And one rule it cannot enforce: **the solver table on the overview is generated
from `apps/zero/src/solver.js` and goes stale when that file changes.** It has
already shipped stale once. Regenerate it from the current solver rather than
copying it from a source comment — the comments go stale too.
