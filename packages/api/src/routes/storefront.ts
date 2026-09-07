import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { evaluateTrigger, flushMessages, query, queryOne, type DeliveryDeps } from '@campaign/core';
import {
  MockProvider,
  classify,
  describeEnvSender,
  mockRatesFromEnv,
  nextAttemptDelayMs,
  resolveProvider,
  resolveSenderFor,
} from '@campaign/providers';
import type { Channel, MessageProvider } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { badRequest, conflict, notFound, tooManyRequests } from '../errors.ts';

/**
 * The storefront — a real checkout, wired to the real engine.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Everything else in this repository is true and none of it is visible. A reviewer
 * with sixty seconds does not read INVARIANTS.md; they click something, and either
 * a message arrives on their own phone or it does not. This route is the click.
 *
 * A stranger places an order on a toy shop. That writes a contact, a consent
 * record and an order — the same three tables the seed script writes — which fires
 * `order_placed`, which enrols them in a campaign, which renders and queues an
 * email and an SMS, which go out through the same eight gates and the same single
 * call site of `provider.send` as everything else. Nothing here is a demo path
 * around the engine; it is the front door of the engine.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS PUBLIC, AND WHAT THAT COSTS
 *
 * An unauthenticated endpoint that causes real email to be sent to an address
 * supplied in the request body is, stated plainly, an open relay with extra steps.
 * The mitigations are not optional and each one is here for a stated reason:
 *
 *  - The recipient is the person filling in the form, and there is no field that
 *    lets them address a message to anybody else. There is no free-text body.
 *  - A per-IP rate limit on its OWN bucket — 20/min, not the 3,000/min public one —
 *    and a per-address cooldown, so one mailbox cannot be targeted by repeated
 *    submission from a rotating address pool.
 *  - A DEPLOYMENT-WIDE DAILY BUDGET, counted in the database rather than in
 *    memory, because the process restarts and the budget must not. When it is
 *    exhausted the checkout still works and still records everything; it simply
 *    does not hand anything to a live provider. A free email tier that gets an
 *    account suspended for abuse takes the demo down permanently, which is a worse
 *    outcome than a demo that stops sending at 21:00.
 *  - A honeypot field, which costs nothing and stops the unsophisticated half.
 *  - Suppressions and prior opt-outs are respected, because the gate chain runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SEND IS SYNCHRONOUS
 *
 * The queue drains on a timer: every minute on a dedicated worker, every five on
 * the GitHub Actions worker this project uses to stay free. A stranger watching a
 * checkout screen will not wait five minutes, and a demo that appears to do
 * nothing is indistinguishable from one that is broken.
 *
 * So the checkout awaits `flushMessages` on exactly the rows it just enqueued.
 * That is not a second send path — `flushMessages` claims through the same
 * `FOR UPDATE SKIP LOCKED` and delivers through the same `deliverClaimed`, so the
 * gates and I1 hold — and it is not a scheduler, which is what
 * packages/api/src/no-scheduler.ts actually forbids. Nothing here repeats.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The shop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The catalogue is a constant, and that is a decision.
 *
 * A `products` table is the first step of becoming an order management system,
 * and the fastest way to make a portfolio project unfinishable is to let it
 * become one — `migrations/0003` says so in its own header. What the engine needs
 * from commerce is an order with a number, a total and some items; a price list
 * that never changes can live in the code that renders it.
 */
export const CATALOGUE = [
  { sku: 'CE-MUG', name: 'Enamel mug', price: 14, blurb: 'Holds coffee. Survives a dishwasher.' },
  { sku: 'CE-TEE', name: 'Cotton tee', price: 22, blurb: 'Heavyweight, boxy, one colour only.' },
  { sku: 'CE-CAP', name: 'Six-panel cap', price: 26, blurb: 'Adjustable. Unbranded on purpose.' },
  { sku: 'CE-TOTE', name: 'Canvas tote', price: 18, blurb: 'Large enough for a laptop.' },
  { sku: 'CE-BTL', name: 'Steel bottle', price: 32, blurb: 'Keeps things cold for a day.' },
  { sku: 'CE-NOTE', name: 'Dot-grid notebook', price: 12, blurb: 'A5, lies flat, 160 pages.' },
] as const;

const CURRENCY = 'USD';
const SKUS: ReadonlySet<string> = new Set<string>(CATALOGUE.map((p) => p.sku));

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export type StorefrontConfig = {
  /** The tenant orders are written to. Resolved by NAME, never by a literal id. */
  readonly tenantName: string;
  readonly storeCode: string;
  /** Live sends per rolling 24h across the whole deployment, per channel. */
  readonly dailyBudget: number;
  /** Minimum gap between two orders from the same address, in seconds. */
  readonly addressCooldownSeconds: number;
};

export function storefrontConfig(env: NodeJS.ProcessEnv = process.env): StorefrontConfig {
  const int = (name: string, fallback: number): number => {
    const parsed = Number(env[name]);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
  };
  return {
    tenantName: env['STOREFRONT_TENANT_NAME'] ?? 'Demo Store (seeded data)',
    storeCode: env['STOREFRONT_STORE_CODE'] ?? 'main',
    // 250 rather than Brevo's 300: the headroom is what leaves room for the
    // operator's own test sends on the day a reviewer finds the link on LinkedIn.
    dailyBudget: int('STOREFRONT_DAILY_SEND_BUDGET', 250),
    addressCooldownSeconds: int('STOREFRONT_ADDRESS_COOLDOWN_SECONDS', 60),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The public receipt token
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A capability, not an identifier.
 *
 * The order-status page has to be readable by someone with no account, so the URL
 * is the credential. The order's own UUID would nearly do — uuidv7 carries plenty
 * of entropy — but it is also the id that appears in operator screens, logs and
 * support conversations, and an identifier that leaks read access the moment it is
 * pasted anywhere is a bad identifier.
 *
 * So the token is the id plus an HMAC of it under the server secret. Stateless, so
 * it needs no column and no cleanup; unforgeable without the secret; and it says
 * exactly which order it grants, so there is no lookup that could return somebody
 * else's.
 */
export function mintReceiptToken(orderId: string, secret: Uint8Array): string {
  return `${orderId}.${receiptMac(orderId, secret)}`;
}

export function readReceiptToken(token: string, secret: Uint8Array): string | undefined {
  const split = token.indexOf('.');
  if (split <= 0) return undefined;
  const orderId = token.slice(0, split);
  const provided = Buffer.from(token.slice(split + 1), 'utf8');
  const expected = Buffer.from(receiptMac(orderId, secret), 'utf8');
  // Equalise before timingSafeEqual, which throws rather than returning false on a
  // length mismatch — and a length mismatch is itself a rejection.
  if (provided.length !== expected.length) return undefined;
  return timingSafeEqual(provided, expected) ? orderId : undefined;
}

function receiptMac(orderId: string, secret: Uint8Array): string {
  return createHmac('sha256', secret).update(`storefront-receipt:${orderId}`).digest('base64url');
}

// ─────────────────────────────────────────────────────────────────────────────
// Addresses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise to E.164, or say why not.
 *
 * `contacts_phone_is_e164` is a CHECK constraint, so a badly shaped number is a
 * 500 from the database rather than a message the person filling in the form can
 * act on. Doing it here turns "internal error" into "start with + and your country
 * code", which is the difference between a demo that works and one that looks
 * broken to everyone outside India.
 */
export function toE164(raw: string): { ok: true; phone: string } | { ok: false; why: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, why: 'empty' };
  // Everything a human types between the digits: spaces, dashes, dots, brackets.
  const compact = trimmed.replace(/[\s\-().]/g, '');
  const normalised = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  if (!normalised.startsWith('+')) {
    return {
      ok: false,
      why: 'A phone number needs its country code, starting with + — for example +919876543210 or +447700900123.',
    };
  }
  if (!/^\+[1-9][0-9]{6,14}$/.test(normalised)) {
    return { ok: false, why: `'${trimmed}' is not a valid international phone number.` };
  }
  return { ok: true, phone: normalised };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery deps for a request-scoped flush
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The same wiring the worker builds, for one request.
 *
 * Duplicated rather than imported because `packages/api` may not depend on
 * `packages/worker` — the boundary is enforced by eslint and by
 * tests/unit/architecture.test.ts, and it is the boundary that keeps a scheduler
 * out of the request-serving process. What is shared is the part that matters:
 * both call `flushMessages`/`processQueue` in core, which is where the gates and
 * the single send path live.
 */
export function storefrontDeliveryDeps(deps: ApiDeps, env: NodeJS.ProcessEnv): DeliveryDeps {
  const clock = deps.clock;
  const db = deps.db;
  // Rates from the environment, so a public deployment can turn off simulated
  // bounces. A stranger who places one order and lands on the 5% bounce branch
  // cannot tell a working simulation from a broken product.
  const rates = mockRatesFromEnv(env);
  const mockEmail = new MockProvider('email', { db, clock, ...rates });
  const mockSms = new MockProvider('sms', { db, clock, ...rates });

  return {
    db,
    clock,
    sendMode: deps.sendMode,
    workerId: `storefront-${process.pid}`,
    // Small on purpose. This flush exists to send the two or three messages one
    // checkout produced; draining a hundred rows inside a stranger's HTTP request
    // would make their latency a function of everyone else's backlog.
    batchSize: 10,
    resolveProvider: (channel: Channel, provider: string): MessageProvider => {
      if (provider === 'mock' || deps.sendMode === 'mock') {
        return channel === 'email' ? mockEmail : mockSms;
      }
      return resolveProvider(channel, provider, { db, clock, env });
    },
    // I11 lives in resolveSenderFor: every ACTIVE credential is read as a list and
    // walked, never taken with LIMIT 1. Shared with the worker so the two cannot
    // drift — two copies of a rule is one copy plus a future disagreement.
    resolveSender: (tenantId, channel) =>
      resolveSenderFor(db, { tenantId, channel, sendMode: deps.sendMode, env }),
    classifyError: (provider, code) => {
      const classification = classify(provider, code);
      return { class: classification.class, maxAttempts: classification.maxAttempts };
    },
    backoffMs: (attempts) => nextAttemptDelayMs(attempts, Math.random),
    maxAttempts: 5,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

const CheckoutBody = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().max(320),
  phone: z.string().max(32).optional(),
  items: z
    .array(z.object({ sku: z.string().max(32), qty: z.number().int().min(1).max(5) }))
    .min(1)
    .max(6),
  /** Explicit, unticked by default, and recorded with its evidence. */
  marketingConsent: z.boolean().default(false),
  /**
   * The honeypot. A real browser never fills it in because it is hidden; a script
   * that fills every input does. Named plausibly on purpose — `honeypot` is a
   * field name a bot author greps for.
   */
  website: z.string().max(200).optional(),
});

export function storefrontRoutes(
  deps: ApiDeps,
  env: NodeJS.ProcessEnv = process.env,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const config = storefrontConfig(env);

  /**
   * What this deployment can actually do, right now.
   *
   * The storefront asks before it renders, so a visitor is never invited to type a
   * phone number into a form that has nowhere to send it. Overstating this is the
   * one thing that would make the whole project look dishonest, so the endpoint
   * reports the configuration rather than an intention.
   */
  app.get('/storefront/config', async (c) => {
    const emailSender = describeEnvSender('email', env);
    const smsSender = describeEnvSender('sms', env);
    const whatsapp = (env['TWILIO_FROM'] ?? '').startsWith('whatsapp:');
    const joinCode = env['TWILIO_WHATSAPP_JOIN_CODE'];
    const live = deps.sendMode === 'live';
    const spent = await budgetSpent(deps);

    return c.json({
      currency: CURRENCY,
      catalogue: CATALOGUE,
      sendMode: deps.sendMode,
      channels: {
        email: {
          live: live && emailSender.configured,
          provider: live ? emailSender.provider : 'mock',
          detail: live
            ? emailSender.detail
            : 'This deployment runs in mock mode: the message is rendered, gated and recorded, and written to the mock outbox instead of a mailbox.',
        },
        sms: {
          live: live && smsSender.configured,
          provider: live ? smsSender.provider : 'mock',
          whatsapp,
          /**
           * The sandbox's join step, stated on the page rather than left to fail.
           *
           * Twilio's WhatsApp sandbox is the only free path that reaches an
           * arbitrary phone number anywhere in the world — A2P SMS to an Indian
           * number needs DLT registration and a registered business, and a Twilio
           * trial only reaches numbers the account holder has verified. The
           * sandbox's price for that is an opt-in: the recipient must message the
           * join code first, and until they do, every send is rejected with
           * Twilio's 63016.
           *
           * A demo that does not say so is a demo that silently fails for every
           * visitor. So the instruction is data from the server, because only the
           * server knows the code this deployment was configured with.
           */
          joinInstructions:
            whatsapp && joinCode !== undefined
              ? `Send the WhatsApp message "join ${joinCode}" to ${(env['TWILIO_FROM'] ?? '').replace('whatsapp:', '')} first. Twilio's sandbox will not accept a message to a number that has not joined it, and the receipt will show that rejection rather than hide it.`
              : null,
          detail: live
            ? smsSender.detail
            : 'This deployment runs in mock mode: the message is rendered, gated and recorded, and written to the mock outbox instead of a handset.',
        },
      },
      budget: {
        limit: config.dailyBudget,
        spent,
        remaining: Math.max(0, config.dailyBudget - spent),
      },
    });
  });

  app.post('/storefront/checkout', async (c) => {
    const body = CheckoutBody.parse(await c.req.json<unknown>());

    // The honeypot answers 200 and does nothing. A 400 tells the author of the
    // script exactly which field gave them away, and the next version omits it.
    if (body.website !== undefined && body.website.trim() !== '') {
      return c.json({ ok: true, orderNumber: 'CE-000000', receiptToken: null, messages: [] });
    }

    const email = body.email.trim().toLowerCase();

    let phone: string | undefined;
    let phoneNote: string | undefined;
    if (body.phone !== undefined && body.phone.trim() !== '') {
      const parsed = toE164(body.phone);
      if (!parsed.ok) throw badRequest('invalid_phone', parsed.why, { field: 'phone' });
      phone = parsed.phone;
    }

    const lines = body.items.map((item) => {
      const product = CATALOGUE.find((p) => (p.sku as string) === item.sku);
      if (!product) {
        throw badRequest('unknown_sku', `'${item.sku}' is not in the catalogue.`, {
          known: [...SKUS],
        });
      }
      return { sku: product.sku, name: product.name, qty: item.qty, price: product.price };
    });
    const total = lines.reduce((sum, l) => sum + l.price * l.qty, 0);

    const { tenantId, storeId } = await resolveStore(deps, config);

    // Per-address cooldown. The IP limit is upstream; this one stops the same
    // mailbox being targeted from a rotating address pool.
    const recent = await queryOne<{ placed_at: Date }>(
      deps.db,
      `SELECT o.placed_at
         FROM orders o JOIN contacts ct ON ct.id = o.contact_id
        WHERE o.tenant_id = $1 AND ct.email = $2::citext
        ORDER BY o.placed_at DESC
        LIMIT 1`,
      [tenantId, email],
    );
    if (recent) {
      const elapsed = (deps.clock.now().getTime() - recent.placed_at.getTime()) / 1000;
      if (elapsed < config.addressCooldownSeconds) {
        const wait = Math.ceil(config.addressCooldownSeconds - elapsed);
        throw tooManyRequests(
          `An order was already placed for this address ${Math.floor(elapsed)}s ago. ` +
            `Wait ${wait}s — the cooldown is what stops this form being used to mailbomb somebody.`,
          { retryAfterSeconds: wait },
        );
      }
    }

    const contact = await upsertContact(deps, {
      tenantId,
      email,
      phone,
      name: body.name.trim(),
      ip: clientIp(c.req.header('x-forwarded-for'), c.req.header('x-real-ip')),
      userAgent: c.req.header('user-agent') ?? '',
      marketingConsent: body.marketingConsent,
    });
    if (contact.phoneNote !== undefined) phoneNote = contact.phoneNote;

    const order = await insertOrder(deps, {
      tenantId,
      storeId,
      contactId: contact.id,
      total,
      items: lines,
    });

    // The engine, from here on. Everything above was commerce.
    const outcome = await evaluateTrigger(
      { db: deps.db, clock: deps.clock, publicBaseUrl: deps.publicBaseUrl },
      { type: 'order_placed', tenantId, orderId: order.id },
    );

    const queued = await query<{ id: string }>(
      deps.db,
      `SELECT id FROM message_queue
        WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending'
        ORDER BY scheduled_at`,
      [tenantId, order.id],
    );

    /**
     * The budget check sits BETWEEN the enqueue and the flush, deliberately.
     *
     * Enqueueing is free and reversible; handing an address to a provider is
     * neither. Refusing here means an exhausted budget still produces a complete,
     * inspectable journey — enrolment, rendered message, decision rows — and the
     * only thing missing is the irreversible part. Refusing earlier would make the
     * whole page go blank, which teaches the visitor nothing.
     */
    const spent = await budgetSpent(deps);
    const overBudget = deps.sendMode === 'live' && spent + queued.length > config.dailyBudget;

    const flushed = overBudget
      ? { claimed: 0, sent: 0, failed: 0, deferred: 0, skipped: 0, refusedWithoutClaim: true }
      : await flushMessages(
          storefrontDeliveryDeps(deps, env),
          queued.map((q) => q.id),
        );

    return c.json({
      ok: true,
      orderNumber: order.orderNumber,
      total: total.toFixed(2),
      currency: CURRENCY,
      receiptToken: mintReceiptToken(order.id, deps.jwtSecret),
      contactId: contact.id,
      enrolled: outcome.enrolled,
      queued: queued.length,
      flushed,
      notes: [
        ...(phoneNote === undefined ? [] : [phoneNote]),
        ...(overBudget
          ? [
              `This deployment's daily live-send budget of ${config.dailyBudget} is exhausted, ` +
                `so nothing was handed to a provider. The order, the enrolment and every ` +
                `decision were still recorded — open the receipt to read them.`,
            ]
          : []),
        ...(outcome.enrolled === 0
          ? [
              'No campaign enrolled this order. The decision log on the receipt says which ' +
                'campaigns were considered and why each one declined.',
            ]
          : []),
      ],
    });
  });

  /**
   * The receipt: what the engine did, in its own words.
   *
   * This is the half of the demo that is actually about the product. Anyone can
   * show a confirmation email; the interesting screen is the one that says the SMS
   * was not sent, at 02:41 local time, because of recipient-local quiet hours, and
   * names the gate that said so.
   */
  app.get('/storefront/receipt/:token', async (c) => {
    const orderId = readReceiptToken(c.req.param('token'), deps.jwtSecret);
    if (orderId === undefined) throw notFound('Receipt');

    const order = await queryOne<{
      id: string;
      order_number: string;
      status: string;
      total: string;
      currency: string;
      placed_at: Date;
      items: unknown;
      tenant_id: string;
      contact_id: string;
      first_name: string | null;
      email: string | null;
      phone: string | null;
    }>(
      deps.db,
      `SELECT o.id, o.order_number, o.status, o.total::text AS total, o.currency,
              o.placed_at, o.items, o.tenant_id, o.contact_id,
              ct.first_name, ct.email::text AS email, ct.phone
         FROM orders o JOIN contacts ct ON ct.id = o.contact_id
        WHERE o.id = $1`,
      [orderId],
    );
    if (!order) throw notFound('Order', orderId);

    const messages = await query<{
      id: string;
      channel: Channel;
      status: string;
      recipient_address: string;
      rendered_subject: string | null;
      rendered_body: string;
      provider: string | null;
      provider_message_id: string | null;
      provider_error_code: string | null;
      provider_error_message: string | null;
      attempts: number;
      scheduled_at: Date;
      sent_at: Date | null;
      delivered_at: Date | null;
      campaign_name: string;
    }>(
      deps.db,
      `SELECT q.id, q.channel, q.status, q.recipient_address, q.rendered_subject,
              q.rendered_body, q.provider, q.provider_message_id,
              q.provider_error_code, q.provider_error_message, q.attempts,
              q.scheduled_at, q.sent_at, q.delivered_at, c.name AS campaign_name
         FROM message_queue q JOIN campaigns c ON c.id = q.campaign_id
        WHERE q.order_id = $1
        ORDER BY q.channel, q.scheduled_at`,
      [orderId],
    );

    /**
     * Decisions are fetched by ORDER and by CONTACT, then merged.
     *
     * Trigger-stage rows carry the order; send-stage rows carry the message. A
     * query on `order_id` alone silently drops the send-stage skips, which are the
     * only rows that explain why something did not arrive — the exact rows this
     * page exists to show.
     */
    const decisions = await query<{
      stage: string;
      decision: string;
      reason_code: string;
      reason_detail: string | null;
      inputs: unknown;
      decided_at: Date;
      campaign_name: string | null;
    }>(
      deps.db,
      `SELECT d.stage, d.decision, d.reason_code, d.reason_detail, d.inputs, d.decided_at,
              c.name AS campaign_name
         FROM send_decisions d
         LEFT JOIN campaigns c ON c.id = d.campaign_id
        WHERE d.tenant_id = $1
          AND (d.order_id = $2
               OR d.message_queue_id = ANY($3::uuid[])
               -- Trigger-stage rows carry neither an order nor a message: a
               -- campaign that declined to enrol has nothing to attach one to.
               -- They are the rows that explain an empty receipt, so they have to
               -- be reachable — but only within the minutes around THIS order, or
               -- the page fills up with the next order's reasoning.
               OR (d.contact_id = $4
                   AND d.order_id IS NULL
                   AND d.message_queue_id IS NULL
                   AND d.decided_at >= $5
                   AND d.decided_at < $5::timestamptz + interval '10 minutes'))
        ORDER BY d.decided_at, d.id`,
      [order.tenant_id, orderId, messages.map((m) => m.id), order.contact_id, order.placed_at],
    );

    return c.json({
      /**
       * Whether a delivery receipt can ever arrive for these messages.
       *
       * `delivered_at` is written only by a provider callback (I9), never inferred
       * from a successful send. In live mode the provider will call back and the
       * row moves `sent` → `delivered` in front of the visitor. In mock mode it
       * will not: `MockProvider.pendingWebhookEvents()` schedules the simulated
       * callbacks, and nothing in this repository drains that queue — no worker
       * job calls it, and the seed creates no `mock` credential row for the
       * webhook route to verify a signature against. So the simulated receipt is
       * scheduled and then dropped.
       *
       * The page is told this rather than left to poll for something that is not
       * coming. A spinner that never resolves is a worse lie than a sentence
       * saying the deployment does not do that.
       */
      deliveryReceiptsExpected: deps.sendMode === 'live',
      sendMode: deps.sendMode,
      order: {
        number: order.order_number,
        status: order.status,
        total: order.total,
        currency: order.currency,
        placedAt: order.placed_at.toISOString(),
        items: order.items,
      },
      contact: {
        firstName: order.first_name,
        email: order.email,
        phone: order.phone === null ? null : maskPhone(order.phone),
      },
      messages: messages.map((m) => ({
        id: m.id,
        channel: m.channel,
        status: m.status,
        campaign: m.campaign_name,
        to: m.channel === 'email' ? m.recipient_address : maskPhone(m.recipient_address),
        subject: m.rendered_subject,
        body: m.rendered_body,
        provider: m.provider,
        providerMessageId: m.provider_message_id,
        errorCode: m.provider_error_code,
        errorMessage: m.provider_error_message,
        attempts: m.attempts,
        scheduledAt: m.scheduled_at.toISOString(),
        sentAt: m.sent_at?.toISOString() ?? null,
        deliveredAt: m.delivered_at?.toISOString() ?? null,
      })),
      decisions: decisions.map((d) => ({
        stage: d.stage,
        decision: d.decision,
        reasonCode: d.reason_code,
        detail: d.reason_detail,
        inputs: d.inputs,
        campaign: d.campaign_name,
        at: d.decided_at.toISOString(),
      })),
    });
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function clientIp(forwardedFor: string | undefined, realIp: string | undefined): string {
  // The FIRST hop only. Later entries are appendable by the client, and recording
  // one as evidence of consent would make the evidence worthless.
  const first = forwardedFor?.split(',')[0]?.trim();
  if (first !== undefined && first.length > 0) return first;
  return realIp ?? 'unknown';
}

/**
 * Enough of a number to recognise your own, not enough to be somebody else's.
 *
 * The guard is on the LENGTH, not on the format: `'•'.repeat(-1)` throws a
 * RangeError, so a short string would turn a receipt page into a 500. E.164
 * guarantees at least eight characters, but the guarantee lives in a database
 * CHECK and this function is one refactor away from being handed something else.
 */
function maskPhone(phone: string): string {
  if (phone.length < 8) return phone;
  return `${phone.slice(0, 3)}${'•'.repeat(phone.length - 6)}${phone.slice(-3)}`;
}

async function resolveStore(
  deps: ApiDeps,
  config: StorefrontConfig,
): Promise<{ tenantId: string; storeId: string }> {
  const row = await queryOne<{ tenant_id: string; store_id: string }>(
    deps.db,
    `SELECT t.id AS tenant_id, s.id AS store_id
       FROM tenants t JOIN stores s ON s.tenant_id = t.id
      WHERE t.name = $1 AND s.code = $2
      LIMIT 1`,
    [config.tenantName, config.storeCode],
  );
  if (!row) {
    // A 409 rather than a 500. Nothing is broken: the deployment is fine, it has
    // simply never been seeded, so the request conflicts with the state of the
    // world rather than failing inside it. `npm run seed:demo` is the fix, and
    // naming it in the message beats a stack trace in a log nobody is reading.
    throw conflict(
      'storefront_not_seeded',
      `No store '${config.storeCode}' exists for tenant '${config.tenantName}'. ` +
        `Run \`npm run seed:demo\` against this database, or set STOREFRONT_TENANT_NAME ` +
        `and STOREFRONT_STORE_CODE to an existing one.`,
      { tenantName: config.tenantName, storeCode: config.storeCode },
    );
  }
  return { tenantId: row.tenant_id, storeId: row.store_id };
}

/**
 * Live sends across the whole deployment in the last 24 hours.
 *
 * Counted from `message_queue.sent_at` rather than from a counter in memory,
 * because the process restarts on every deploy and a budget that resets on restart
 * is not a budget. Counted across ALL tenants for the same reason it is called a
 * deployment budget: the free tier being protected belongs to the deployment, not
 * to a tenant.
 */
async function budgetSpent(deps: ApiDeps): Promise<number> {
  if (deps.sendMode !== 'live') return 0;
  const since = new Date(deps.clock.now().getTime() - 86_400_000);
  const row = await queryOne<{ n: string }>(
    deps.db,
    `SELECT count(*)::text AS n FROM message_queue
      WHERE sent_at IS NOT NULL AND sent_at > $1 AND provider <> 'mock'`,
    [since],
  );
  return Number(row?.n ?? '0');
}

type UpsertInput = {
  readonly tenantId: string;
  readonly email: string;
  readonly phone: string | undefined;
  readonly name: string;
  readonly ip: string;
  readonly userAgent: string;
  readonly marketingConsent: boolean;
};

async function upsertContact(
  deps: ApiDeps,
  input: UpsertInput,
): Promise<{ id: string; phoneNote?: string }> {
  const [firstName, ...rest] = input.name.split(/\s+/);
  const lastName = rest.join(' ');

  /**
   * The phone is claimed, not assumed.
   *
   * `contacts_tenant_phone` is UNIQUE, so writing a number that already belongs to
   * a different contact is a 23505 — an "internal error" on a checkout screen for
   * what is really "two people typed the same number". On a public demo that is
   * not hypothetical: the first number anyone tries is the one from the example
   * text. So the number is dropped, with a sentence saying so, rather than
   * failing the order.
   */
  let phone = input.phone;
  let phoneNote: string | undefined;
  if (phone !== undefined) {
    const holder = await queryOne<{ id: string; email: string | null }>(
      deps.db,
      `SELECT id, email::text AS email FROM contacts WHERE tenant_id = $1 AND phone = $2`,
      [input.tenantId, phone],
    );
    if (holder && holder.email?.toLowerCase() !== input.email) {
      phoneNote =
        `That phone number is already registered to a different contact in the demo ` +
        `dataset, so the order was placed without it and no SMS was queued. Phone numbers ` +
        `are unique per tenant — see contacts_tenant_phone in migrations/0001.`;
      phone = undefined;
    }
  }

  const existing = await queryOne<{ id: string }>(
    deps.db,
    `SELECT id FROM contacts WHERE tenant_id = $1 AND email = $2::citext`,
    [input.tenantId, input.email],
  );

  const contactId = existing
    ? (
        await queryOne<{ id: string }>(
          deps.db,
          `UPDATE contacts
              SET first_name = COALESCE(NULLIF($3,''), first_name),
                  last_name  = COALESCE(NULLIF($4,''), last_name),
                  phone      = COALESCE($5, phone),
                  updated_at = $6
            WHERE id = $1 AND tenant_id = $2
          RETURNING id`,
          [existing.id, input.tenantId, firstName ?? '', lastName, phone ?? null, deps.clock.now()],
        )
      )?.id
    : (
        await queryOne<{ id: string }>(
          deps.db,
          `INSERT INTO contacts (tenant_id, email, phone, first_name, last_name, created_at, updated_at)
           VALUES ($1,$2::citext,$3,$4,$5,$6,$6)
           RETURNING id`,
          [input.tenantId, input.email, phone ?? null, firstName ?? '', lastName, deps.clock.now()],
        )
      )?.id;

  if (contactId === undefined) {
    throw conflict('contact_write_failed', 'The contact could not be written.', {
      email: input.email,
    });
  }

  await recordCheckoutConsent(deps, {
    tenantId: input.tenantId,
    contactId,
    channels: phone === undefined ? (['email'] as const) : (['email', 'sms'] as const),
    ip: input.ip,
    userAgent: input.userAgent,
    marketingConsent: input.marketingConsent,
  });

  return phoneNote === undefined ? { id: contactId } : { id: contactId, phoneNote };
}

/**
 * Consent, recorded with its evidence — and NEVER used to overturn an opt-out.
 *
 * A ticked box on a checkout form is a lawful basis for marketing to someone who
 * has not said otherwise. It is not a lawful basis for resurrecting someone who
 * clicked unsubscribe, and a system that lets a later form submission silently
 * outrank an explicit opt-out is the pattern this project exists to argue against.
 * So an existing `opted_out` row for a channel ends the matter: no row is written,
 * the opt-out stands, and the gate chain will say so on the receipt.
 *
 * The transactional order confirmation still goes out, because a receipt for a
 * purchase somebody just made is not marketing — that exemption lives in the
 * consent gate, visibly, rather than here.
 */
async function recordCheckoutConsent(
  deps: ApiDeps,
  input: {
    tenantId: string;
    contactId: string;
    channels: readonly Channel[];
    ip: string;
    userAgent: string;
    marketingConsent: boolean;
  },
): Promise<void> {
  if (!input.marketingConsent) return;

  for (const channel of input.channels) {
    const latest = await queryOne<{ state: string }>(
      deps.db,
      `SELECT state FROM contact_consents
        WHERE tenant_id = $1 AND contact_id = $2 AND channel = $3
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
      [input.tenantId, input.contactId, channel],
    );
    if (latest?.state === 'opted_out') continue;

    await deps.db.query(
      `INSERT INTO contact_consents
         (tenant_id, contact_id, channel, state, source, evidence, occurred_at)
       VALUES ($1,$2,$3,'opted_in','checkout',$4,$5)`,
      [
        input.tenantId,
        input.contactId,
        channel,
        JSON.stringify({
          ip: input.ip,
          userAgent: input.userAgent.slice(0, 300),
          form: 'storefront-checkout',
        }),
        deps.clock.now(),
      ],
    );
  }
}

async function insertOrder(
  deps: ApiDeps,
  input: {
    tenantId: string;
    storeId: string;
    contactId: string;
    total: number;
    items: readonly { sku: string; name: string; qty: number; price: number }[];
  },
): Promise<{ id: string; orderNumber: string }> {
  /**
   * Retried rather than sequenced.
   *
   * The unique key is (tenant, store, order_number), so a collision is possible
   * and a `SELECT max(...)+1` under concurrency is a race that produces exactly
   * that collision. Three attempts at a random suffix is enough for a demo shop
   * and needs no extra table; the ON CONFLICT is what makes it correct rather than
   * merely unlikely.
   */
  for (let attempt = 0; attempt < 3; attempt++) {
    const orderNumber = `CE-${randomSuffix()}`;
    const row = await queryOne<{ id: string }>(
      deps.db,
      `INSERT INTO orders (tenant_id, store_id, contact_id, order_number, status, total,
                           currency, placed_at, items, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'placed',$5,$6,$7,$8,$7,$7)
       ON CONFLICT (tenant_id, store_id, order_number) DO NOTHING
       RETURNING id`,
      [
        input.tenantId,
        input.storeId,
        input.contactId,
        orderNumber,
        input.total.toFixed(2),
        CURRENCY,
        deps.clock.now(),
        JSON.stringify(input.items),
      ],
    );
    if (row) return { id: row.id, orderNumber };
  }
  throw conflict('order_number_collision', 'Could not allocate an order number. Try again.');
}

function randomSuffix(): string {
  // Not crypto: an order number is not a capability. The receipt token is.
  return Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .toUpperCase()
    .padStart(6, '0');
}
