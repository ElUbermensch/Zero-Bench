import { createRoot } from 'react-dom/client';
import App from './Zero.jsx';

/* window.storage — the async KV contract Zero.jsx expects, over localStorage.
 *
 * Keys are BARE (sessions_v1, rifles_v1, ...), matching the adapter the
 * deployed Zero has always shipped. That is not a style choice: existing users'
 * logbooks are sitting in localStorage under those exact names right now, and
 * a prefix here would have shown every one of them an empty app with their data
 * still on disk, invisible. Nothing in the app would have looked broken, which
 * is what makes it the dangerous kind of wrong.
 *
 * The prefixed read below is a one-time migration for anyone who entered data
 * into a build that did use a prefix. It copies forward on first read, so it is
 * idempotent and costs one extra lookup only while a key is genuinely absent.
 *
 * Bench keeps everything under the single key `reloading.Bench`, so both apps
 * can share one origin — which they do on the combined deploy — without
 * colliding.
 */
const LEGACY_PREFIX = 'zs_';

window.storage = {
  async get(key) {
    let v = localStorage.getItem(key);
    if (v === null) {
      const legacy = localStorage.getItem(LEGACY_PREFIX + key);
      if (legacy !== null) { localStorage.setItem(key, legacy); v = legacy; }
    }
    return v === null ? null : { key, value: v };
  },
  /* A write that did not happen must not report that it did.
   *
   * `setItem` throws when the card is full, and every caller in Zero.jsx wraps
   * the call in a bare `catch {}` -- so React state kept the shot, the screen
   * kept the shot, and the disk did not. Relaunch and it is gone, with nothing
   * ever having been shown. The read side of this app is careful about the
   * difference between "empty" and "unreadable"; the write side had no notion
   * of "unwritten" at all.
   *
   * Reported rather than thrown, because a throw here would take the render
   * down and the data on screen with it. The event is what the app listens for
   * to tell the user; Bench has said "in memory only, not saved to this device"
   * for a while and Zero said nothing. */
  async set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      const quota = e && (e.name === 'QuotaExceededError'
        || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22);
      try {
        window.dispatchEvent(new CustomEvent('storage-failed', {
          detail: { key, quota, error: String(e && e.message || e) },
        }));
      } catch (e2) { /* nothing left to do about it */ }
      return { key, value, saved: false, quota };
    }
    return { key, value, saved: true };
  },
  async delete(key) {
    localStorage.removeItem(key);
    return { key, deleted: true };
  },
  async list(prefix = '') {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    return { keys, prefix };
  },
};

createRoot(document.getElementById('root')).render(<App/>);
