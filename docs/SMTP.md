# Custom SMTP — a plan, not a change

**Status:** wireframe. Nothing here is implemented. Written so the work can be
picked up cold.

Everything that emails a customer currently goes through Supabase's built-in
sender, which is **rate-limited to a few messages per hour and explicitly not
for production**. That limit is not a nuisance to work around; it is Supabase
declining to let its shared IP be used as your mail server. Until this is
replaced:

- the owner dashboard's **Send password reset** and **Resend confirmation** will
  fail, quietly and intermittently, once more than a couple of people need them
  in the same hour;
- **sign-up confirmation emails do not reliably arrive**, which is the single
  most common cause of "it will not let me in" — the thing the support table's
  `Never confirmed` tile counts;
- there is no self-serve *Forgot password* in either app, because it would be
  built on a sender that cannot be relied on.

---

## 1. The decision to make first

Which sender. This is the only choice with real consequences; everything after
it is configuration.

| | Free tier | Notes |
|---|---|---|
| **Resend** | 3,000/mo, 100/day | Simplest setup, good deliverability, made for transactional mail. The default recommendation. |
| **Postmark** | 100/mo trial, then paid | Best-in-class transactional deliverability and the clearest bounce reporting. Worth it if email problems become support load. |
| **AWS SES** | 62,000/mo from EC2, else $0.10/1,000 | Cheapest at volume, most setup, and starts in a sandbox that can only send to verified addresses until you request production access. |
| **Gmail / Workspace SMTP** | — | **Do not.** Sending limits are low, it is not transactional mail, and a bounce can affect the account you run the business from. |

**Recommendation: Resend**, on the free tier, moving to Postmark only if
deliverability becomes a recurring support topic. The volumes here are a handful
of messages a day.

## 2. What has to be true before any of it works

**A domain you control.** Auth mail cannot be sent convincingly from
`github.io`. Whatever domain the marketing site ends up on is the one to use —
`noreply@<yourdomain>`.

Three DNS records, all at the registrar, all of which take up to a few hours to
propagate:

- **SPF** — a `TXT` record saying this sender may send for the domain.
- **DKIM** — a `TXT` (or `CNAME`, provider-dependent) record carrying the
  signing key. This is the one that decides whether Gmail trusts the message.
- **DMARC** — a `TXT` at `_dmarc.<domain>`. Start at `p=none`, which reports
  without rejecting, and tighten later once the reports are clean.

Skipping DKIM is the usual reason a correctly configured sender still lands in
spam.

## 3. Supabase side

Dashboard → **Project Settings → Authentication → SMTP Settings**:

```
Host           smtp.resend.com
Port           465        (587 if 465 is blocked)
Username       resend
Password       <the API key — a project secret, never committed>
Sender email   noreply@<yourdomain>
Sender name    Zero Suite
```

Then **Authentication → Rate Limits**, which stays at the default built-in
values until custom SMTP is on. Raise the recovery/confirmation limits to
something sane — a few dozen an hour — but not to unlimited: that limit is what
stops the reset endpoint being used to mailbomb one of your customers.

**Templates** live under Authentication → Email Templates. The defaults are
functional and unbranded. Worth a pass, because these are often the first thing
a new customer reads from you. Keep the `{{ .ConfirmationURL }}` token exactly
as-is.

**Redirect URLs** — Authentication → URL Configuration. The confirmation and
recovery links come back to the app, so the app's origin must be in the allow
list or the link dead-ends. Zero already reads a session out of the URL fragment
on load (`adoptSessionFromUrl`), so a confirmation link lands correctly once the
URL is allowed.

## 4. The app work this unblocks

Roughly a day, after SMTP is live. In the order that delivers the most first:

1. **Forgot password in both apps.** `zero-core` already has the client half —
   `signInWithOtp` exists, and a `recover` call is the same shape. The UI is a
   link under the sign-in form, an email field, and a "check your inbox" state.
   *This is the item that removes most support load*, because it means the owner
   tools are the exception rather than the route.
2. **A "resend confirmation" link on the sign-in screen**, shown when a sign-in
   fails specifically because the address is unconfirmed. Right now that user
   has no self-serve path at all.
3. **Bounce visibility.** Resend and Postmark both webhook on bounce. A bounced
   address is worth recording next to the account, because "never confirmed" and
   "confirmation bounced" look identical on the support screen today and have
   completely different fixes.

## 5. How to know it worked

- Supabase → Logs → **Auth** shows the send and its result.
- Send a reset to an address on Gmail, one on Outlook, and one on iCloud. Those
  three disagree about spam more than any others.
- Check the message's **Authentication-Results** header: `spf=pass`,
  `dkim=pass`, `dmarc=pass`. Anything less is a DNS record not yet propagated or
  not yet correct.
- The dashboard's own **Send password reset** button should stop returning the
  502 it currently returns when the built-in limit is hit.

## 6. Two things worth not doing

**Do not put the SMTP password anywhere in this repo.** It goes in the Supabase
dashboard only. The publishable key in `supabase.config.json` is public by
design; this one is not, and the difference is the whole security model.

**Do not raise the auth rate limits to unlimited** once custom SMTP removes the
built-in ceiling. The reset endpoint is unauthenticated by necessity — anyone
can ask for a reset for any address — and the rate limit is the only thing
between that and using your domain to flood somebody's inbox.
