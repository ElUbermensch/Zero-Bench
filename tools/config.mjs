/* One place to put the backend, read at build time by both apps.
 *
 * It used to live inline in Zero.jsx, which was fine while there was one app
 * and became a trap the moment there were two: two constants to fill in, no
 * error if they disagreed, and the failure mode is a shooter whose phone
 * silently talks to a different project from their coach's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'supabase.config.json');

export function loadConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { raw = {}; }
  // Env wins, for CI and for checking a second project without editing the
  // file. Also how the verification script is exercised against the mock.
  const url = String(process.env.SUPABASE_URL || raw.url || '').trim().replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || raw.anonKey || '').trim();
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(url);
  if (!url || !anonKey) return { url, anonKey, ok: false, reason: 'not filled in yet' };
  if (!local && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
    return { url, anonKey, ok: false, reason: `url does not look like a Supabase project URL: ${url}` };
  }
  // The secret key is the one thing that must never reach a browser bundle.
  // It bypasses RLS entirely, and RLS is the whole access control here.
  if (/^sb_secret_/.test(anonKey) || /service_role/.test(anonKey)) {
    return { url, anonKey: '', ok: false,
             reason: 'that is the SECRET key. It bypasses RLS and must never be built into a PWA. Use the publishable / anon key.' };
  }
  return { url, anonKey, ok: true, reason: null };
}
