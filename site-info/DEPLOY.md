# Deploying the information page

The page is `site-info/index.html`. It ships as **its own Vercel project**, on
its own origin — not as a path on `zero-wine-one.vercel.app`. Why, in one
paragraph, because it is the only thing here that is not obvious:

> Zero's service worker is registered from the root, so its scope is `/` and its
> fetch handler answers for **every** same-origin GET except the one path it
> excludes by hand (`/bench`). A page at `/info` would be runtime-cached by that
> worker on first view and served from that cache afterwards — and the cache
> name is a hash of Zero's *bundle*, so editing this page does not invalidate
> it. Every user who has opened Zero would be pinned to the first copy of the
> page they ever saw, until Zero ships unrelated code. Offline, the same handler
> answers `/info` with **Zero's app shell**. The fix is one line in
> `apps/zero/src/sw.js`; until that line exists, this page belongs on an origin
> with no service worker on it.

That is also where it wants to be when it gets a domain: attaching a domain to
the app's project would make Zero answer on that hostname too — a second origin,
a second `localStorage`, a second installable copy of the app.

---

## 0. Before the first deploy — one fix in the page itself

`site-info/index.html` was written as a Claude Artifact, and an Artifact is
*wrapped* by its host. Served as a plain file, nothing supplies the wrapper. Add
these three lines at the very top of the file:

```html
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
```

Without the viewport line a phone lays the page out at 980px and zooms out —
on a marketing page, that is the whole page. `npm run build:site` and
`npm run preflight` both warn about this until it is fixed; neither blocks on it.

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
- Environment variables: **none**. The page has no backend
- Production branch: `main`
- Deploy

Nothing about the app's project changes. Its `vercel.json`, its build command,
its output, Zero's scope, Zero's manifest and both service workers are untouched
by this work.

## 2. After the first deploy — check these

- [ ] `https://<project>.vercel.app/` serves the page (not a directory listing,
      not 404)
- [ ] `curl -sI https://<project>.vercel.app/ | grep -i cache-control` →
      `public, max-age=0, must-revalidate`
- [ ] DevTools → Application → Service Workers on that origin: **none**. This is
      the whole point of the separate project
- [ ] On a phone, or DevTools device mode: the page is laid out for the screen,
      not zoomed out (§0)
- [ ] The Google Fonts stylesheet loads (the page's only external asset)
- [ ] `https://zero-wine-one.vercel.app/` and `/bench/` still open their apps,
      and an already-installed Zero still opens offline — the app deploy is
      unchanged, so this is a sanity check, not an expected risk

## 3. Shipping changes to the page

Edit `site-info/index.html`, push to `main`. Both projects redeploy: the app
project rebuilds and republishes `site/` (unchanged by this edit), the info
project republishes the page.

Optional, to stop the info project rebuilding on every app commit — Project
Settings → Git → **Ignored Build Step**:

```sh
git diff --quiet HEAD^ HEAD -- site-info/
```

## 4. When you pick a domain

Do it on the **info project**, not the app project.

- [ ] Info project → Settings → Domains → **Add** `example.com` (and Vercel will
      offer `www.example.com` with a redirect — take it)
- [ ] DNS at the registrar, as Vercel's screen states it:
      apex `A → 76.76.21.21`, and `www` `CNAME → cname.vercel-dns.com.`
      (use Vercel's values if they differ from these; it prints the current ones)
- [ ] Wait for the certificate to issue, then load the apex and `www` over HTTPS
- [ ] **Do not** add that domain to the app project. It would serve Zero at the
      marketing hostname: a second origin with an empty logbook and an
      installable second copy of the app
- [ ] If you want the app on a subdomain of the same name later — e.g.
      `app.example.com` → the app project — that is a separate decision with a
      real cost: it is a **new origin**, so every existing user's `localStorage`,
      installed PWA and offline cache stay behind on `zero-wine-one.vercel.app`.
      Add it as an *additional* domain, keep the old one working, and do not
      redirect the old origin to it

Nothing needs to move projects when the domain arrives. That is the reason the
page is in a project of its own from the start.

## 5. If you decide you want it at `/info` on the app origin anyway

Read the box at the top first, then:

1. `apps/zero/src/sw.js` — widen the exclusion in the fetch handler from
   `/(^|\/)bench(\/|$)/` to also skip `info`. Without this the page is stale for
   existing users and answered with Zero's shell offline. This is not optional
2. `tools/build-site.mjs` — copy the page into the assembled site:
   `fs.cpSync(path.join(ROOT, 'site-info/dist'), path.join(SITE, 'info'), { recursive: true });`
3. Root `vercel.json` — add a headers entry for `/info/` and `/info/index.html`
   with `Cache-Control: public, max-age=0, must-revalidate`, matching the
   entries already there. No comment keys (`"//"`), no BOM: Vercel validates
   this file against a schema that rejects unknown properties, at deploy time,
   before any build starts
4. `tools/preflight.mjs` — the info-page section checks `site-info/dist`; point
   it at `site/info` as well

## What is in this folder

| file | what it is |
| --- | --- |
| `index.html` | the page. One self-contained file, one external stylesheet (Google Fonts) |
| `build.mjs` | copies the page to `dist/`, refuses to publish an empty one, warns about §0 |
| `package.json` | so Vercel's install/build step behaves predictably in this root directory |
| `vercel.json` | the info project's build, output and cache headers |
| `dist/` | build output, gitignored |

`npm run build:site` at the repo root runs `build.mjs` too, so one command still
produces everything — it just publishes the page somewhere else.

## Security headers

Neither `vercel.json` in this repo sets any (`Cache-Control` only), and this one
matches that rather than inventing a convention for one page. If you want them,
the ones worth having on a static marketing page are `X-Content-Type-Options:
nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a
`Strict-Transport-Security` header — add them to both files at once, so the two
origins do not drift.
