/* The @font-face block both apps embed, generated from one place.
 *
 * Zero used to pull DM Sans and Space Mono with an `@import` from Google
 * Fonts. That is a blocking request to a third-party host in two apps built to
 * be used at a range with no signal: offline, the import fails and the app
 * renders in a generic fallback, so it looks different at the bench than it
 * does on the line. Adding the same import to Bench proved the cost -- it hung
 * Bench's own test suite, because the headless browser cannot reach
 * fonts.googleapis.com and a blocking import stalls rendering until it gives
 * up. A phone with no reception does exactly that.
 *
 * The files are vendored in packages/fonts and copied into each app's dist, so
 * both apps serve them from their own origin and precache them in their own
 * service worker. No third-party host, no difference between online and off,
 * and both apps get the same typeface.
 *
 * `font-display:swap` so text is readable immediately and reflows when the
 * face arrives, rather than being invisible while it loads.
 */
export const FONT_FILES = [
  'dm-sans-latin-400-normal.woff2',
  'dm-sans-latin-500-normal.woff2',
  'dm-sans-latin-700-normal.woff2',
  'space-mono-latin-400-normal.woff2',
  'space-mono-latin-700-normal.woff2',
];

const face = (family, weight, file) =>
  `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};` +
  `font-display:swap;src:url('./fonts/${file}') format('woff2')}`;

export const FACE_CSS = [
  face('DM Sans', 400, 'dm-sans-latin-400-normal.woff2'),
  face('DM Sans', 500, 'dm-sans-latin-500-normal.woff2'),
  face('DM Sans', 700, 'dm-sans-latin-700-normal.woff2'),
  face('Space Mono', 400, 'space-mono-latin-400-normal.woff2'),
  face('Space Mono', 700, 'space-mono-latin-700-normal.woff2'),
].join('\n');
