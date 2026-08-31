/**
 * QA — adversarial review of `consent_pauses` and `activePause`  (hypothesis 6).
 *
 * The abutting-range question resolves cleanly: `tstzrange` defaults to `[a,b)`,
 * `&&` on `[a,b)` and `[b,c)` is false, so the EXCLUDE constraint permits them and
 * `@>` leaves no uncovered instant at the join. That is the correct answer and the
 * first block proves it.
 *
 * The schema does not, however, constrain the BOUND TYPE, and `activePause`
 * returns `upper(period)` as the instant to retry at. Store one pause with an
 * inclusive upper bound and the retry instant is inside the pause it is retrying
 * out of — a message that defers to itself, for ever, with no deferral ceiling
 * anywhere in the queue to stop it.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { harness, queueOne, queueRow } from '../support/delivery.ts';
import { activePause, processQueue, FakeClock } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

async function insertPause(
  tenantId: string,
  contactId: string,
  lower: string,
  upper: string,
  bounds = '[)',
): Promise<void> {
  await testDb().query(
    `INSERT INTO consent_pauses (tenant_id, contact_id, channel, period)
     VALUES ($1,$2,'email',tstzrange($3::timestamptz,$4::timestamptz,$5))`,
    [tenantId, contactId, lower, upper, bounds],
  );
}

describe('QA/pauses — abutting ranges (hypothesis 6, SAFE)', () => {
  it('[a,b) and [b,c) do not overlap, so the EXCLUDE constraint permits them', async () => {
    const s = await seedAll();
    await insertPause(s.tenantId, s.contactId, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z');
    await insertPause(s.tenantId, s.contactId, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z');
    const { rows } = await testDb().query(`SELECT id FROM consent_pauses`);
    expect(rows).toHaveLength(2);

    // Proven directly against the operator `&&` uses, not merely inferred.
    const { rows: overlap } = await testDb().query<{ o: boolean }>(
      `SELECT tstzrange('2026-06-01Z','2026-07-01Z','[)')
           && tstzrange('2026-07-01Z','2026-08-01Z','[)') AS o`,
    );
    expect(overlap[0]?.o).toBe(false);
  });

  it('an overlap of even one microsecond is rejected', async () => {
    const s = await seedAll();
    await insertPause(s.tenantId, s.contactId, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z');
    await expect(
      insertPause(
        s.tenantId,
        s.contactId,
        '2026-06-30T23:59:59.999999Z',
        '2026-08-01T00:00:00Z',
      ),
    ).rejects.toThrow(/consent_pauses_no_overlap|exclusion constraint/i);
  });

  it('the boundary instant is covered by exactly one of two abutting pauses', async () => {
    const s = await seedAll();
    await insertPause(s.tenantId, s.contactId, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z');
    await insertPause(s.tenantId, s.contactId, '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z');
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM consent_pauses
        WHERE contact_id = $1 AND period @> '2026-07-01T00:00:00Z'::timestamptz`,
      [s.contactId],
    );
    expect(Number(rows[0]!.n), 'no gap and no double cover at the join').toBe(1);
  });

  it('a half-open pause releases the message exactly at its upper bound', async () => {
    const s = await seedAll();
    await optIn(testDb(), s.tenantId, s.contactId);
    await insertPause(s.tenantId, s.contactId, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z');
    const id = await queueOne(s, { scheduledAt: '2026-06-15T12:00:00Z' });

    const paused = harness({ now: '2026-06-15T12:00:00Z' });
    await processQueue(paused.deps);
    expect(paused.provider.sent).toHaveLength(0);
    expect((await queueRow(id)).scheduled_at.toISOString()).toBe('2026-07-01T00:00:00.000Z');

    const released = harness({ now: '2026-07-01T00:00:00Z' });
    await processQueue(released.deps);
    expect(released.provider.sent).toHaveLength(1);
  });
});

describe('QA/pauses — the bound type is unconstrained (BROKEN)', () => {
  it('FINDING: the schema accepts an inclusive-upper pause', async () => {
    const s = await seedAll();
    await insertPause(
      s.tenantId,
      s.contactId,
      '2026-06-01T00:00:00Z',
      '2026-07-01T00:00:00Z',
      '[]',
    );
    const { rows } = await testDb().query<{ upper_inc: boolean }>(
      `SELECT upper_inc(period) AS upper_inc FROM consent_pauses`,
    );
    expect(
      rows[0]?.upper_inc,
      'consent_pauses has no CHECK pinning the bound type, so `activePause` ' +
        'returning upper(period) as the retry instant is unsound',
    ).toBe(false);
  });

  it('FINDING: an inclusive-upper pause defers the same message for ever', async () => {
    const s = await seedAll();
    await optIn(testDb(), s.tenantId, s.contactId);
    await insertPause(
      s.tenantId,
      s.contactId,
      '2026-06-01T00:00:00Z',
      '2026-07-01T00:00:00Z',
      '[]',
    );
    const id = await queueOne(s, { scheduledAt: '2026-06-15T12:00:00Z' });

    // `activePause` reports upper(period) as the next eligible instant...
    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const paused = await activePause(testDb(), {
      contactId: s.contactId,
      channel: 'email',
      clock,
    });
    expect(paused?.upper.toISOString()).toBe('2026-07-01T00:00:00.000Z');

    // ...but at that instant the pause still contains `now`, so the gate defers
    // again to the same instant. Ten passes, ten deferrals, zero sends, and
    // nothing in the queue caps `deferrals`.
    for (let i = 0; i < 10; i++) {
      const { deps, provider } = harness({ now: '2026-07-01T00:00:00Z' });
      await processQueue(deps);
      expect(provider.sent).toHaveLength(0);
    }

    const row = await queueRow(id);
    expect(
      row.deferrals,
      `the message deferred to its own retry instant ${row.deferrals} times and will ` +
        'never make progress',
    ).toBeLessThan(10);
  });
});

describe('QA/pauses — constraint scope', () => {
  it('CHARACTERISATION: the EXCLUDE omits tenant_id, which is harmless here', async () => {
    // (contact_id, channel, period) without tenant_id would be a cross-tenant bug
    // if contacts were not globally unique. They are — contacts.id is a UUID primary
    // key — so the constraint is correct, but it is correct by luck rather than by
    // construction, and `activePause` likewise never filters by tenant.
    const { rows } = await testDb().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'consent_pauses_no_overlap'`,
    );
    expect(rows[0]?.def).not.toContain('tenant_id');
  });
});
