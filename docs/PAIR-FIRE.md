# Pair fire — diagnosis before rebuild

**Status:** not implemented. No pair-fire code exists in the current `Zero.jsx` —
I grepped for pair/partner/relay/alternate/spotter and for realtime/websocket/channel/
subscribe/broadcast/presence, and found nothing. `fireMode` carries only `Slow` and
`Rapid`. So this is a rebuild from scratch, not a repair.

This document exists because the obvious fix for the reported symptom is the wrong one,
and building on that mistake would waste the work.

---

## The symptom splits into two unrelated problems

> "did not work well due to supabase killing it frequently"
> "constant idle, call and return message so that supabase doesn't cancel the [project]"

Those describe **two different failures on two different timescales**, and the fix for
one does nothing for the other.

### Problem 1 — the project pauses. Timescale: 7 days.

Supabase pauses a free project after roughly 7 days of low activity. Data survives and
is restorable, but the API goes dark until someone clicks restore.

**This cannot be what killed pair fire mid-session.** Nothing that takes a week to
trigger explains a feature failing repeatedly during use.

**Fixed**, in this repo: `public.keepalive()` (migration `0003`) plus
`.github/workflows/keepalive.yml`, which calls it daily. The function touches no table
and returns one timestamp, so granting it to `anon` is safe — the test suite asserts
that the grant opened no table access.

### Problem 2 — the live connection dies mid-session. Timescale: minutes.

This is the one that actually broke pair fire, and per Supabase's own troubleshooting
docs the mechanism is specific:

> When your application moves to the background, web browsers implement **browser
> throttling**, reducing JavaScript timer frequency and preventing the Realtime client
> from sending heartbeats. The server assumes disconnection and drops the WebSocket —
> and the client never detects the loss, because it was never actively detected on the
> main thread.

**Pair fire is the worst possible case for this.** The entire premise is that one
shooter's phone sits idle while the other shoots. Screen locks, tab backgrounds,
timers throttle, heartbeat stops, server drops the socket — and the app shows a
connected UI over a dead connection. Then the partner's shot never arrives.

---

## Why "a constant idle keepalive message" is the wrong fix for Problem 2

It is the natural instinct and it does not work, because **the thing that fails is the
timer itself**. A backgrounded tab's `setInterval` is throttled to roughly once per
minute or stopped entirely. Adding another main-thread timer to ping more often gives
you a ping that is throttled exactly as hard as the heartbeat already being throttled.
You cannot fix a stopped clock by scheduling more work on it.

Worse, it hides the failure: a keepalive that the browser silently stops firing looks
identical to a keepalive that is working.

### What actually works

1. **Move the heartbeat off the main thread.** Supabase's client supports
   `worker: true`, running heartbeat logic in a Web Worker, which browsers throttle far
   less aggressively than an inactive tab's main thread.
2. **Assume the connection is dead and verify, rather than assume it is alive.** Use
   `heartbeatCallback` to detect `disconnected` and reconnect explicitly.
3. **Reconcile on resume, do not rely on the stream.** On `visibilitychange` →
   visible, and on `online`, re-fetch session state outright. The WebSocket becomes an
   optimisation for latency, never the source of truth.
4. **Wake locks.** `navigator.wakeLock` keeps the screen on during an active pair-fire
   session, which sidesteps the whole problem for the common case — at the cost of
   battery, so it should be opt-in and released when the session ends.

### The option worth considering seriously: no WebSocket at all

Pair fire needs to know "my partner fired" within a few seconds. It does not need
millisecond latency. A **2–3 second poll of one shared row** has properties that matter
more here than latency does:

- a plain `fetch` on resume just works; there is no connection to have silently died
- it survives backgrounding, screen lock, airplane mode, and switching apps
- it degrades gracefully on the bad cellular signal you get at most ranges
- it needs no new dependency — `zero-core` already does authenticated REST

The cost is a request every few seconds per active pairing, which for a handful of
shooters is nothing, and it only runs while a pair-fire session is actually open.

**My recommendation: build pair fire on polling first.** If latency proves genuinely
insufficient, add Realtime as an accelerator on top of a polling fallback that is
already proven to work. The reverse order is how the previous attempt failed.

---

## What I need before building

The interaction model matters more than the transport, and I do not want to guess it.
In competitive shooting "pair fire" can mean several different things:

- **Two shooters, one target, alternating shots** — the classic pairs relay, where each
  shooter fires in turn while the other waits.
- **Shooter and scorer/spotter** — one shoots, the partner records and calls, then they
  swap. Only one person is entering data at a time.
- **Two shooters on adjacent targets, one relay clock** — both shoot, shared timing and
  shared range conditions, separate scores.
- **One device, two shooters** — no network involved at all, just a session that
  interleaves two people's shots.

That last possibility is worth flagging: **if pair fire is one device passed between
two shooters, none of the Supabase problems apply**, and the whole feature is local
state. It would be worth knowing whether the previous implementation genuinely needed
two devices, or whether it reached for the network because it was already there.

Pasting the old code or the original chat would settle all of this — particularly:

1. the session/shot shape the old mode wrote,
2. how the two devices found each other (a code? a match id? a shared link?),
3. whether both devices could enter shots or only one,
4. what exactly the user saw when it broke.

Point 4 matters most for confirming the diagnosis above: a UI that stayed "connected"
while silently receiving nothing is the signature of the throttled-heartbeat failure.
Anything else means the cause is elsewhere and this document needs revising.
