/**
 * The rollup is derived, disposable, and rebuildable.
 *
 * This is the property that justifies event sourcing over counters, and it is only
 * a property if something checks it. The claim is specific: drop
 * `campaign_daily_stats` entirely, rebuild it from `message_events`, and get
 * BYTE-IDENTICAL rows back.
 *
 * If that ever stops being true, the rollup has become a second source of truth —
 * and a second source of truth is just a source of disagreement that nobody can
 * adjudicate, because by then the evidence for one of them is gone.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { rebuildRollups } from '../../packages/worker/src/jobs/rollups.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

const DAY_ONE = '2026-06-15';
const DAY_TWO = '2026-06-16';

/** A realistic spread of events across two days and two channels. */
async function seedEvents() {
  const db = testDb();
  const s = await seedAll(db);
  await optIn(db, s.tenantId, s.contactId);

  // A second contact, so "unique per contact per day" is distinguishable from
  // "total". With one contact the two numbers agree and the test proves nothing.
  const { rows: c2 } = await db.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, email) VALUES ($1,'second@example.com') RETURNING id`,
    [s.tenantId],
  );
  const contactB = c2[0]!.id;

  const queued: string[] = [];
  for (let i = 0; i < 6; i++) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO message_queue
         (tenant_id, enrollment_id, campaign_id, campaign_version_id, campaign_message_id,
          contact_id, anchor_id, channel, recipient_address, rendered_body, scheduled_at,
          status, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid(),$7,'r@example.com','body',
               $8::timestamptz,'sent',$8::timestamptz)
       RETURNING id`,
      [
        s.tenantId,
        s.enrollmentId,
        s.campaignId,
        s.campaignVersionId,
        s.campaignMessageId,
        i % 2 === 0 ? s.contactId : contactB,
        i < 4 ? 'email' : 'sms',
        `${i < 3 ? DAY_ONE : DAY_TWO}T10:00:00Z`,
      ],
    );
    queued.push(rows[0]!.id);
  }

  // Half the delivered email messages carry a clickable link. That distinction is
  // the click-rate denominator (I12), and it only shows up in the rollup if the
  // rebuild joins tracking_links correctly.
  //
  // Note the short code uses the id's SUFFIX, not its prefix. These ids are
  // uuidv7, whose leading characters are a millisecond timestamp — so every row
  // inserted in the same millisecond shares a prefix, and `id.slice(0, 8)`
  // collides immediately. That is a real consequence of choosing v7 for primary
  // keys, and it is exactly why message_queue.tracking_id is deliberately v4.
  for (const [n, id] of [queued[0]!, queued[2]!].entries()) {
    await db.query(
      `INSERT INTO tracking_links (tenant_id, message_queue_id, short_code, target_url)
       VALUES ($1,$2,$3,'https://example.com/x')`,
      [s.tenantId, id, `code${n}${id.slice(-8)}`],
    );
  }

  // The contact is named explicitly per event rather than derived from the message
  // index. Deriving it made the two "unique open" events belong to the same person
  // by accident, so the assertion below was testing nothing.
  type Ev = [type: string, idx: number, who: 'A' | 'B', day: string, channel: string];
  const events: Ev[] = [
    ['sent', 0, 'A', DAY_ONE, 'email'],
    ['delivered', 0, 'A', DAY_ONE, 'email'],
    ['opened', 0, 'A', DAY_ONE, 'email'],
    // The SAME contact opening again on the same day must not count twice.
    ['opened', 0, 'A', DAY_ONE, 'email'],
    ['clicked', 0, 'A', DAY_ONE, 'email'],
    ['sent', 1, 'B', DAY_ONE, 'email'],
    ['delivered', 1, 'B', DAY_ONE, 'email'],
    // A DIFFERENT contact opening, so unique and total genuinely differ.
    ['opened', 1, 'B', DAY_ONE, 'email'],
    ['sent', 2, 'A', DAY_ONE, 'email'],
    ['delivered', 2, 'A', DAY_ONE, 'email'],
    ['bounced', 2, 'A', DAY_ONE, 'email'],
    ['sent', 3, 'B', DAY_TWO, 'email'],
    ['delivered', 3, 'B', DAY_TWO, 'email'],
    ['sent', 4, 'A', DAY_TWO, 'sms'],
    ['delivered', 4, 'A', DAY_TWO, 'sms'],
    ['sent', 5, 'B', DAY_TWO, 'sms'],
    ['failed', 5, 'B', DAY_TWO, 'sms'],
  ];

  let n = 0;
  for (const [type, idx, who, day, channel] of events) {
    await db.query(
      `INSERT INTO message_events (tenant_id, message_queue_id, campaign_id, contact_id,
                                   event_type, channel, occurred_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8)`,
      [
        s.tenantId,
        queued[idx]!,
        s.campaignId,
        who === 'A' ? s.contactId : contactB,
        type,
        channel,
        `${day}T${String(9 + (n % 8)).padStart(2, '0')}:30:00Z`,
        `ev-${n++}`,
      ],
    );
  }

  return s;
}

async function snapshot(): Promise<string> {
  // Every column, ordered deterministically, serialised to one string. Comparing
  // the whole row rather than a few counts is the point: a rebuild that gets
  // `delivered` right and `clickable_delivered` wrong is still a broken rebuild.
  const { rows } = await testDb().query<{ row: string }>(
    `SELECT campaign_id::text || '|' || day::text || '|' || channel || '|' ||
            queued || ',' || sent || ',' || delivered || ',' || failed || ',' ||
            bounced || ',' || complained || ',' || unique_opens || ',' ||
            total_opens || ',' || unique_clicks || ',' || total_clicks || ',' ||
            unsubscribes || ',' || clickable_delivered || ',' ||
            attributed_orders || ',' || attributed_revenue AS row
       FROM campaign_daily_stats
      ORDER BY campaign_id, day, channel`,
  );
  return rows.map((r) => r.row).join('\n');
}

const RANGE = { from: new Date('2026-06-14T00:00:00Z'), to: new Date('2026-06-17T00:00:00Z') };

describe('the rollup can be dropped and rebuilt', () => {
  it('produces byte-identical rows on a second rebuild', async () => {
    await seedEvents();

    await rebuildRollups(testDb(), RANGE);
    const first = await snapshot();
    expect(first.length, 'the rebuild produced no rows at all').toBeGreaterThan(0);

    // Drop everything and rebuild from the events alone.
    await testDb().query('TRUNCATE campaign_daily_stats');
    await rebuildRollups(testDb(), RANGE);
    const second = await snapshot();

    expect(second, 'a rebuild from the same events must be byte-identical').toBe(first);
  });

  it('is idempotent when run repeatedly without truncating', async () => {
    // The incremental job re-runs the last three days every fifteen minutes. If
    // that double-counted, the numbers would climb on their own.
    await seedEvents();
    await rebuildRollups(testDb(), RANGE);
    const once = await snapshot();

    await rebuildRollups(testDb(), RANGE);
    await rebuildRollups(testDb(), RANGE);
    const thrice = await snapshot();

    expect(thrice, 'rerunning the rollup must not accumulate').toBe(once);
  });

  it('counts unique opens per contact per day, not total opens', async () => {
    await seedEvents();
    await rebuildRollups(testDb(), RANGE);

    const { rows } = await testDb().query<{ unique_opens: number; total_opens: number }>(
      `SELECT unique_opens, total_opens FROM campaign_daily_stats
        WHERE day = $1::date AND channel = 'email'`,
      [DAY_ONE],
    );
    // Contact A opened twice, contact B once: three opens, two unique openers.
    expect(rows[0]!.unique_opens).toBe(2);
    expect(rows[0]!.total_opens).toBe(3);
  });

  it('counts only delivered messages that contained a link as clickable', async () => {
    // The click-rate denominator (I12). Three email messages were delivered on day
    // one; only two of them carried a link.
    await seedEvents();
    await rebuildRollups(testDb(), RANGE);

    const { rows } = await testDb().query<{ delivered: number; clickable_delivered: number }>(
      `SELECT delivered, clickable_delivered FROM campaign_daily_stats
        WHERE day = $1::date AND channel = 'email'`,
      [DAY_ONE],
    );
    expect(rows[0]!.delivered).toBe(3);
    expect(
      rows[0]!.clickable_delivered,
      'a message with nothing to click must not sit in a click rate denominator',
    ).toBe(2);
  });

  it('recovers correctly after the rollup is corrupted', async () => {
    // The actual promise of event sourcing: the aggregate can be wrong and the
    // truth is still recoverable, because the evidence was written down.
    await seedEvents();
    await rebuildRollups(testDb(), RANGE);
    const truth = await snapshot();

    await testDb().query(`UPDATE campaign_daily_stats SET delivered = 99999, unique_opens = 0`);
    expect(await snapshot()).not.toBe(truth);

    await rebuildRollups(testDb(), RANGE);
    expect(await snapshot(), 'the events are the source of truth; the rollup is not').toBe(truth);
  });
});
