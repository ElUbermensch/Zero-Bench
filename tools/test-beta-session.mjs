/* The state an APPROVED user's device is in, for the browser suites.
 *
 * Migration 0021 made both apps invitation-only: signed out, or signed in and
 * not yet approved, and nothing paints but the gate. That is correct, and it
 * means every end-to-end suite in this repo -- which drives the app by
 * clicking tabs that no longer exist for a stranger -- has to say who it is
 * before it can test anything.
 *
 * It does that by writing the two localStorage keys zero-core itself writes,
 * which is exactly what a real approved user's phone holds after signing in.
 * There is deliberately NO bypass flag, no `window.__SKIP_GATE`, no build
 * variant with the gate compiled out: a switch that turns the gate off is a
 * switch an attacker looks for first, and one that exists only in tests is one
 * that ships the first time somebody copies a build script. The suites take
 * the same door as everybody else and arrive holding the same keys.
 *
 * None of this grants anything. The tokens are strings; the server has never
 * seen them and would refuse every one of them. What they buy is a client that
 * renders, which is all a UI test was ever asking for -- and it is why the
 * network is cut off below rather than left to fail on its own.
 */

/* A syntactically real uuid. zero-core does not parse it, but the cached
 * verdict is keyed by user id and a value that could never come back from the
 * server would hide a mismatch bug rather than expose one. */
export const TEST_USER_ID = '11111111-2222-4333-8444-555555555555';
export const TEST_USER_EMAIL = 'tester@example.com';

/* Runs in the PAGE, before any of the app's own script. Written as a
 * standalone function with no closure over anything in this module, because
 * Playwright serialises it across the process boundary and a captured
 * variable would arrive undefined. */
export function installApprovedSession(fixture) {
  try {
    localStorage.setItem('zerocore.session', JSON.stringify(fixture.session));
    localStorage.setItem('zerocore.access', JSON.stringify({
      userId: fixture.userId,
      status: fixture.status || 'approved',
      requestedAt: null,
      decidedAt: null,
      heardFrom: null,
      heardDetail: null,
      at: Date.now(),
    }));
  } catch (e) { /* a context with storage blocked is testing something else */ }
}

/** The offline fixture: a session no server ever minted, for the suites that
 *  run against no backend at all. */
export function fakeApproved(id = TEST_USER_ID, email = TEST_USER_EMAIL) {
  return {
    userId: id,
    email,
    status: 'approved',
    session: {
      access_token: 'test.access.token',
      refresh_token: 'test.refresh.token',
      // Far enough out that no suite's clock manipulation expires it midway.
      expires_at: Date.now() + 24 * 3600 * 1000,
      user: { id, email, is_anonymous: false },
    },
  };
}

/**
 * Put a browser context in the approved state and cut it off from the real
 * backend.
 *
 * The second half is not tidiness. Both apps sync on launch when a session
 * already exists, and the built bundle carries the REAL project URL out of
 * supabase.config.json -- so the moment these suites started booting signed
 * in, they started firing requests at production from every test run. Aborted
 * here, which also makes the suites hermetic in a way they were not before:
 * a red run now means the app is wrong, not that somebody's wifi is.
 *
 * Only *.supabase.co is cut. The relay and sync suites stand up their own
 * mock on localhost and must still reach it.
 */
export async function applyBetaFixture(ctx, fixture) {
  await ctx.addInitScript(installApprovedSession, fixture || fakeApproved());
  /* Answered with 200, not aborted and not 503.
   *
   * Both of those surface in the page as a console error -- `net::ERR_FAILED`
   * or "Failed to load resource: 503" -- and these suites assert that a clean
   * run logs no JavaScript errors. Cutting the network that way failed a test
   * about errors with a message about a network the test never mentions, which
   * is the worst kind of red: correct, and about something else.
   *
   * So the stand-in is a backend that is reachable and has nothing to say. An
   * empty array is what every table read in this schema returns when there are
   * no rows, and the one endpoint that must not return an array is answered
   * with the object its caller expects. 200 also keeps zero-core off its 401
   * refresh path, which would otherwise sign the fixture out mid-suite. */
  await ctx.route('**://*.supabase.co/**', (route) => {
    const url = route.request().url();
    const body = url.includes('/rpc/my_access_status')
      ? JSON.stringify({ status: 'approved' })
      : '[]';
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  return ctx;
}

/**
 * Apply it to every context a suite opens, including the ones it opens later.
 *
 * The alternative was an edit at each `browser.newContext(...)` call, of which
 * test-integration.mjs alone has a dozen -- and the failure mode of missing
 * one is a single test timing out thirty seconds into a run, pointing at a
 * locator rather than at the reason. Wrapping the factory once means a context
 * added next year is covered by the code that was already right.
 */
export function useBetaFixture(browser, fixture) {
  const original = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const ctx = await original(...args);
    await applyBetaFixture(ctx, fixture);
    return ctx;
  };
  return browser;
}
