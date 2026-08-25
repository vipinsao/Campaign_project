/**
 * Harness for driving the delivery orchestrator in tests.
 *
 * The provider here is a recording stub rather than the real mock provider,
 * because these tests are about the GATE CHAIN and the queue state machine, and
 * they need to assert exactly how many times a send was attempted and with what.
 */
import type { Pool } from 'pg';
import type { MessageProvider, ProviderResult, OutboundMessage, Channel } from '@campaign/shared';
import type { DeliveryDeps } from '@campaign/core';
import { FakeClock } from '@campaign/core';
import { testDb } from './db.ts';

export type RecordingProvider = MessageProvider & {
  readonly sent: OutboundMessage[];
  respondWith(result: ProviderResult): void;
};

export function recordingProvider(channel: Channel = 'email'): RecordingProvider {
  const sent: OutboundMessage[] = [];
  let next: ProviderResult = { ok: true, providerMessageId: 'pm-1' };
  return {
    name: 'mock',
    channel,
    sent,
    respondWith(result) {
      next = result;
    },
    send(msg) {
      sent.push(msg);
      return Promise.resolve(next);
    },
    verifyWebhook: () => true,
    parseWebhook: () => [],
  };
}

export type Harness = {
  deps: DeliveryDeps;
  provider: RecordingProvider;
  clock: FakeClock;
};

export function harness(
  overrides: Partial<DeliveryDeps> & { now?: string; provider?: RecordingProvider } = {},
): Harness {
  const clock = new FakeClock(overrides.now ?? '2026-06-15T12:00:00Z');
  const provider = overrides.provider ?? recordingProvider();
  const db: Pool = testDb();

  const deps: DeliveryDeps = {
    db,
    clock,
    sendMode: 'mock',
    workerId: 'test-worker',
    batchSize: 50,
    resolveProvider: () => provider,
    resolveSender: () => Promise.resolve({ provider: 'mock', fromAddress: 'sender@example.com' }),
    classifyError: (_p, code) =>
      code.startsWith('terminal')
        ? { class: 'terminal', maxAttempts: 1 }
        : { class: 'transient', maxAttempts: 5 },
    backoffMs: (attempts) => Math.min(2 ** attempts, 60) * 60_000,
    maxAttempts: 5,
    ...overrides,
  };

  return { deps, provider, clock };
}

/** Queue one message for an already-seeded campaign/contact/enrolment. */
export async function queueOne(
  seeded: {
    tenantId: string;
    enrollmentId: string;
    campaignId: string;
    campaignVersionId: string;
    campaignMessageId: string;
    contactId: string;
  },
  opts: {
    scheduledAt?: string;
    channel?: Channel;
    address?: string;
    anchorId?: string | null;
    body?: string;
  } = {},
): Promise<string> {
  const { rows } = await testDb().query<{ id: string }>(
    `INSERT INTO message_queue
       (tenant_id, enrollment_id, campaign_id, campaign_version_id, campaign_message_id,
        contact_id, anchor_id, channel, recipient_address, rendered_body, rendered_subject, scheduled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Subject',$11::timestamptz)
     RETURNING id`,
    [
      seeded.tenantId,
      seeded.enrollmentId,
      seeded.campaignId,
      seeded.campaignVersionId,
      seeded.campaignMessageId,
      seeded.contactId,
      opts.anchorId ?? null,
      opts.channel ?? 'email',
      opts.address ?? 'recipient@example.com',
      opts.body ?? 'Hello. Unsubscribe: https://example.com/u/tok',
      opts.scheduledAt ?? '2026-06-15T11:00:00Z',
    ],
  );
  return rows[0]!.id;
}

export async function queueRow(id: string) {
  const { rows } = await testDb().query<{
    status: string;
    attempts: number;
    deferrals: number;
    sent_at: Date | null;
    delivered_at: Date | null;
    provider_error_code: string | null;
    error_class: string | null;
    scheduled_at: Date;
  }>(
    `SELECT status, attempts, deferrals, sent_at, delivered_at,
            provider_error_code, error_class, scheduled_at
       FROM message_queue WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

export async function decisionsFor(messageId: string) {
  const { rows } = await testDb().query<{ reason_code: string; decision: string; stage: string }>(
    `SELECT reason_code, decision, stage FROM send_decisions
      WHERE message_queue_id = $1 ORDER BY id`,
    [messageId],
  );
  return rows;
}
