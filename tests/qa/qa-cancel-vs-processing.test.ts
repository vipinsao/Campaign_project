/**
 * H5 — cancelling a row a worker is holding.
 *
 * `cancelQueuedForContact` (and the copy of it inlined into `optOut`) matches
 * `status IN ('pending','processing')`. Cancelling a row in `processing` cancels a
 * row that a worker currently owns, and nothing tells the worker.
 *
 * Note also: `cancelQueuedForContact` has ZERO call sites in the repository. The
 * behaviour that ships is the duplicated copy inside consent.ts/optOut. The
 * reviewed function is dead code, so the review of it is a review of something no
 * operator can trigger.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { queueOne } from '../support/delivery.ts';
import {
  claimBatch,
  cancelQueuedForContact,
  deliverClaimed,
  optOut,
  withTransaction,
  FakeClock,
} from '@campaign/core';
import { scriptedProvider, depsFor, fullQueueRow } from './support.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

describe('H5 — a cancelled row is silently resurrected by the worker holding it', () => {
  it('OBSERVED: cancelQueuedForContact cancels a `processing` row and leaves the claim stamp on it', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z' });
    const clock = new FakeClock('2026-06-15T12:00:00Z');

    await claimBatch(testDb(), { workerId: 'holder', batchSize: 1, clock });

    const cancelled = await cancelQueuedForContact(testDb(), {
      tenantId: seeded.tenantId,
      contactId: seeded.contactId,
      channel: 'email',
      reasonCode: 'enrollment_stopped',
      clock,
    });
    expect(cancelled).toEqual([id]);

    const row = await fullQueueRow(id);
    expect(row!.status).toBe('cancelled');
    // markCancelled clears claimed_at/claimed_by; this path does not. The row is
    // now `cancelled` while still stamped as owned by a live worker, and no index
    // or sweep will ever look at it again.
    expect(row!.claimed_by, 'stale claim stamp survives the cancellation').toBe('holder');
    expect(row!.claimed_at).not.toBeNull();
  });

  it('FIXED: the holding worker does not send a message cancelled under it', async () => {
    const seeded = await seedAll();
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z' });

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const claimed = await claimBatch(testDb(), { workerId: 'holder', batchSize: 1, clock });
    expect(claimed).toHaveLength(1);

    // An operator (or a stop-condition sweep) cancels everything queued for this
    // contact. The reason is not a consent reason, so no gate will re-derive it.
    await cancelQueuedForContact(testDb(), {
      tenantId: seeded.tenantId,
      contactId: seeded.contactId,
      channel: 'email',
      reasonCode: 'enrollment_stopped',
      clock,
    });
    expect((await fullQueueRow(id))!.status).toBe('cancelled');

    // The worker, holding its pre-cancellation snapshot, finishes the job. Every
    // gate re-reads the world, and not one of them re-reads THIS ROW's status.
    const provider = scriptedProvider([{ ok: true, providerMessageId: 'pm-after-cancel' }]);
    const outcome = await deliverClaimed(depsFor(provider, clock), claimed[0]!);

    // refreshClaim runs immediately before provider.send, finds the claim gone, and
    // stops. That placement is the whole point: it is the last moment at which the
    // decision is still reversible, because everything after it is a network call
    // that cannot be recalled.
    expect(outcome).toBe('ALREADY_CLAIMED');
    expect(provider.sent, 'a cancelled message must never reach the provider').toHaveLength(0);
    const row = await fullQueueRow(id);
    expect(row!.status, 'and it stays cancelled').toBe('cancelled');
    expect(row!.provider_error_code, 'the cancellation reason is still on the row').toBe(
      'enrollment_stopped',
    );
  });

  it('NOTE: the same shape in optOut was fixed by concurrent work DURING this review', async () => {
    // As reviewed, optOut's inlined copy of this UPDATE had no category filter, so
    // a lifecycle-scoped opt-out cancelled queued TRANSACTIONAL messages. The
    // working tree now filters on campaign category. cancelQueuedForContact — the
    // function actually in scope, in message-queue.ts — was not changed, and is
    // still the unfiltered, unguarded version.
    const seeded = await seedAll(testDb(), { campaign: { category: 'transactional' } });
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    const id = await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z' });
    const clock = new FakeClock('2026-06-15T12:00:00Z');

    const result = await withTransaction(testDb(), (tx) =>
      optOut(tx, {
        tenantId: seeded.tenantId,
        contactId: seeded.contactId,
        channel: 'email',
        address: 'recipient@example.com',
        category: 'lifecycle',
        source: 'unsubscribe_link',
        reason: 'unsubscribe',
        clock,
      }),
    );
    expect(result.cancelledMessageIds, 'optOut now leaves transactional alone').toEqual([]);

    // cancelQueuedForContact still does not care.
    const viaQueue = await cancelQueuedForContact(testDb(), {
      tenantId: seeded.tenantId,
      contactId: seeded.contactId,
      channel: 'email',
      reasonCode: 'enrollment_stopped',
      clock,
    });
    expect(viaQueue, 'the in-scope function cancels the transactional row').toEqual([id]);
  });

  it('SHOULD: a message cancelled before the send completes is never handed to the provider', async () => {
    const seeded = await seedAll(testDb(), { campaign: { category: 'transactional' } });
    await optIn(testDb(), seeded.tenantId, seeded.contactId);
    await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z' });

    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const claimed = await claimBatch(testDb(), { workerId: 'holder', batchSize: 1, clock });

    await cancelQueuedForContact(testDb(), {
      tenantId: seeded.tenantId,
      contactId: seeded.contactId,
      channel: 'email',
      reasonCode: 'enrollment_stopped',
      clock,
    });

    const provider = scriptedProvider([{ ok: true, providerMessageId: 'pm' }]);
    await deliverClaimed(depsFor(provider, clock), claimed[0]!);

    expect(
      provider.sent.length,
      'cancelQueuedForContact writes `cancelled` onto a row a worker owns, and no ' +
        'gate and no writer re-reads the status before provider.send, so the ' +
        'cancellation is honoured only for rows nobody happened to be holding',
    ).toBe(0);
  });

  it('NOTE: cancelQueuedForContact has no call sites — the shipped behaviour is a duplicate inside optOut', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files = [
      'packages/core/src/consent/consent.ts',
      'packages/core/src/delivery/orchestrator.ts',
      'packages/core/src/triggers/enrolment.ts',
      'packages/worker/src/jobs/index.ts',
    ];
    const callSites = files.filter((f) => {
      try {
        return readFileSync(root + f, 'utf8').includes('cancelQueuedForContact');
      } catch {
        return false;
      }
    });
    expect(callSites, 'nothing calls it').toEqual([]);
    // And the copy that IS live has drifted: optOut derives its reason code from
    // the suppression reason, cancelQueuedForContact takes an arbitrary string.
    expect(readFileSync(root + 'packages/core/src/consent/consent.ts', 'utf8')).toContain(
      "SET status = 'cancelled'",
    );
  });
});
