# Bench — PWA

Deploy `dist/` to any static host. That's the whole deployment.

```
dist/
  index.html                 self-contained: markup, styles, app, QR encoder
  manifest.webmanifest
  sw.js                      precaches the shell; bump CACHE to ship an update
  icons/                     192, 512, maskable 512, svg
```

Rebuild after editing `src/`:

```bash
node build.mjs      # -> dist/index.html
node test.mjs       # 48 assertions against the built app, served over HTTP
```

## Notes

- **Starts empty.** No demo data.
- **Every creation form has exactly one entry point.** A test counts the routes
  across every screen and fails if any destination has two.
- **Storage** is localStorage, feature-detected with a memory fallback. Verified
  by creating records, reloading the page, and comparing every count and serial.
- **Sandboxed previews cannot persist.** An iframe without `allow-same-origin`
  has an opaque origin, and Chromium throws `SecurityError` on any storage API
  there — localStorage, sessionStorage and IndexedDB alike. No application code
  can work around it. The app now shows an unmissable banner on every screen
  when this is the case. Opened from `file://` or deployed to a host, saving
  works normally.
- **Offline** via a cache-first service worker. Tested with the network off.
- **Serials** use Crockford base32 minus `Z` (31 symbols, prime) with a weighted
  mod-31 check character that catches every single-character error and every
  transposition.
- `sw.js` caches by version. **Bump `CACHE` on every deploy** or returning users
  keep the old build.
- Not yet wired to Supabase — `zero-core` slots in next.
