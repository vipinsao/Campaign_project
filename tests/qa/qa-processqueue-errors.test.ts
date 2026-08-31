/**
 * H9 — `processQueue` error handling.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TIMING NOTE. As reviewed, the loop was:
 *
 *     for (const row of claimed) {
 *       const outcome = await deliverClaimed(deps, row);
 *     }
 *
 * with no try/catch, so any THROW (as opposed to a provider-reported failure) took
 * the whole batch down: every already-claimed row was abandoned in `processing`
 * with a burned attempt and no decision row, and recovery took five
 * STALE_CLAIM_MINUTES cycles before landing on `stale_claim_exhausted`, which
 * blames the claim mechanism rather than the provider.
 *
 * A per-message try/catch landed in the working tree from concurrent work DURING
 * this review. The tests below are written against the CURRENT tree: the original
 * finding is now fixed, and the fix introduced a new hole on the SUCCESS path.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../support/db.ts';
import { seedAll, optIn } from '../support/fixtures.ts';
import { queueOne } from '../support/delivery.ts';
import { processQueue, FakeClock } from '@campaign/core';
import type { MessageProvider, ProviderResult, OutboundMessage } from '@campaign/shared';
import { throwingProvider, scriptedProvider, depsFor, fullQueueRow } from './support.ts';

afterAll(closeTestDb);
beforeEach(resetDb);

const anchor = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function queueBatch(n: number) {
  const seeded = await seedAll();
  await optIn(testDb(), seeded.tenantId, seeded.contactId);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(await queueOne(seeded, { scheduledAt: '2026-06-15T11:00:00Z', anchorId: anchor(i) }));
  }
  return { seeded, ids };
}

async function statuses(ids: string[]) {
  const { rows } = await testDb().query<{ id: string; status: string; attempts: number }>(
    `SELECT id, status, attempts FROM message_queue WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

describe('H9 — a throwing send no longer abandons the batch (fixed mid-review)', () => {
  it('FIXED: the batch continues, and the thrown error is recorded per message', async () => {
    const { ids } = await queueBatch(5);
    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const provider = throwingProvider();

    const summary = await processQueue(depsFor(provider, clock));

    expect(summary.claimed).toBe(5);
    expect(provider.attempted, 'every row was attempted, not just the first').toHaveLength(5);
    const rows = await statuses(ids);
    expect(rows.every((r) => r.status === 'failed'), 'none stranded in `processing`').toBe(true);

    const { rows: decisions } = await testDb().query<{ reason_code: string }>(
      `SELECT DISTINCT reason_code FROM send_decisions WHERE message_queue_id = ANY($1::uuid[])`,
      [ids],
    );
    // A throw BEFORE the provider is a genuine delivery failure and is recorded as
    // one. Contrast the post-send case below, where recording a failure would be a
    // lie about a message the recipient already has.
    expect(decisions.map((d) => d.reason_code)).toEqual(['internal_error']);
  });

  it('OBSERVED: a thrown transport error is classified `terminal` and never retried', async () => {
    const { ids } = await queueBatch(1);
    const clock = new FakeClock('2026-06-15T12:00:00Z');
    await processQueue(depsFor(throwingProvider(), clock));

    const row = await fullQueueRow(ids[0]!);
    // ECONNRESET on attempt 1 of 5. `classifyError` never sees it, because the
    // catch hard-codes terminal, so a genuinely transient network blip now
    // permanently kills the message on its first attempt — the opposite of I8's
    // "terminal codes never retry, transient ones do".
    expect(row!.error_class).toBe('terminal');
    expect(row!.attempts).toBe(1);
    expect(row!.provider_error_code).toBe('internal_error');
  });
});

describe('H9 — the new catch-all also fires AFTER a successful send', () => {
  /**
   * `deliverClaimed` calls, in order: provider.send -> markSent -> recordDecision
   * -> deps.onEvent. Anything that throws in the last two steps now lands in
   * processQueue's catch, which calls markFailed on a row that WAS delivered.
   * `onEvent` is a caller-supplied hook (the worker uses it to fan out to the
   * events table), so this needs no exotic conditions.
   */
  async function sendThenFailOnEvent() {
    const { ids } = await queueBatch(1);
    const clock = new FakeClock('2026-06-15T12:00:00Z');
    const provider = scriptedProvider([{ ok: true, providerMessageId: 'pm-delivered' }]);
    const deps = depsFor(provider, clock, {
      onEvent: () => Promise.reject(new Error('event fan-out failed')),
    });
    const summary = await processQueue(deps);
    return { id: ids[0]!, provider, summary };
  }

  it('FIXED: a delivered message is never rewritten to failed by a post-send error', async () => {
    const { id, provider, summary } = await sendThenFailOnEvent();

    expect(provider.sent, 'the provider accepted it: the message went out').toHaveLength(1);
    const row = await fullQueueRow(id);
    expect(row!.sent_at, 'markSent ran and stuck').not.toBeNull();
    expect(row!.status, 'markFailed is fenced on sent_at IS NULL, so a post-send throw cannot rewrite a delivered message').toBe('sent');
    // Nothing about the failure is written to the row either: the message was
    // delivered, and the only thing that went wrong was bookkeeping afterwards.
    expect(row!.provider_error_code).toBeNull();
    expect(row!.error_class).toBeNull();
    // The summary counts it as sent, because it was.
    expect(summary.sent).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('SHOULD: a message that reached the provider is never recorded as failed', async () => {
    const { id } = await sendThenFailOnEvent();
    const row = await fullQueueRow(id);
    expect(
      row!.status === 'failed' && row!.sent_at !== null,
      'the new per-message catch in processQueue wraps the WHOLE of deliverClaimed, ' +
        'including everything after provider.send. A failure in recordDecision or ' +
        'deps.onEvent — neither of which has anything to do with delivery — now ' +
        'marks a delivered message terminally failed, with sent_at still set. That ' +
        'is the same corrupt state H2 produces, reached without any concurrency at all',
    ).toBe(false);
  });

  it('FIXED: one message produces exactly one send decision', async () => {
    const { id } = await sendThenFailOnEvent();
    const { rows } = await testDb().query<{ reason_code: string; decision: string }>(
      `SELECT reason_code, decision FROM send_decisions WHERE message_queue_id = $1 ORDER BY id`,
      [id],
    );
    // One answer, not two. recordDecision('sent') committed before onEvent threw;
    // the catch used to append internal_error/skip on top, leaving the audit log
    // this system exists to produce holding two contradictory answers to "why did
    // this message do what it did".
    expect(rows.map((r) => `${r.decision}:${r.reason_code}`)).toEqual(['proceed:sent']);
  });

  it('SHOULD: one message produces one send decision', async () => {
    const { id } = await sendThenFailOnEvent();
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM send_decisions WHERE message_queue_id = $1`,
      [id],
    );
    expect(
      Number(rows[0]!.n),
      'the decision log — the artefact this system exists to produce — now contains ' +
        'two contradictory answers to "why did this message do what it did"',
    ).toBe(1);
  });
});

describe('H9 — a poison row still cannot be isolated from a healthy one', () => {
  it('OBSERVED: healthy messages in the same batch now survive a poison row', async () => {
    const { ids } = await queueBatch(5);
    const clock = new FakeClock('2026-06-15T12:00:00Z');

    const sent: OutboundMessage[] = [];
    let first = true;
    const flaky: MessageProvider = {
      name: 'mock',
      channel: 'email',
      send(msg: OutboundMessage): Promise<ProviderResult> {
        if (first) {
          first = false;
          return Promise.reject(new Error('ECONNRESET: socket hang up'));
        }
        sent.push(msg);
        return Promise.resolve({ ok: true, providerMessageId: `pm-${sent.length}` });
      },
      verifyWebhook: () => true,
      parseWebhook: () => [],
    };

    await processQueue(depsFor(flaky, clock));

    const rows = await statuses(ids);
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(4);
    expect(rows.filter((r) => r.status === 'failed')).toHaveLength(1);
  });
});
