# Pair fire — the live relay

**Status: built.** Migration `0004_relay.sql`, the relay client in `zero-core`, and
the UI in `Zero.jsx`. 27 SQL assertions and a 28-assertion two-device browser test
(`apps/zero/test-relay.mjs`) cover it.

---

## TL;DR

A shooter taps **● go live** on a session and gets a 4-character code. A coach taps
**● join** on their own phone, enters the code, their name and a role, and watches the
shot string, group plot, score and mean radius build in real time, with a shared feed
for wind calls. The coach needs no account.

Two decisions carry the whole design, and both are contrarian:

1. **No WebSocket.** The relay polls every 2.5 s. This is not a fallback; it is the
   transport. §2 explains why, and it is the direct fix for the failure you reported.
2. **The code is not the access control.** Holding the code is not what grants access
   — having a row in `relay_participants` is, and the only way to get that row is
   `join_relay()`, a throttled `security definer` function. One door, so the door can
   be watched. §3.

---

## 1. Your symptom was two unrelated failures

> "did not work well due to supabase killing it frequently"
> "constant idle, call and return message so that supabase doesn't cancel the [project]"

Those are **two different failures on two different timescales**, and fixing one does
nothing for the other.

### Problem 1 — the project pauses. Timescale: 7 days.

Supabase pauses a free project after roughly 7 days of low activity. Data survives; the
API goes dark until someone clicks restore.

**This cannot be what killed pair fire mid-session.** Nothing that takes a week to
trigger explains a feature failing repeatedly during use.

Fixed by `public.keepalive()` (migration `0003`) plus `.github/workflows/keepalive.yml`,
which calls it daily. The function touches no table and returns one timestamp, so
granting it to `anon` is safe — the suite asserts the grant opened no table access.

### Problem 2 — the live connection dies mid-session. Timescale: minutes.

This is the one that actually broke it. Per Supabase's own troubleshooting docs, the
mechanism is specific:

> When your application moves to the background, web browsers implement **browser
> throttling**, reducing JavaScript timer frequency and preventing the Realtime client
> from sending heartbeats. The server assumes disconnection and drops the WebSocket —
> and the client never detects the loss, because it was never actively detected on the
> main thread.

**Pair fire is the worst possible case for this.** The premise is that one phone sits
idle while the other shoots. Screen locks, tab backgrounds, timers throttle, heartbeat
stops, server drops the socket — and the app shows a connected UI over a dead
connection. Then the partner's shot never arrives.

---

## 2. Why "a constant idle keepalive message" is the wrong fix for Problem 2

It is the natural instinct and it does not work, because **the thing that fails is the
timer itself**. A backgrounded tab's `setInterval` is throttled to roughly once a minute
or stopped outright. Adding another main-thread timer to ping more often gives you a
ping throttled exactly as hard as the heartbeat already being throttled. You cannot fix
a stopped clock by scheduling more work on it.

Worse, it hides the failure: a keepalive the browser has silently stopped firing looks
identical to one that is working.

### What was built instead: polling, deliberately

Pair fire needs to know "my partner fired" within a few seconds. It does not need
millisecond latency. A 2.5 s poll of one RPC has properties that matter more here:

- **there is no connection to have silently died.** A `fetch` on resume just works.
- it survives backgrounding, screen lock, airplane mode and app switching
- it degrades gracefully on the bad cellular signal you get at most ranges
- it needs no new dependency — `zero-core` already does authenticated REST

The client backs off ×1.8 up to 20 s on failure and snaps back to 2.5 s on the first
success, and re-polls immediately on `visibilitychange` and `online` rather than waiting
out a backoff the user cannot see.

**Presence comes free.** `relay_state` stamps `last_seen_at` on every poll, so the poll
*is* the heartbeat — there is no separate keepalive to go stale. The host's card shows a
coach as "away" after 20 s of silence. This is the thing the WebSocket version could not
do honestly: it showed "connected" over a dead socket.

The cost is one request per 2.5 s per participant, only while a relay is open. For a
handful of shooters that is nothing.

If latency ever proves insufficient, add Realtime as an *accelerator* on top of a polling
layer already proven to work. The reverse order is how the previous attempt failed.

---

## 3. The security model, stated honestly

"No accounts" is implemented as **anonymous sign-in**, not as unauthenticated access.
The coach's device gets a real `authenticated` JWT with `is_anonymous: true`; the user
simply never typed an email. Everything below is ordinary RLS on a real `auth.uid()`.

```
                     ┌─────────────────────────────────────────┐
  code ──────────────▶ join_relay()  security definer, throttled│
                     └────────────────────┬────────────────────┘
                                          │ inserts
                                          ▼
                              relay_participants row
                                          │
                     ┌────────────────────┴────────────────────┐
                     │  every relay RLS policy reads this row  │
                     └─────────────────────────────────────────┘
```

- **The code alphabet is `23456789BCDFGHJKMNPQRSTVWXZ`** — 27 characters. No vowels, so
  a code can never spell a word; no `0/O/1/I/L`, so it is unambiguous shouted down a
  firing line. 27⁴ = 531,441 codes.
- **A code is only valid while its relay is `live` and unexpired**, so the target set is
  however many relays are running right now — typically one or two, not half a million.
- **`join_relay` returns a result, it does not raise.** This is load-bearing: a `RAISE`
  rolls back the transaction, which rolled back the failed-attempt row, so the throttle
  counted nothing and could never trip. The SQL suite regression-tests exactly this by
  asserting the attempt rows persist.
- **Ten failed attempts per user per 15 minutes.** The eleventh is refused *on the
  throttle*, not on the lookup, so a guesser learns nothing by continuing.
- **Only the host writes shots.** The insert policy checks `relays.host_id = auth.uid()`.
  A coach can post to the feed and nothing else — the browser test forges a `POST` with
  the coach's own real token and asserts a 403.
- **Anonymous devices cannot publish to the leaderboard.** A `RESTRICTIVE` policy rejects
  any insert whose JWT carries `is_anonymous: true`, or the board is trivially spammable.

**The honest limit:** a four-character code is short enough to say out loud, which means
it is short enough to guess given enough time. Combined with the throttle and Supabase's
default 30 anonymous sign-ins per hour per IP, guessing a live code takes days of
sustained effort. The prize is someone's shot string. That is an acceptable trade here
and would **not** be acceptable for anything sensitive.

---

## 4. What each side sees

**Shooter** — a card on the session, above the shot list: the code in large type, who is
watching (and who has gone away), and the feed. Leaving the session does not end the
relay; the home screen shows a live strip that taps back into it. Going live from a
second session ends the first — one live relay per shooter, enforced by a partial unique
index on `(code) where status = 'live'`.

Shots already fired are **backfilled** when going live, so a coach joining mid-string
does not see an empty target.

**Coach** — a full screen: score and X count, mean radius, extreme spread, shot count, a
group plot with the mean-radius ring, the numbered shot string, and the feed. Sighters
are drawn dashed and excluded from the statistics.

The relay is a *projection*, not a system of record. Zero's local session remains the
source of truth on the shooter's device; `relay_shots` is a view of it that expires.

---

## 5. Before it works on a real project

1. `supabase db push` (or paste `0004_relay.sql` into the SQL editor after `0001`–`0003`).
2. **Enable anonymous sign-ins**: Supabase dashboard → Authentication → Providers →
   Anonymous. It ships **disabled**, and with it off the coach cannot join at all. The
   app names this failure explicitly rather than showing a generic error, because it is
   the single most likely first-run problem.
3. Consider turning on CAPTCHA for anonymous sign-ins if the app ever goes public.

Relays expire on their own; nothing needs pruning by hand.

---

## 6. What is verified

| | |
|---|---|
| `supabase/test/rls_test3.sql` | 27 assertions, three actors. A stranger cannot list relays, read one by id, read the shot string, enumerate participants, or self-insert a participant row. Wrong codes trip the throttle *and the attempt rows survive*. A coach can read and post but cannot log shots or end the relay. The `>=` cursor returns two shots sharing one timestamp. The code dies when the relay ends or expires. |
| `apps/zero/test-relay.mjs` | 28 assertions across two real browser profiles. Drives the actual buttons on both devices — nothing calls the relay API to make something appear. Verified by negative control: removing the one line that mirrors a shot makes it fail. |

The browser suite runs against `packages/zero-core/mock-supabase.mjs`, a mock of GoTrue
and PostgREST. That mock encodes an understanding of Supabase's endpoints, which is
exactly the thing that could be wrong — **the first run against a real project is the
test that counts.**
