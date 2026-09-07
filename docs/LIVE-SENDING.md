# Live sending

How to make `https://<your-deployment>/shop` put a real email in a stranger's
inbox, on free tiers, without getting the sending account suspended.

This document is deliberately blunt about what is **not** achievable for free,
because the alternative is a demo that promises an SMS and silently sends nothing.
Read [What you cannot do free](#what-you-cannot-do-free) before you read the setup.

---

## The shape of it

```
visitor fills in /shop
        │
        ▼
POST /storefront/checkout          packages/api/src/routes/storefront.ts
   contact  ──▶ contacts
   consent  ──▶ contact_consents        (with ip, user-agent, timestamp)
   order    ──▶ orders
        │
        ▼
evaluateTrigger('order_placed')    packages/core/src/triggers/trigger-evaluator.ts
   enrolment + rendered messages ──▶ message_queue
        │
        ▼
flushMessages(ids)                 packages/core/src/delivery/orchestrator.ts
   claimSpecific  → FOR UPDATE SKIP LOCKED
   deliverClaimed → the eight gates → provider.send   ← the ONLY call site (I1)
        │
        ▼
Brevo / Postmark / Twilio          packages/providers/
```

The send happens **inside the HTTP request**, which is why the demo is measured in
seconds rather than in queue ticks. It is not a second send path: `flushMessages`
claims through the same statement and delivers through the same `deliverClaimed`,
so every gate still runs and `tests/unit/architecture.test.ts` still proves there
is exactly one call site of `provider.send`.

---

## What you cannot do free

Three honest limits, in decreasing order of how much they hurt.

### 1. SMS to an Indian number needs a registered business

India's TRAI regulations require every commercial A2P sender ID and every message
template to be registered on a **DLT** platform, which requires a registered
business entity, GST details and per-header fees. Without it, messages to `+91`
numbers are rejected by the carrier — this is a regulatory limit, not a Twilio
one, and no provider can route around it.

### 2. A Twilio trial only reaches numbers you have verified

Trial credit is real, but a trial account can only send to phone numbers added to
its Verified Caller IDs list. That is fine for you testing your own phone; it is
useless for "anyone who visits the link".

### 3. Resend and most others need a domain you own

Resend's free tier is 3,000/month, but without a verified sending domain you may
only send to your own account address. If you own a domain, Resend is excellent.
If you do not, it cannot serve a public storefront.

### What that leaves

| Goal | Free? | How |
| --- | --- | --- |
| Email to any visitor | **yes** | Brevo SMTP, 300/day, no card, no domain required |
| Email to any visitor, good deliverability | no | needs a domain you can add DNS records to |
| A WhatsApp message to any visitor, worldwide | **yes, with an opt-in step** | Twilio WhatsApp sandbox — the visitor sends a join code first |
| Plain SMS to any visitor | no | needs an upgraded Twilio account, and for `+91` a DLT registration |

The storefront tells the visitor which of these is true of *your* deployment, from
`GET /storefront/config`, before it renders the form. Do not defeat that by
claiming more in a README than the deployment does on the page.

---

## Email — Brevo, 300/day, no card

Brevo is the recommendation because it is the only free tier that will send to an
address you do not own, from a sender you can verify **without owning a domain**.

1. <https://www.brevo.com> → sign up. No card.
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender.** Use an address
   you can open — Brevo emails it a confirmation link. Click it.
3. **SMTP & API → SMTP.** Note:
   - server `smtp-relay.brevo.com`, port `587`
   - **Login** — an address of the form `<digits>@smtp-brevo.com`, *not* your
     account email
   - **Master password / SMTP key** — generate one. This is **not** your account
     password.
4. Set these on the deployment:

   | Key | Value |
   | --- | --- |
   | `SMTP_HOST` | `smtp-relay.brevo.com` |
   | `SMTP_PORT` | `587` |
   | `SMTP_USER` | the `…@smtp-brevo.com` login |
   | `SMTP_PASS` | the SMTP key |
   | `SMTP_FROM` | the sender you verified in step 2 |

**Expect the first messages to land in spam.** A free shared IP with no SPF, DKIM
or DMARC for your sending domain is exactly what a spam filter is built to catch.
If you own a domain, authenticate it in Brevo and use an address on it — that one
change is worth more than everything else on this page. If you do not, tell people
to check their spam folder; it is a limitation of the free tier, not of the code.

Any SMTP provider works — the adapter is `packages/providers/src/smtp.ts` and it
speaks plain SMTP. Gmail (`smtp.gmail.com:587`, 2FA plus an App Password, 500/day)
will work and is a bad idea: Google's terms do not contemplate this, deliverability
to non-Gmail recipients is poor, and the downside risk is your personal account.

---

## WhatsApp — the Twilio sandbox, free, worldwide

The only free channel that reaches an arbitrary handset anywhere, including India,
because it is not SMS and therefore not subject to DLT.

1. <https://www.twilio.com/try-twilio> → sign up.
2. **Messaging → Try it out → Send a WhatsApp message.** Twilio shows a sandbox
   number (usually `+1 415 523 8886`) and a join phrase like `join amber-tiger`.
3. Set:

   | Key | Value |
   | --- | --- |
   | `TWILIO_ACCOUNT_SID` | `AC…` from the console dashboard |
   | `TWILIO_AUTH_TOKEN` | from the console dashboard |
   | `TWILIO_FROM` | `whatsapp:+14155238886` — the `whatsapp:` prefix is what selects the channel |
   | `TWILIO_WHATSAPP_JOIN_CODE` | `amber-tiger` — just the phrase, no `join` |

`TWILIO_WHATSAPP_JOIN_CODE` is not used to send anything. It is rendered on the
storefront so a visitor is told to opt in *before* they place the order, rather
than discovering afterwards that Twilio rejected the message with `63016`.

The `whatsapp:` prefix is applied to the recipient automatically —
`whatsappAware()` in `packages/providers/src/twilio.ts`. It is applied at the edge
because `contacts.phone` is constrained to bare E.164 by `contacts_phone_is_e164`,
so a stored `whatsapp:+91…` would violate the schema.

Sandbox limits worth knowing: the opt-in expires after 72 hours of inactivity, and
a session allows free-form messages for 24 hours after the recipient's last
message. Both are Meta's rules, not Twilio's.

### If you do want real SMS

Upgrade the Twilio account, buy a number, and set `TWILIO_FROM` to it in bare
E.164 (`+1…`). Then: US destinations need 10DLC or toll-free verification, UK and
most of Europe work with an alphanumeric sender ID, and India needs DLT. Budget a
few dollars and a few days for the registrations.

---

## Turning it on

Set on the **Render web service** (which is what serves `/shop` and runs the
checkout flush):

| Key | Value | Why |
| --- | --- | --- |
| `SEND_MODE` | `live` | anything else and the flush refuses **before** claiming a row (I2) |
| `PUBLIC_BASE_URL` | the public https URL | every unsubscribe and tracking link is built from it (I7) |
| `SMTP_*` | above | |
| `TWILIO_*` | above | |
| `STOREFRONT_DAILY_SEND_BUDGET` | `250` | live sends per rolling 24h, deployment-wide |
| `STOREFRONT_ADDRESS_COOLDOWN_SECONDS` | `60` | minimum gap between two orders for one address |
| `MOCK_FAILURE_RATE` | `0` | only matters if you stay in `mock` mode; see below |
| `MOCK_BOUNCE_RATE` | `0` | ditto |

Set the same `SEND_MODE`, `SMTP_*` and `TWILIO_*` on the **worker** (the GitHub
Actions secrets, or the Render Background Worker) only if you want the *seeded*
campaigns — welcome series, win-back — to go out for real as well. You almost
certainly do not: those target 500 fabricated contacts at `@example.com`
addresses. **Leave the worker on `SEND_MODE=mock`.** The storefront does its own
sending inside the request and does not need the worker to be live.

### One subtlety worth knowing

The API is live and the worker is mock, which sounds contradictory and is not. The
storefront's send happens inside the checkout request, in the API process, so that
is the process that needs the credentials. The worker drains everything *else* —
the seeded welcome series, the win-back — and those target 500 fabricated
`@example.com` contacts.

The seam: a storefront message that the flush could not complete — deferred by a
gate, or a transient provider error scheduled for retry — is left in the queue and
picked up by the worker on its next tick, which will send it through the *mock*
provider. The row will say `provider: mock`, which is the truth about what
happened. That is the safe direction for the mistake to run in; if you want those
retries to go out for real, give the worker the same credentials and accept that
the seeded campaigns go live too.

Then reseed, because the storefront's campaign is new:

```bash
export DATABASE_URL='<your connection string>'
npm run migrate
npm run seed:demo
npm run demo:simulate
npm run rollups:rebuild
```

### Verify it end to end

```bash
BASE=https://<your-deployment>

# 1. What does the deployment admit to?
curl -fsS "$BASE/api/storefront/config" | jq '{sendMode, channels, budget}'

# 2. Place an order at your own address.
curl -fsS -X POST "$BASE/api/storefront/checkout" \
  -H 'content-type: application/json' \
  -d '{"name":"Your Name","email":"you@example.com","items":[{"sku":"CE-MUG","qty":1}],"marketingConsent":true}' \
  | tee /tmp/checkout.json | jq '{orderNumber, queued, flushed, notes}'

# 3. Read what the engine decided.
curl -fsS "$BASE/api/storefront/receipt/$(jq -r .receiptToken /tmp/checkout.json)" \
  | jq '{messages: [.messages[] | {channel,status,provider,errorCode}], decisions: [.decisions[] | {stage,reasonCode}]}'
```

`flushed.sent` is the number that matters. If it is `0`, the `decisions` array
says why — that is the whole point of the project, and the answer is in the
response rather than in a log you have to go and find.

---

## Failure modes, and where they say so

| What you see | Where to look | Usual cause |
| --- | --- | --- |
| `flushed.refusedWithoutClaim: true` | — | `SEND_MODE` is not `live`. The row was not claimed and no attempt was burned (I2). |
| `no_recipient_address` on a *send* decision | `send_decisions` | Live mode, no `provider_credentials` row **and** no `SMTP_*`/`TWILIO_*` in the environment. |
| `no_recipient_address` on a *schedule* decision | `send_decisions` | The contact has no address on that channel — usually the visitor left the phone field blank. Working as designed. |
| `storefront_not_seeded` (409) | — | `npm run seed:demo` has not run against this database, or `STOREFRONT_TENANT_NAME` does not match a tenant. |
| Twilio `63016` | `provider_error_code` | The recipient has not joined the WhatsApp sandbox. |
| Twilio `21608` | `provider_error_code` | Trial account, recipient not a Verified Caller ID. |
| Twilio `21910` | `provider_error_code` | `From` and `To` are on different channels — should be impossible now `whatsappAware` exists; if you see it, that function has regressed. |
| SMTP `535` | `provider_error_message` | Using the account password instead of the SMTP key, or the wrong `SMTP_USER`. |
| Email sends but nobody receives it | the recipient's spam folder | Free shared IP, unauthenticated domain. See the Brevo section. |
| `frequency_cap` | `send_decisions` | The same address ordered more than `freq_cap_count` times inside `freq_cap_window`. The seed sets 10 per channel per 7 days. |

---

## The abuse question, answered honestly

An unauthenticated endpoint that sends email to an address in the request body is,
stated plainly, an open relay with extra steps. It is defensible here because of
what it *cannot* be made to do, not because of good intentions:

- The recipient is the person filling in the form. There is no field that
  addresses a message to a third party, and no free-text body — the content comes
  from a seeded template.
- Per-IP rate limit: 20 requests/minute on its own bucket, separate from the
  3,000/minute public bucket that exists for tracking pixels.
- Per-address cooldown, so the same mailbox cannot be targeted by resubmission
  from a rotating IP pool.
- A deployment-wide daily budget counted **in the database**, so it survives a
  restart. When exhausted the checkout still records everything and simply hands
  nothing to a provider.
- The gate chain runs, so suppressions, complaints and prior opt-outs are honoured
  on this path exactly as on every other.
- A honeypot field, which stops the unsophisticated half for free.

If someone determined enough to rotate IPs and mailboxes wants to burn 250
messages a day out of a free Brevo account, they can. The cost of that is the demo
stops sending until tomorrow, which is why the budget exists and why it is set
below the provider's own limit.
