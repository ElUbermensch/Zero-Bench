# Pair fire — the live relay

**Status: built.** Migration `0004_relay.sql`, the relay client in `zero-core`, the
UI in `Zero.jsx`. 61 SQL assertions across two suites and a 62-assertion three-device
browser test (`apps/zero/test-relay.mjs`) cover it.

---

## TL;DR

Two shooters and a coach, all three watching each other's work.

Someone taps **● go live** on their session and gets a 4-character code. The partner
opens *their own* session and taps **join** with that code; the coach taps **● join**
from the home screen. From then on:

| | sees | writes |
|---|---|---|
| **shooter** | their own target as normal, with the partner's shots drawn over it as dashed rings in the partner's colour | their own string only |
| **coach** | both strings — on one target together, then a card each with score, mean radius, ES, the shot list, and **the correction in minutes** | nothing but the feed |
| **everyone** | one shared feed for wind calls and chatter | their own lines |

Two decisions carry the design, and both are contrarian:

1. **No WebSocket.** The relay polls every 2.5 s. This is not a fallback, it is the
   transport, and it is the direct fix for the failure you reported. §2.
2. **There is no privileged writer.** Every shooter writes their own string and nobody
   else's, enforced per row rather than per relay. §3.

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

**Pair fire is the worst possible case for this.** The premise is that phones sit idle
on a firing point while somebody else shoots. Screen locks, tab backgrounds, timers
throttle, heartbeat stops, server drops the socket — and the app shows a connected UI
over a dead connection. Then your partner's shot never arrives.

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

The client backs off ×1.8 up to 20 s on failure, snaps back to 2.5 s on the first
success, and re-polls immediately on `visibilitychange` and `online` rather than waiting
out a backoff the user cannot see.

**Presence comes free.** `relay_state` stamps `last_seen_at` on every poll, so the poll
*is* the heartbeat — there is no separate keepalive to go stale. The roster greys a name
out after 20 s of silence. This is the thing the WebSocket version could not do
honestly: it showed "connected" over a dead socket.

The cost is one request per 2.5 s per participant, only while a relay is open. For three
people that is nothing.

If latency ever proves insufficient, add Realtime as an *accelerator* on top of a polling
layer already proven to work. The reverse order is how the previous attempt failed.

---

## 3. Two shooters means no privileged writer

The first cut of this had one host who wrote the string and everyone else read it. That
is wrong for pair fire: both shooters are logging, simultaneously, on the same relay.

So `relay_shots.user_id` is the centre of the schema. **Shot 3 is not "the relay's shot
3", it is "this shooter's shot 3."** The unique key is
`(relay_id, user_id, shot_no, is_sighter)`, which means two shooters can both be on
shot 3 without colliding and neither can overwrite the other's string by racing to a
number.

The write policy is per row, not per relay:

```sql
create policy relay_shots_insert_own on public.relay_shots for insert
  with check (user_id = auth.uid()
              and exists (select 1 from public.relay_participants p
                           join public.relays r on r.id = p.relay_id
                          where p.relay_id = relay_shots.relay_id
                            and p.user_id = auth.uid()
                            and p.role = 'shooter'
                            and r.status = 'live'));
```

Three distinct things are therefore impossible, and each is tested with the attacker's
own real token rather than by inspection: a **coach** fabricating anybody's string, a
**shooter** fabricating their *partner's* string, and either of them appending to a
relay that has **ended**.

Reading is the opposite — every participant reads every shot, because that mutual
visibility is the entire feature.

### Firing points, and why colour is server-assigned

Each shooter gets a `slot` (1–4) on joining. Colour is a function of slot, so **the
partner who is blue on your phone is blue on the coach's**. If colour were assigned by
join order as each device happened to observe it, three devices would disagree, and a
coach saying "the blue one is stringing vertically" would mean nothing.

Slots are sticky across a rejoin (a dropped signal must not reshuffle colours mid-string)
and the lowest free slot is reused when someone leaves, so numbering does not climb
forever over a long day.

### What the shot carries

Impacts, and also **calls**: `call_x_in`/`call_y_in` (where the sights were at the break)
and `wind_call_moa`/`wind_call_dir` (the call it was fired on). The coach's plot draws a
hollow ring joined to the impact by a line. The gap between them is the whole point — a
called flyer is a technique problem, an uncalled one is wind or ammunition, and that
distinction is what a coach is on the line to make.

---

## 3a. The correction, in minutes

The coach's card turns that gap into the number they dial. Three decisions in it are
worth defending, because the obvious version of each is wrong.

**Why call error and not the group centroid.** The centroid tells you where the group
sits relative to the point of aim, which mixes three things together:

```
centroid − point of aim  =  aiming error + zero error + conditions
impact   − call          =              zero error + conditions
```

A shooter who calls "low left" and hits low left has a correctly zeroed rifle and made a
bad shot. Dial for that and you have just moved a rifle that was right. Subtracting the
call removes the shooter's own aiming error from the measurement, which is exactly why
coaches work off calls in the first place.

**Why the mean and not the mean absolute error.** Mean absolute error never approaches
zero however perfectly the rifle is zeroed — it measures how *tightly* the shooter is
calling. That is a real and useful number, so it is shown, in its own cell, clearly
labelled **MOA call miss**. But it is not a correction. The correction is the mean
*signed* error vector, decomposed into elevation and windage.

**The number is always printed — confidence is shown, not enforced.** A mean over four
shots is mostly noise, so each axis carries a 90% interval on the mean (Student *t*,
`se = s/√n`). An earlier cut of this suppressed the number when that interval spanned
zero. That was wrong: it took the judgement away from the coach, who can see the string,
knows the conditions, and is better placed than a *t*-test to decide whether a quarter
minute is worth chasing.

So the value is always on screen, and confidence is carried by how it looks:

| | number | label |
|---|---|---|
| clears its interval | shooter's colour | `MOA ±0.12` |
| inside its interval | dimmed | `MOA ±0.32 · unconfirmed` |

with the sentence underneath saying it plainly — *"Reading 0.35 down and 0.10 left, but
both intervals still span zero … a trend to watch rather than a number to dial."*

Small *n* is exactly where the interval matters, which is why it is a *t* table and not
1.645 — at 3 shots the multiplier is 2.35, and a normal approximation would mark a
correction confirmed when it is not.

The sign is flipped into an instruction, since the sight moves the way you want the group
to move: impacts **above** the call give **DOWN**, impacts **right** of it give **LEFT**.
The card says it as a sentence — *"Dial 1.00 down and 0.50 left"* — because that is what
gets shouted down a firing line.

**Minutes come from each shooter's own distance**, carried on
`relay_participants.distance_yd`, never from the relay. A pair is not always on the same
line, and half an inch is 0.48 MOA at 100 yards and 0.24 at 200. Converting a partner's
inches at the starter's yardage would hand the coach a confidently wrong correction — the
browser suite puts the two shooters on different lines specifically to catch that.

The per-shot chips show each call miss in minutes too (`◦1.1′`), so a coach can see
whether one shot is dragging the mean.

This is on the **coach's** screen only. Both ends acting on the same correction
independently is how a rifle gets dialled twice.

### Anonymity, honestly

"No accounts" is implemented as **anonymous sign-in**, not unauthenticated access. The
coach's device gets a real `authenticated` JWT with `is_anonymous: true`; the user simply
never typed an email. Everything above is ordinary RLS on a real `auth.uid()`.

```
                     ┌─────────────────────────────────────────┐
  code ──────────────▶ join_relay()  security definer, throttled│
                     └────────────────────┬────────────────────┘
                                          │ inserts
                                          ▼
                              relay_participants row (+ slot)
                                          │
                     ┌────────────────────┴────────────────────┐
                     │  every relay RLS policy reads this row  │
                     └─────────────────────────────────────────┘
```

- **The code alphabet is `23456789BCDFGHJKMNPQRSTVWXZ`** — 27 characters. No vowels, so
  a code can never spell a word; no `0/O/1/I/L`, so it is unambiguous shouted down a
  firing line. 27⁴ = 531,441 codes.
- **A code is only valid while its relay is `live` and unexpired**, so the target set is
  however many relays are running right now — typically one, not half a million.
- **`join_relay` returns a result, it does not raise.** Load-bearing: a `RAISE` rolls
  back the transaction, which rolled back the failed-attempt row, so the throttle counted
  nothing and could never trip. The SQL suite regression-tests exactly this.
- **Ten failed attempts per user per 15 minutes.** The eleventh is refused *on the
  throttle*, not on the lookup, so a guesser learns nothing by continuing.
- **No auth user id ever leaves the server.** `relay_state` returns `slot`, the shooter's
  display name, and an `is_self` flag — enough to group and colour the strings, and
  nothing a co-participant has any business knowing.
- **Anonymous devices cannot publish to the leaderboard.** A `RESTRICTIVE` policy rejects
  any insert whose JWT carries `is_anonymous: true`, or the board is trivially spammable.

**The honest limit:** a four-character code is short enough to say out loud, which means
it is short enough to guess given enough time. Combined with the throttle and Supabase's
default 30 anonymous sign-ins per hour per IP, guessing a live code takes days of
sustained effort. The prize is someone's shot string. That is an acceptable trade here
and would **not** be acceptable for anything sensitive.

### One thing deliberately not built

A **scorer entering shots on a shooter's behalf**. That is one change to
`relay_shots_insert_own` — allow a coach to insert rows attributed to a shooter — and
nothing else. It is off because letting two devices write one string is how a shot string
silently ends up with duplicates, and there is no way to tell afterwards which entry was
real. Say the word if you want it; it should come with a "who is scoring" lock rather
than as a free-for-all.

---

## 4. What each screen does

**Shooter.** A card on the session, above the shot list. Idle it offers **● go live**
(start one, get the code) and **join** (put yourself on someone else's code as the second
shooter). Live it shows the code, the roster, your partner's running score and string,
and the feed. Your partner's impacts appear on your own group plot as **dashed hollow
rings in their colour**, with a legend saying outright that they are relayed and are *not*
part of your group statistics — because a partner's shots silently inflating your own ES
would be a genuinely dangerous bug.

Leaving the session does not end the relay; the home screen keeps a live strip that taps
back into it. The shooter who started it sees **end**; anyone else sees **leave**, which
frees their firing point without taking the coach's screen down.

Shots already fired are **backfilled** on going live or joining, so arriving at shot 8
does not present an empty target.

**Coach.** A full screen: both strings on one target first — that combined plot is the
coach's actual question, *are these two groups in the same place or is one fighting a
different wind* — then a card per shooter with score/X, mean radius, ES, shot count and
the shot list. Called shots are marked with how far off the call was. No control anywhere
logs a shot.

The relay is a *projection*, not a system of record. Each shooter's local session stays
the source of truth on their own device; `relay_shots` is a view of it that expires.

---

## 5. Before it works on a real project

1. `supabase db push` (or paste `0001`–`0004` into the SQL editor, in order).
2. **Enable anonymous sign-ins**: Supabase dashboard → Authentication → Providers →
   Anonymous. It ships **disabled**, and with it off a coach cannot join at all. The app
   names this failure explicitly rather than showing a generic error, because it is the
   single most likely first-run problem.
3. Consider CAPTCHA on anonymous sign-ins if the app ever goes public.

Relays expire on their own; nothing needs pruning by hand.

---

## 6. What is verified

| | |
|---|---|
| `supabase/test/rls_test3.sql` | 27 assertions. A stranger cannot list relays, read one by id, read the shot string, enumerate participants, or self-insert a participant row. Wrong codes trip the throttle *and the attempt rows survive*. The `>=` cursor returns two shots sharing one timestamp. The code dies when the relay ends or expires. |
| `supabase/test/rls_test4.sql` | 34 assertions, two shooters and a coach. Both shooters number from 1 without colliding; neither can write, rewrite or delete the other's rows; the coach can write none; everyone reads everything; slots stick across a rejoin and are reused after someone leaves; each shooter carries their own firing distance; no auth id is exposed; an ended relay accepts nothing. |
| `packages/zero-core` | 98 assertions, 21 of them pair fire: role and slot come from the server, shots sort by firing point, `is_self` separates your string from your partner's, a coach is refused client-side before a request is even sent. |
| `apps/zero/test-relay.mjs` | 62 assertions across **three real browser profiles**, driving the actual buttons — nothing calls the relay API to make something appear. The call-error seeds are chosen so the answer is exact arithmetic (impacts 1.0472in above their calls at 100yd is 1.00 MOA), and the two shooters are put on different lines so a relay-wide conversion would be caught. One shooter's offset clears its interval and the other's does not, so both the confirmed and unconfirmed presentations are asserted — including that nothing is ever withheld behind a dash. Negative control: dropping the prop that overlays the partner's string fails five assertions. |

The browser suites run against `packages/zero-core/mock-supabase.mjs`, a mock of GoTrue
and PostgREST. That mock encodes an understanding of Supabase's endpoints, which is
exactly the thing that could be wrong — **the first run against a real project is the
test that counts.**

---

## 7. A trap worth knowing about

`Zero.jsx` carries zero-core **inline**, because the single-file build has to open
straight off disk with no bundler. That copy used to be maintained by hand, and during
this work it drifted: the relay client gained per-shooter attribution in
`packages/zero-core` while `Zero.jsx` kept the old host-only version. The symptom was a
second shooter whose shots silently never mirrored, and every obvious suspect — RLS, the
join flow, the mock — was innocent.

It is a generated region now, fenced by `//#region zero-core` markers and rewritten by
`tools/embed-core.mjs` as part of `npm run build`. `npm test` runs it with `--check`, so
drift is a red build rather than an afternoon spent debugging the wrong file.
