/**
 * H4 — `deliverClaimed` loads context AFTER claiming, and the `if (!loaded)` branch
 * cancels with reason `recipient_not_found`.
 *
 * The branch's stated scenario ("the campaign was deleted between claim and load")
 * is tested here directly. It turns out to be unreachable, and the branch that IS
 * reachable does something worse than the wrong reason code: it returns SKIPPED
 * without recording ANY decision, which is the one thing I14 says never happens.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { queueOne } from '../support/delivery.ts';
import { claimBatch, deliverClaimed, FakeClock } from '@campaign/core';
import { scriptedProvider, depsFor } from './support.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

async function claimOne() {
  const seeded = await seedAll();
  await optIn(testDb(), seeded.tenantId, seeded.contactId);
  const id = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z' });
  const clock = new FakeClock('2026-06-15T12:00:00Z');
  const claimed = await claimBatch(testDb(), { workerId: 'w1', batchSize: 1, clock });
  expect(claimed).toHaveLength(1);
  const provider = scriptedProvider([{ ok: true, providerMessageId: 'pm-1' }]);
  return { seeded, id, clock, row: claimed[0]!, provider, deps: depsFor(provider, clock) };
}

describe('H4 — what actually happens if the campaign disappears mid-flight', () => {
  it('OBSERVED: the campaign cannot be deleted at all — the branch it claims to cover is unreachable', async () => {
    const { seeded, id } = await claimOne();
    // The cascade campaigns -> campaign_versions runs into the append-only trigger
    // on campaign_versions, so the delete is refused outright. The scenario the
    // `if (!loaded)` branch names ("campaign deleted between claim and load")
    // cannot be produced.
    await expect(
      testDb().query(`DELETE FROM campaigns WHERE id = $1`, [seeded.campaignId]),
    ).rejects.toThrow(/campaign_versions is append-only/);
    const { rows } = await testDb().query(`SELECT status FROM message_queue WHERE id = $1`, [id]);
    expect(rows, 'the queue row is untouched').toHaveLength(1);
  });

  it('OBSERVED: the contact cannot be deleted either, for the same reason', async () => {
    const { seeded, id } = await claimOne();
    await expect(
      testDb().query(`DELETE FROM contacts WHERE id = $1`, [seeded.contactId]),
    ).rejects.toThrow(/contact_consents is append-only/);
    const { rows } = await testDb().query(`SELECT status FROM message_queue WHERE id = $1`, [id]);
    expect(rows).toHaveLength(1);
  });

  it('OBSERVED: the enrolment CAN be deleted, and it takes the queue row with it', async () => {
    const { seeded, id } = await claimOne();
    await testDb().query(`DELETE FROM enrollments WHERE id = $1`, [seeded.enrollmentId]);
    const { rows } = await testDb().query(`SELECT id FROM message_queue WHERE id = $1`, [id]);
    expect(
      rows,
      'ON DELETE CASCADE removes the queue row, so loadContext still never sees an ' +
        'orphaned-but-present row: it only ever sees a row that is gone',
    ).toHaveLength(0);
  });

  it('OBSERVED: the ONLY way to reach `if (!loaded)` is a deleted queue row, and then markCancelled writes nothing', async () => {
    const { id, row, deps, provider } = await claimOne();

    // Whatever deleted it, the worker is holding a stale in-memory QueueRow.
    await testDb().query(`DELETE FROM message_queue WHERE id = $1`, [id]);

    const outcome = await deliverClaimed(deps, row);
    expect(outcome).toBe('SKIPPED');
    expect(provider.sent, 'nothing was sent, which is correct').toHaveLength(0);

    // markCancelled ran `UPDATE ... WHERE id = $1` against a row that no longer
    // exists: zero rows affected, no error, no signal.
    const { rows } = await testDb().query(`SELECT id FROM message_queue WHERE id = $1`, [id]);
    expect(rows, 'no row to cancel; the write was a silent no-op').toHaveLength(0);
  });

  it('SHOULD: the `!loaded` skip is recorded in the decision log like every other skip (I14)', async () => {
    const { id, row, deps } = await claimOne();
    await testDb().query(`DELETE FROM message_queue WHERE id = $1`, [id]);

    const outcome = await deliverClaimed(deps, row);
    expect(outcome).toBe('SKIPPED');

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM send_decisions WHERE message_queue_id = $1`,
      [id],
    );
    expect(
      Number(rows[0]!.n),
      'this is the one path in deliverClaimed that returns SKIPPED without calling ' +
        'recordDecision — an attempt was consumed, an outcome was produced, and the ' +
        'decision log has nothing to say about it. It is also mislabelled: the reason ' +
        'code passed to markCancelled is `recipient_not_found`, whose canned sentence ' +
        'is "No contact could be resolved for this event", which is not what happened.',
    ).toBe(1);
  });
});
