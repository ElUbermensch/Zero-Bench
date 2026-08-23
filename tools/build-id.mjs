/* One line that says which build you are looking at.
 *
 * This exists because of an afternoon spent guessing. The apps on the phone
 * were missing a feature, and there was no way to tell from the phone whether
 * the code had shipped, whether the service worker was serving yesterday's
 * copy, or whether the change was simply wrong. Every answer required reading
 * the deployed service worker by hand and comparing hashes.
 *
 * A build stamp is a two-second answer to "is this the new one". It is worth
 * more than it looks: without it, every bug report starts with an unanswerable
 * question, and the wrong half of the system gets debugged.
 *
 * The commit is taken from the CI environment when there is one -- Vercel and
 * GitHub Actions both publish it -- and falls back to a local marker, which is
 * itself informative: a build stamped `local` is one somebody made by hand.
 */
export function buildId() {
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA
            || process.env.GITHUB_SHA
            || '').slice(0, 7);
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return { sha: sha || 'local', when, id: `${sha || 'local'} · ${when}Z` };
}
