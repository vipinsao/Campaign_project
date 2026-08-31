/**
 * QA — adversarial review of suppression expiry and `addSuppression`
 * (hypothesis 5).
 *
 * The expiry race the brief asked about turns out to be handled correctly: the
 * gate evaluates `expires_at > now()` itself, so an expired-but-not-yet-swept row
 * is invisible to it, and the nightly DELETE uses the complementary `<= now()`.
 * Both boundaries agree.
 *
 * The bug is one line above that. `addSuppression` is
 *
 *     ON CONFLICT (tenant_id, channel, address) DO NOTHING
 *
 * with the comment "must not overwrite the original reason — the first reason is
 * the one with the evidence". That reasoning holds only while the original row is
 * still ACTIVE. Once it has expired but has not yet been swept, the row is a
 * tombstone that silently swallows every new suppression for that address.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { harness, queueOne, queueRow } from '../support/delivery.ts';
import { addSuppression, activeSuppression, processQueue, FakeClock } from '@campaign/core';

afterAll(closeTestDb);
beforeEach(resetDb);

const ADDRESS = 'recipient@example.com';

/** The nightly `suppression-expiry` job, verbatim from packages/worker/src/jobs. */
async function runNightlySweep(at: Date): Promise<number> {
  const { rows } = await testDb().query(
    `DELETE FROM suppressions WHERE expires_at IS NOT NULL AND expires_at <= $1 RETURNING id`,
    [at],
  );
  return rows.length;
}

describe('QA/suppression — the expiry race (hypothesis 5, SAFE)', () => {
  it('an expired-but-not-yet-swept row is not honoured by the gate', async () => {
    const s = await seedAll();
    await addSuppression(testDb(), {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'invalid',
      expiresAt: new Date('2026-06-15T11:00:00Z'),
    });
    const clock = new FakeClock('2026-06-15T12:00:00Z');
    expect(
      await activeSuppression(testDb(), {
        tenantId: s.tenantId,
        channel: 'email',
        address: ADDRESS,
        clock,
      }),
    ).toBeUndefined();
    // And the row is still physically present, i.e. the sweep has not run.
    const { rows } = await testDb().query(`SELECT id FROM suppressions`);
    expect(rows).toHaveLength(1);
  });

  it('the gate boundary and the sweep boundary are exactly complementary', async () => {
    const s = await seedAll();
    const expiresAt = new Date('2026-06-15T12:00:00Z');
    await addSuppression(testDb(), {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'invalid',
      expiresAt,
    });

    // One millisecond before: active, and the sweep leaves it alone.
    const before = new FakeClock('2026-06-15T11:59:59.999Z');
    expect(
      await activeSuppression(testDb(), {
        tenantId: s.tenantId,
        channel: 'email',
        address: ADDRESS,
        clock: before,
      }),
    ).toBeDefined();
    expect(await runNightlySweep(before.now())).toBe(0);

    // Exactly at expiry: inactive (`expires_at > now` is false), and the sweep
    // deletes it (`expires_at <= now` is true). No instant is covered by both or
    // by neither.
    const at = new FakeClock('2026-06-15T12:00:00.000Z');
    expect(
      await activeSuppression(testDb(), {
        tenantId: s.tenantId,
        channel: 'email',
        address: ADDRESS,
        clock: at,
      }),
    ).toBeUndefined();
    expect(await runNightlySweep(at.now())).toBe(1);
  });

  it('a permanent suppression (expires_at IS NULL) is never swept', async () => {
    const s = await seedAll();
    await addSuppression(testDb(), {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'hard_bounce',
    });
    expect(await runNightlySweep(new Date('2099-01-01T00:00:00Z'))).toBe(0);
  });
});

describe('QA/suppression — an expired row swallows the next suppression (BROKEN)', () => {
  it('FINDING: a HARD BOUNCE is silently dropped when an expired soft row still exists', async () => {
    const s = await seedAll();
    const db = testDb();

    // Monday: a soft failure with a 24-hour expiry.
    await addSuppression(db, {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'invalid',
      expiresAt: new Date('2026-06-15T00:00:00Z'),
      evidence: { note: 'soft' },
    });

    // Tuesday, before the 03:30 sweep: the mailbox hard-bounces. Permanent.
    await addSuppression(db, {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'hard_bounce',
      evidence: { note: 'permanent' },
    });

    const { rows } = await db.query<{ reason: string; expires_at: Date | null }>(
      `SELECT reason, expires_at FROM suppressions WHERE address = $1`,
      [ADDRESS],
    );
    expect(rows[0]?.reason, 'the hard bounce was dropped by ON CONFLICT DO NOTHING').toBe(
      'hard_bounce',
    );
    expect(rows[0]?.expires_at, 'a hard bounce never expires').toBeNull();
  });

  it('FINDING: and the consequence is that the hard-bounced address is mailed again', async () => {
    const s = await seedAll();
    const db = testDb();
    await optIn(db, s.tenantId, s.contactId);

    await addSuppression(db, {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'invalid',
      expiresAt: new Date('2026-06-15T00:00:00Z'),
    });
    await addSuppression(db, {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'hard_bounce',
    });

    const id = await queueOne(s);
    const { deps, provider } = harness({ now: '2026-06-15T12:00:00Z' });
    await processQueue(deps);

    expect(
      provider.sent,
      'a permanently hard-bounced address received mail because an expired soft ' +
        'suppression row was sitting on its unique key',
    ).toHaveLength(0);
    expect((await queueRow(id)).provider_error_code).toBe('suppressed_hard_bounce');
  });

  it('FINDING: an unsubscribe is dropped the same way, which is the compliance case', async () => {
    const s = await seedAll();
    const db = testDb();

    await addSuppression(db, {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'invalid',
      expiresAt: new Date('2026-06-15T00:00:00Z'),
    });
    await addSuppression(db, {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'unsubscribe',
    });

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const active = await activeSuppression(db, {
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      clock,
    });
    expect(active?.reason, 'the unsubscribe suppression never landed').toBe('unsubscribe');
  });

  it('an already-ACTIVE suppression correctly keeps its original reason', async () => {
    // The behaviour the ON CONFLICT was written for, and it is right in this case.
    const s = await seedAll();
    const db = testDb();
    await addSuppression(db, {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'complaint',
      evidence: { fbl: 'yes' },
    });
    await addSuppression(db, {
      clock: new FakeClock('2026-06-15T12:00:00Z'),
      tenantId: s.tenantId,
      channel: 'email',
      address: ADDRESS,
      reason: 'manual',
    });
    const { rows } = await db.query<{ reason: string; evidence: unknown }>(
      `SELECT reason, evidence FROM suppressions WHERE address = $1`,
      [ADDRESS],
    );
    expect(rows[0]?.reason).toBe('complaint');
    expect(rows[0]?.evidence).toEqual({ fbl: 'yes' });
  });
});
