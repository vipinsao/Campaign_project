/**
 * I10 — A frequency cap (max messages per contact, per channel, per rolling
 *       window) is enforced AT SEND TIME, and its configuration has real readers.
 *
 * Failure it prevents: cadence and priority columns sitting in the schema with
 * zero backend readers, looking like a working control on the settings screen,
 * while one recipient receives 48 messages in seven days.
 *
 * The second test below is the one that matters and is the one usually missing:
 * it asserts that CHANGING THE CONFIGURATION CHANGES THE BEHAVIOUR. A cap that is
 * read but always compared against a constant passes every other test here.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { harness, queueOne, queueRow } from '../support/delivery.ts';
import { processQueue } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

const ANCHORS = Array.from(
  { length: 8 },
  (_, i) => `0000000${i}-0000-4000-8000-00000000000${i}`,
);

async function seedWithCap(capCount: number, capWindow = '7 days') {
  const seeded = await seedAll(testDb(), {
    tenant: { freqCapCount: capCount, freqCapWindow: capWindow },
  });
  await optIn(testDb(), seeded.tenantId, seeded.contactId);
  return seeded;
}

describe('I10 — the frequency cap is enforced where it counts', () => {
  it('sends up to the cap and defers the rest', async () => {
    const seeded = await seedWithCap(3);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await queueOne(seeded, { anchorId: ANCHORS[i]! }));

    const { deps, provider } = harness();
    await processQueue(deps);

    expect(provider.sent, 'exactly the cap should have been sent').toHaveLength(3);

    const statuses = await Promise.all(ids.map((id) => queueRow(id)));
    const sent = statuses.filter((r) => r.status === 'sent');
    const deferred = statuses.filter((r) => r.status === 'pending');
    expect(sent).toHaveLength(3);
    expect(deferred).toHaveLength(3);

    // Deferral, not cancellation: the cap says "not now", never "not ever".
    for (const row of deferred) {
      expect(row.deferrals).toBe(1);
      expect(row.attempts, 'a cap deferral must not consume a delivery attempt').toBe(0);
    }
  });

  it('CHANGES BEHAVIOUR when the configured cap changes', async () => {
    // The test that proves the column has a reader. Same scenario, two configs.
    const low = await seedWithCap(2);
    for (let i = 0; i < 5; i++) await queueOne(low, { anchorId: ANCHORS[i]! });
    const runLow = harness();
    await processQueue(runLow.deps);
    expect(runLow.provider.sent).toHaveLength(2);

    await resetDb();

    const high = await seedWithCap(5);
    for (let i = 0; i < 5; i++) await queueOne(high, { anchorId: ANCHORS[i]! });
    const runHigh = harness();
    await processQueue(runHigh.deps);
    expect(
      runHigh.provider.sent,
      'raising freq_cap_count did not change what was sent, so nothing reads it',
    ).toHaveLength(5);
  });

  it('counts per channel, not across channels', async () => {
    // An email and an SMS are not interchangeable interruptions, and a shared
    // counter would let one channel starve the other.
    const seeded = await seedWithCap(2);
    await testDb().query(`UPDATE contacts SET phone = '+15005550006' WHERE id = $1`, [
      seeded.contactId,
    ]);
    await optIn(testDb(), seeded.tenantId, seeded.contactId, 'sms');
    await testDb().query(
      `UPDATE campaigns SET channels = '{email,sms}' WHERE id = $1`,
      [seeded.campaignId],
    );
    const smsMessageId = (
      await testDb().query<{ id: string }>(
        `INSERT INTO campaign_messages (tenant_id, campaign_id, channel, sequence_order, body_template)
         VALUES ($1,$2,'sms',2,'SMS body') RETURNING id`,
        [seeded.tenantId, seeded.campaignId],
      )
    ).rows[0]!.id;

    for (let i = 0; i < 2; i++) await queueOne(seeded, { anchorId: ANCHORS[i]! });
    for (let i = 2; i < 4; i++) {
      await testDb().query(
        `INSERT INTO message_queue
           (tenant_id, enrollment_id, campaign_id, campaign_version_id, campaign_message_id,
            contact_id, anchor_id, channel, recipient_address, rendered_body, scheduled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'sms','+15005550006','SMS body','2026-06-15T11:00:00Z')`,
        [
          seeded.tenantId,
          seeded.enrollmentId,
          seeded.campaignId,
          seeded.campaignVersionId,
          smsMessageId,
          seeded.contactId,
          ANCHORS[i]!,
        ],
      );
    }

    const { deps, provider } = harness();
    await processQueue(deps);

    // Cap of 2 per channel: 2 emails AND 2 SMS, not 2 in total.
    expect(provider.sent, 'the cap is per channel, so all four should send').toHaveLength(4);
  });

  it('lets a deferred message through once the window has rolled', async () => {
    const seeded = await seedWithCap(2, '2 days');
    for (let i = 0; i < 3; i++) await queueOne(seeded, { anchorId: ANCHORS[i]! });

    const { deps, provider, clock } = harness();
    await processQueue(deps);
    expect(provider.sent).toHaveLength(2);

    // Three days later the earlier sends have left the rolling window.
    clock.advanceDays(3);
    await processQueue(deps);
    expect(provider.sent, 'the third message should send once the window rolls').toHaveLength(3);
  });
});
