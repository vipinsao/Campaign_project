/**
 * I14 — Every enqueue AND every skip writes a `send_decisions` row with a
 *       machine-readable reason code and the inputs it was evaluated from.
 *
 * Failure it prevents: an operator with no way to answer "why didn't this fire?"
 * other than reading source code — and an engineer whose only available response
 * is to add a log line and wait for it to happen again.
 *
 * "Nothing happened" is never an acceptable system state.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { harness, queueOne, decisionsFor, recordingProvider } from '../support/delivery.ts';
import { processQueue, GATE_NAMES, withTransaction, optOut, FakeClock } from '@campaign/core';
import { REASON_CODES } from '@campaign/shared';

afterAll(closeTestDb);
beforeEach(resetDb);

describe('I14 — every outcome leaves a reason behind', () => {
  it('logs a decision for a successful send', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded);

    await processQueue(harness().deps);

    const decisions = await decisionsFor(id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toBe('proceed');
    expect(decisions[0]!.reason_code).toBe('sent');
    expect(decisions[0]!.stage).toBe('send');
  });

  it('logs a decision for a terminal provider failure', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded);

    const provider = recordingProvider();
    provider.respondWith({
      ok: false,
      errorCode: 'terminal_hard_bounce',
      errorMessage: 'Mailbox does not exist.',
      raw: {},
    });
    await processQueue(harness({ provider }).deps);

    const decisions = await decisionsFor(id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.reason_code).toBe('provider_terminal_error');
  });

  it('logs a decision for every gate that skips, with the evaluated inputs', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded);

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    await withTransaction(testDb(), (tx) =>
      optOut(tx, {
        tenantId: seeded.tenantId,
        contactId: seeded.contactId,
        channel: 'email',
        address: 'recipient@example.com',
        source: 'unsubscribe_link',
        reason: 'unsubscribe',
        clock,
      }),
    );
    // optOut cancels the queue, so re-open this row to reach the send-time gate.
    await testDb().query(`UPDATE message_queue SET status='pending' WHERE id = $1`, [id]);

    await processQueue(harness().deps);

    const { rows } = await testDb().query<{
      reason_code: string;
      reason_detail: string;
      inputs: Record<string, unknown>;
    }>(
      `SELECT reason_code, reason_detail, inputs FROM send_decisions
        WHERE message_queue_id = $1 AND decision = 'skip'`,
      [id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason_code).toBe('consent_opted_out');
    // A human sentence the UI renders directly, not a code the operator must decode.
    expect(rows[0]!.reason_detail.length).toBeGreaterThan(10);
    // And the facts it was decided from, so the call can be reproduced.
    expect(rows[0]!.inputs['evaluatedAt']).toBeDefined();
    expect(rows[0]!.inputs['channel']).toBe('email');
  });

  it('records the next eligible time when a decision is a deferral', async () => {
    const seeded = await seedAll(testDb(), {
      tenant: { quietStart: '09:00', quietEnd: '17:00', timezone: 'UTC' },
    });
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded, { scheduledAt: '2026-06-15T20:00:00Z' });

    // 21:00 UTC, outside the 09:00-17:00 window.
    await processQueue(harness({ now: '2026-06-15T21:00:00Z' }).deps);

    const { rows } = await testDb().query<{
      reason_code: string;
      inputs: Record<string, unknown>;
    }>(`SELECT reason_code, inputs FROM send_decisions WHERE message_queue_id = $1`, [id]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason_code).toBe('quiet_hours_deferred');
    expect(
      rows[0]!.inputs['nextEligibleAt'],
      'a deferral must record WHEN it will be reconsidered, not just that it was deferred',
    ).toBeDefined();
  });

  it('has a declared reason code for every gate in the chain', () => {
    // Guards against a gate being added that skips with an undeclared string. The
    // decision log is only groupable if the vocabulary is closed.
    const codes = Object.keys(REASON_CODES);
    const perGate: Record<string, string[]> = {
      campaignStillActive: ['campaign_not_active'],
      enrollmentStillActive: ['enrollment_stopped'],
      consentCurrent: ['consent_opted_out', 'consent_never_given', 'consent_paused'],
      notSuppressed: [
        'suppressed_unsubscribe',
        'suppressed_sms_stop',
        'suppressed_hard_bounce',
        'suppressed_complaint',
        'suppressed_manual',
        'suppressed_invalid',
      ],
      withinQuietHours: ['quiet_hours_deferred'],
      underFrequencyCap: ['frequency_cap'],
      hasValidRecipientAddress: ['no_recipient_address'],
      messageConditionSatisfied: ['send_condition_unmet'],
    };

    expect(Object.keys(perGate).sort()).toEqual([...GATE_NAMES].sort());
    for (const [gate, expected] of Object.entries(perGate)) {
      for (const code of expected) {
        expect(codes, `${gate} skips with '${code}', which is not a declared reason code`).toContain(code);
      }
    }
  });

  it('never records a decision with an empty reason', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    await queueOne(seeded);
    await processQueue(harness().deps);

    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM send_decisions
        WHERE reason_code IS NULL OR reason_code = '' OR reason_detail IS NULL OR reason_detail = ''`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
