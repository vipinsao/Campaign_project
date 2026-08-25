# The sixty-second demo

A numbered click-through with the screen states to expect. If any step does not
match, that is a bug — please open an issue.

## Setup

```bash
git clone https://github.com/vipinsao/campaign-engine
cd campaign-engine
npm install
npm run dev          # boots PostgreSQL, migrates, starts api + worker + web
```

No Docker daemon, no root, no accounts, no API keys. In a second terminal:

```bash
npm run seed:demo     # deterministic: 500 contacts, 1,200 orders, 5 campaigns
npm run demo:simulate # replays 30 days in about a minute
```

Sign in at http://localhost:5173 with `operator@example.com` /
`demo-password-change-me`.

## What to look at, in order

### 1. `/campaigns` — the list (10 seconds)

Five campaigns. Note the **status pills**: four `active`, one `observe`. Observe
mode evaluates and logs every decision but queues nothing — it is how a new campaign
is shipped for a day before anyone is contacted.

Note also that some rates read **`—`, not `0%`**. That is deliberate: a zero
denominator means "we cannot know this yet", and rendering it as zero would assert
something the data does not support.

### 2. `/inspect` — the page that matters (25 seconds)

**This is the one to spend time on.** Type an order number from the seed — try
`ORD-10001` — and press enter.

- If two stores share that number you get an **ambiguity chooser** listing both
  candidates with masked emails. It does not pick one. Order numbers are unique per
  store, not globally, and picking the most recent match sends one customer's
  details to a different customer.
- Once resolved, you see three groups: **sent** (with timestamps and events),
  **pending** (with the scheduled send time), and — the interesting one —
  **did not fire**, each row carrying the exact reason from the decision log.

Look for reasons like `quiet_hours_deferred`, `frequency_cap`,
`consent_opted_out`, `suppressed_hard_bounce`. Every one of those is a message the
system deliberately did not send, and it can say why.

### 3. `/campaigns/:id` → **Schedule** tab (10 seconds)

The **timezone preview strip**. A message scheduled for 09:00 shows what time six
representative contacts actually receive it. This is invariant I5 made visible:
quiet hours are computed in the *recipient's* timezone, never the server's.

Try narrowing the campaign window and watch it clamp against the tenant floor. Try
widening it past the floor and watch it refuse.

### 4. `/campaigns/:id` → **Analytics** tab (10 seconds)

Hover any rate. The tooltip names its **denominator**. Open rate is unique opens ÷
*delivered*, not ÷ sent — a bounced message is not somebody who chose not to open.
Click rate's denominator excludes messages that contained no link.

Switch the channel filter to SMS. **There is no open rate.** There is no such thing
as an SMS open, and rendering one would be inventing a number.

### 5. `/queue` and `/mock-outbox` (5 seconds)

The queue shows failed rows with **the provider's own error code and class** —
terminal errors were never retried. The mock outbox shows what actually went out,
including the bounces and complaints the mock provider simulated, in a phone-shaped
view for SMS.

## The thing to try if you have another minute

Open the preference centre from any message in the mock outbox and unsubscribe.
Then reload `/queue`. **The messages already queued for that contact are now
cancelled**, not merely stopped from being queued in future. An opt-out that
honours only future messages has not listened.
