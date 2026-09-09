/**
 * Fast-forward the demo.
 *
 * Advances a FakeClock in one-hour steps across thirty simulated days, driving the
 * trigger evaluator and the worker at every tick, so a reviewer watches enrolments
 * appear, messages queue against recipients' local quiet hours, sends happen,
 * receipts arrive, opens and clicks accumulate, a bounce land, and somebody opt
 * out — live, in about a minute.
 *
 * This script is the payoff of the injectable clock. Every time-dependent decision
 * in the domain takes a `Clock` rather than reading the wall clock, and an ESLint
 * rule plus a test enforce it. That single constraint is what turns "three days
 * after the order is delivered" from something you cannot demonstrate into
 * something you can watch happen in three milliseconds.
 *
 *   npm run seed:demo && npm run demo:simulate
 */
import { Pool } from 'pg';
import {
  FakeClock,
  evaluateTrigger,
  processQueue,
  runTimeTriggers,
  evaluateStopConditions,
  optOut,
  withTransaction,
  type DeliveryDeps,
} from '@campaign/core';
import { MockProvider, classify, nextAttemptDelayMs } from '@campaign/providers';

const SIMULATED_DAYS = Number(process.env['SIMULATE_DAYS'] ?? 30);
const STEP_HOURS = 1;

/** Deterministic, so two runs of the demo produce the same story. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(90210);

type Totals = {
  enrolled: number;
  queued: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  failed: number;
  deferred: number;
  optedOut: number;
};

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set. Run `npm run dev` in another terminal first.');
    process.exit(1);
  }

  const db = new Pool({ connectionString: url });

  /**
   * The origin every unsubscribe and tracking link in the simulated history is
   * built from  (I7).
   *
   * This was the literal 'http://localhost:3000', twice, and the consequence was
   * not theoretical: the deployed demo's entire message history carried
   * unsubscribe links pointing at localhost, so every one of them resolved
   * nowhere for every reviewer who clicked one. `demo-reset.yml` was passing
   * PUBLIC_BASE_URL in correctly the whole time; this script threw it away.
   *
   * I7 is the invariant that says an unsubscribe link must resolve. Hardcoding the
   * origin in the generator that produces the demo's messages is that invariant
   * being broken by the one script whose output a reviewer actually reads.
   */
  const publicBaseUrl = (process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000').replace(
    /\/+$/,
    '',
  );

  try {
    const { rows: tenants } = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM tenants WHERE name = 'Demo Store (seeded data)'`,
    );
    const tenant = tenants[0];
    if (!tenant) {
      console.error('No demo tenant found. Run `npm run seed:demo` first.');
      process.exit(1);
    }

    // Wind the clock back and replay forward. The seed placed orders across the
    // last ninety days; the last thirty are the ones we replay in detail.
    const { rows: nowRows } = await db.query<{ now: Date }>(`SELECT now() AS now`);
    const realNow = nowRows[0]!.now;
    const start = new Date(realNow.getTime() - SIMULATED_DAYS * 86_400_000);
    const clock = new FakeClock(start);

    // Everything queued by the seed's historical orders is out of scope for the
    // replay; clearing it means the timeline the reviewer watches is the one this
    // script actually produced.
    await db.query(`DELETE FROM message_queue WHERE tenant_id = $1`, [tenant.id]);
    await db.query(`DELETE FROM enrollments WHERE tenant_id = $1`, [tenant.id]);
    await db.query(`DELETE FROM message_events WHERE tenant_id = $1`, [tenant.id]);
    await db.query(`DELETE FROM send_decisions WHERE tenant_id = $1`, [tenant.id]);

    const email = new MockProvider('email', { db, clock, rng, webhookDelayMs: 45 * 60_000 });
    const sms = new MockProvider('sms', { db, clock, rng, webhookDelayMs: 20 * 60_000 });

    const deliveryDeps: DeliveryDeps = {
      db,
      clock,
      sendMode: 'mock',
      workerId: 'simulate',
      batchSize: 200,
      resolveProvider: (channel) => (channel === 'email' ? email : sms),
      resolveSender: () => Promise.resolve({ provider: 'mock', fromAddress: 'hello@example.com' }),
      classifyError: (provider, code) => {
        const c = classify(provider, code);
        return { class: c.class, maxAttempts: c.maxAttempts };
      },
      backoffMs: (attempts) => nextAttemptDelayMs(attempts, rng),
      maxAttempts: 5,
    };

    const totals: Totals = {
      enrolled: 0,
      queued: 0,
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      failed: 0,
      deferred: 0,
      optedOut: 0,
    };

    const steps = (SIMULATED_DAYS * 24) / STEP_HOURS;
    console.log(`Replaying ${SIMULATED_DAYS} days for "${tenant.name}"…\n`);

    let lastDay = '';
    for (let step = 0; step < steps; step++) {
      const windowStart = clock.now();
      clock.advanceHours(STEP_HOURS);
      const windowEnd = clock.now();

      // ── 1. domain events that fall inside this hour ──────────────────────
      const { rows: events } = await db.query<{ id: string; kind: string }>(
        `SELECT id, 'order_placed' AS kind FROM orders
          WHERE tenant_id = $1 AND placed_at >= $2 AND placed_at < $3
         UNION ALL
         SELECT id, 'order_shipped' FROM orders
          WHERE tenant_id = $1 AND shipped_at >= $2 AND shipped_at < $3
         UNION ALL
         SELECT id, 'order_delivered' FROM orders
          WHERE tenant_id = $1 AND delivered_at >= $2 AND delivered_at < $3`,
        [tenant.id, windowStart, windowEnd],
      );

      for (const event of events) {
        const outcome = await evaluateTrigger(
          { db, clock, publicBaseUrl },
          {
            type: event.kind as 'order_placed' | 'order_shipped' | 'order_delivered',
            tenantId: tenant.id,
            orderId: event.id,
          },
        );
        totals.enrolled += outcome.enrolled;
        totals.queued += outcome.queued;
      }

      // ── 2. the worker ────────────────────────────────────────────────────
      const run = await processQueue(deliveryDeps);
      totals.sent += run.sent;
      totals.failed += run.failed;
      totals.deferred += run.deferred;

      // ── 3. provider callbacks: receipts, bounces, complaints ─────────────
      const receipts = await deliverPendingReceipts(db, tenant.id, clock);
      totals.delivered += receipts.delivered;
      totals.bounced += receipts.bounced;

      // ── 4. recipient behaviour: opens and clicks ─────────────────────────
      const engagement = await simulateEngagement(db, tenant.id, clock, rng);
      totals.opened += engagement.opened;
      totals.clicked += engagement.clicked;

      // ── 5. hourly and periodic jobs ──────────────────────────────────────
      if (step % 24 === 0) {
        await runTimeTriggers({
          db,
          clock,
          publicBaseUrl,
          // A floor is configured, so the job runs. Set it to null and watch the
          // job refuse to enrol anyone at all.
          triggerFloorAt: start,
          maxEnrolmentsPerRun: 200,
        });
      }
      if (step % 6 === 0) await evaluateStopConditions({ db, clock });

      // ── 6. somebody unsubscribes ─────────────────────────────────────────
      if (rng() < 0.02) {
        const opted = await optOutSomeone(db, tenant.id, clock);
        if (opted) totals.optedOut++;
      }

      const day = windowEnd.toISOString().slice(0, 10);
      if (day !== lastDay) {
        lastDay = day;
        process.stdout.write(
          `  ${day}  enrolled ${String(totals.enrolled).padStart(4)}` +
            `  sent ${String(totals.sent).padStart(4)}` +
            `  delivered ${String(totals.delivered).padStart(4)}` +
            `  opened ${String(totals.opened).padStart(4)}` +
            `  bounced ${String(totals.bounced).padStart(3)}` +
            `  deferred ${String(totals.deferred).padStart(4)}\n`,
        );
      }
    }

    const { rows: skips } = await db.query<{ reason_code: string; n: string }>(
      `SELECT reason_code, count(*)::text AS n FROM send_decisions
        WHERE tenant_id = $1 AND decision = 'skip'
        GROUP BY reason_code ORDER BY count(*) DESC LIMIT 8`,
      [tenant.id],
    );

    console.log('\nWhy messages did NOT send (the decision log):');
    if (skips.length === 0) console.log('  nothing was skipped');
    for (const row of skips) console.log(`  ${row.n.padStart(5)}  ${row.reason_code}`);

    console.log('\nOpen http://localhost:5173/inspect and search an order number.');
  } finally {
    await db.end();
  }
}

/**
 * Deliver receipts whose simulated callback has become due.
 *
 * `delivered` is written ONLY here, from a provider receipt, never inferred from a
 * successful send (I9). A message with no receipt yet stays `sent`, and the UI
 * says "awaiting receipt" rather than assuming the best.
 */
async function deliverPendingReceipts(
  db: Pool,
  tenantId: string,
  clock: FakeClock,
): Promise<{ delivered: number; bounced: number; complained: number }> {
  const now = clock.now();
  const { rows } = await db.query<{
    id: string;
    message_queue_id: string;
    simulated_outcome: string;
    campaign_id: string;
    contact_id: string;
    channel: string;
  }>(
    `SELECT o.id, o.message_queue_id, o.simulated_outcome, q.campaign_id, q.contact_id, q.channel
       FROM mock_outbox o
       JOIN message_queue q ON q.id = o.message_queue_id
      WHERE o.tenant_id = $1
        AND q.status = 'sent'
        AND o.sent_at <= $2::timestamptz - interval '30 minutes'`,
    [tenantId, now],
  );

  let delivered = 0;
  let bounced = 0;
  let complained = 0;
  for (const row of rows) {
    const outcome = row.simulated_outcome;
    const eventType =
      outcome === 'delivered' ? 'delivered' : outcome === 'bounced' ? 'bounced' : 'complained';

    if (outcome === 'delivered') {
      await db.query(
        `UPDATE message_queue SET status='delivered', delivered_at=$2, updated_at=$2 WHERE id=$1`,
        [row.message_queue_id, now],
      );
      delivered++;
    } else {
      if (outcome === 'bounced') bounced++;
      else complained++;
      await db.query(`UPDATE message_queue SET status=$3, updated_at=$2 WHERE id=$1`, [
        row.message_queue_id,
        now,
        outcome === 'bounced' ? 'bounced' : 'complained',
      ]);
    }

    await db.query(
      `INSERT INTO message_events (tenant_id, message_queue_id, campaign_id, contact_id,
                                   event_type, channel, occurred_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [
        tenantId,
        row.message_queue_id,
        row.campaign_id,
        row.contact_id,
        eventType,
        row.channel,
        now,
        `${eventType}:${row.message_queue_id}`,
      ],
    );
  }
  return { delivered, bounced, complained };
}

/** Opens and clicks, on delivered email only. SMS has no open event, ever. */
async function simulateEngagement(
  db: Pool,
  tenantId: string,
  clock: FakeClock,
  random: () => number,
): Promise<{ opened: number; clicked: number }> {
  const now = clock.now();
  const { rows } = await db.query<{
    id: string;
    campaign_id: string;
    contact_id: string;
    channel: string;
  }>(
    `SELECT id, campaign_id, contact_id, channel FROM message_queue
      WHERE tenant_id = $1 AND status = 'delivered' AND channel = 'email'
        AND delivered_at <= $2::timestamptz - interval '1 hour'
        AND NOT EXISTS (
              SELECT 1 FROM message_events e
               WHERE e.message_queue_id = message_queue.id AND e.event_type = 'opened')
      LIMIT 60`,
    [tenantId, now],
  );

  let opened = 0;
  let clicked = 0;
  for (const row of rows) {
    if (random() > 0.42) continue;
    await db.query(
      `INSERT INTO message_events (tenant_id, message_queue_id, campaign_id, contact_id,
                                   event_type, channel, occurred_at, idempotency_key)
       VALUES ($1,$2,$3,$4,'opened','email',$5,$6)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [
        tenantId,
        row.id,
        row.campaign_id,
        row.contact_id,
        now,
        `opened:${row.id}:${now.toISOString().slice(0, 10)}`,
      ],
    );
    opened++;

    if (random() < 0.28) {
      await db.query(
        `INSERT INTO message_events (tenant_id, message_queue_id, campaign_id, contact_id,
                                     event_type, channel, occurred_at, idempotency_key)
         VALUES ($1,$2,$3,$4,'clicked','email',$5,$6)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [tenantId, row.id, row.campaign_id, row.contact_id, now, `clicked:${row.id}`],
      );
      clicked++;
    }
  }
  return { opened, clicked };
}

/**
 * Somebody unsubscribes, and it takes effect on what is already queued (I6).
 *
 * This is the moment worth watching in the demo: the opt-out does not merely stop
 * future messages, it cancels the ones already sitting in the queue.
 */
async function optOutSomeone(db: Pool, tenantId: string, clock: FakeClock): Promise<boolean> {
  const { rows } = await db.query<{ contact_id: string; recipient_address: string }>(
    `SELECT DISTINCT contact_id, recipient_address FROM message_queue
      WHERE tenant_id = $1 AND status = 'pending' AND channel = 'email'
      LIMIT 1`,
    [tenantId],
  );
  const target = rows[0];
  if (!target) return false;

  const result = await withTransaction(db, (tx) =>
    optOut(tx, {
      tenantId,
      contactId: target.contact_id,
      channel: 'email',
      address: target.recipient_address,
      source: 'unsubscribe_link',
      reason: 'unsubscribe',
      evidence: { simulated: true },
      clock,
    }),
  );
  if (result.cancelledMessageIds.length > 0) {
    console.log(
      `    opt-out: cancelled ${result.cancelledMessageIds.length} already-queued message(s)`,
    );
  }
  return true;
}

await main();
