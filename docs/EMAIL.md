# Email — routing, and a drafting assistant

**Status:** wireframe. Nothing here is implemented. Companion to [SMTP.md](SMTP.md),
which covers the sender itself.

Two separate systems that must not become one:

- **Transactional** — password resets, confirmations. Machine-generated, template,
  must arrive. Never touched by an assistant.
- **Conversational** — customers writing to a person. Judgment, voice, and the
  thing worth drafting help for.

---

## 1. Routing, and why it is about reputation rather than tidiness

Three streams, three addresses, and the separation exists because **deliverability
is per-sending-domain**. Mail that people mark as spam poisons the reputation of
the domain that sent it. If marketing and password resets share a domain, a
campaign somebody finds annoying degrades delivery of the email a customer needs
in order to get into their account. That is the failure to design against, and it
is not reversible on a schedule you control.

| Stream | Address | Sent by | Read by |
|---|---|---|---|
| Transactional | `noreply@<domain>` | Supabase Auth → Resend (SMTP.md) | nobody — see below |
| Conversational | `support@<domain>` | a person, drafted by the assistant | you |
| Marketing (later) | `news@news.<domain>` | whatever you send campaigns with | nobody |

**Use a subdomain for marketing.** `news.<domain>` gets its own DKIM key and
accumulates its own reputation, so a bad campaign cannot reach the domain your
auth mail leaves from. Transactional and support can share the root domain —
neither generates complaints.

### `noreply@` must not actually be a hole

The name is a lie people tell that costs them customers: someone *will* reply to a
password-reset email, usually the one person most confused and most in need of an
answer. Two lines of configuration:

- Set **`Reply-To: support@<domain>`** on the auth templates, so a reply lands
  where a human is.
- Failing that, forward `noreply@` to `support@`.

What you must not do is let it bounce into nothing.

### DNS, once, at the registrar

- `<domain>` — SPF + DKIM for Resend, covering `noreply@` and `support@`.
- `news.<domain>` — its own SPF + DKIM, separate key.
- `_dmarc.<domain>` — one record, `p=none` to start, covering both.

### Where Supabase fits

Supabase Auth has exactly one **Sender email** field, so all transactional mail
leaves from one address. That is fine — it is the stream that should be uniform.
The assistant never has credentials for it, never reads it, and cannot send as it.
The separation is enforced by the assistant only ever being connected to
`support@`.

---

## 2. The drafting assistant

**Every send is approved by you. Nothing goes out unattended.** That is not a
limitation to engineer around — it is the property that makes the rest safe, and
the design should make approving genuinely easy rather than make it optional.

### Where the drafts live

**In Gmail, as real drafts.** Not in a custom UI.

This matters more than it sounds. It means approval happens wherever you already
read mail, including on a phone at a range: open the thread, read the draft, edit
a word, hit send. No second system to check, nothing to keep in sync, and if the
assistant stops running tomorrow you are left with an ordinary mailbox rather than
a broken workflow.

### State lives in Gmail labels

So a run cannot double-draft a thread and cannot lose track after a crash:

```
Zero/triaged      seen by a run, classified
Zero/drafted      a reply is waiting in drafts
Zero/escalate     needs you, deliberately not drafted
Zero/sent         you approved and sent it
```

The label IS the state. No local file to drift out of sync with the mailbox.

### What runs every six hours

1. Search `support@` for threads with a customer message newer than the last
   reply, excluding anything already labelled `Zero/drafted` or `Zero/escalate`.
2. Classify each against the ruleset (§3).
3. **Escalate** → label, no draft.
4. **Draftable** → retrieve the closest past threads you answered (§4), write a
   reply in your voice, save as a Gmail draft, label `Zero/drafted`.
5. One notification: how many drafted, how many escalated, and the escalations by
   subject so you can judge urgency without opening anything.

Six hours is a good interval for support that is not promising same-hour replies.
It also bounds the damage of a bad run: at most six hours of drafts, all unsent.

### Learning your voice

Two mechanisms, because they do different jobs:

**A style profile** (`docs/email-voice.md`, written once and edited by hand
afterwards). Derived by reading a few hundred of your *sent* messages and writing
down what is consistent: greeting and sign-off, sentence length, contractions or
not, how you say no, how you apologise, how long a typical answer to each kind of
question runs, vocabulary you use and vocabulary you never use. A file you can
read and correct — not weights, not an opaque profile. When a draft sounds wrong,
you fix the sentence in that file that produced it.

**Retrieved examples,** which is the part that actually works. At draft time,
search your sent mail for the three or four most similar questions you have
already answered, and write the new reply against those. Style transfer from
concrete nearby examples beats any abstract description of a voice, and it
improves on its own as you answer more mail.

**Only your sent mail is learned from** — not what customers write, and not the
quoted text underneath your replies.

### No corpus leaves Gmail

Searching at draft time rather than exporting an archive is deliberate. Your sent
mail contains customers' names, addresses and problems; the moment it is copied
into a repo or an index it is a second place that data lives, with its own backup
and its own leak. The only artifacts stored are the style profile — which contains
your habits and nobody's personal data — and the ruleset.

---

## 3. The ruleset

A file, version-controlled, read at the start of every run. Three tiers.

### Never drafted, always escalated

- **Anything about load data, powder charges, pressure, or "is this safe".**
  The apps refuse to give load data as a hard design boundary, stated in
  `docs/bench-design.md §7`. Customer email is exactly where someone asks anyway,
  and a friendly plausible answer from an address with the product's name on it
  undoes that boundary in writing. This is the single most likely way an email
  assistant does real harm here, because the question sounds helpful and the
  answer sounds easy.
- Refunds, chargebacks, cancellations, anything about money.
- Legal, liability, injury, or an accident of any kind.
- Press, partnership, bulk licensing.
- Anyone angry. A correct answer delivered to someone who wants to be heard first
  makes it worse.
- Anything the classifier is not confident about. Uncertainty escalates.

### Drafted for approval

The ordinary body of support: cannot sign in, confirmation email never arrived,
how do I install it, does it work offline, how does pair fire work, what does this
number mean, feature requests, bug reports, "how do I export my data".

### Auto-sendable

**Empty, and it starts empty on purpose.** Run the thing for a month, then look at
which drafts you sent *unedited* every single time. Those categories — and only
those, named one at a time — are candidates. Promoting from evidence rather than
from a guess is the whole difference between this being useful and being a
liability with your name on it.

---

## 4. Keeping approval real

The failure mode of an approval step is not that it is skipped. It is that it
becomes a reflex: fifty good drafts in a row train you to press send without
reading, and the fifty-first is the one that mattered.

Three things that push against it:

- **Every draft says what it was modelled on** — the past thread it followed —
  so you can tell a confident answer from a guess dressed as one.
- **Escalations get no draft at all.** Not a draft with a warning: nothing. There
  must be no version of the risky path where sending is one tap away.
- **Anything you edit before sending is worth recording.** The edits are the
  training signal, and reviewing a month of them is how the style profile and the
  ruleset improve. That is the self-improvement loop, and it runs on your
  corrections rather than on the assistant's opinion of its own output.

---

## 5. Build order

1. **`support@` on Google Workspace** and the DNS from SMTP.md. Nothing else works
   without an address to work on.
2. **The ruleset file**, before any code. It is the part that decides whether this
   is safe, and it is worth arguing about while it is cheap to change.
3. **Triage only** — the scheduled run labels and notifies, drafts nothing. A week
   of this tells you whether the classifier understands your mail, at zero risk.
4. **Add drafting** for the middle tier.
5. **Style profile**, once there are drafts to react to. Written against real
   output rather than in the abstract.
6. **Consider auto-send** for one narrow category, if a month of evidence supports
   it. Or never — the drafting is where the time saving is.

Steps 1–3 are most of the value and carry almost no risk. There is no need to
reach step 6 for this to be worth building.
