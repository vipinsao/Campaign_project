/**
 * Adversarial-review helpers.
 *
 * Nothing here weakens a constraint or stubs the database. The only thing these
 * add over tests/support/delivery.ts is a provider whose `send` can be held open,
 * which is what makes a "worker is slow mid-send" race deterministic rather than
 * a sleep-and-hope.
 */
import type { Pool } from 'pg';
import type { Channel, MessageProvider, OutboundMessage, ProviderResult } from '@campaign/shared';
import type { DeliveryDeps } from '@campaign/core';
import { FakeClock } from '@campaign/core';
import { testDb } from '../support/db.ts';

/** A provider whose send() parks until `release()` is called. */
export type BlockingProvider = MessageProvider & {
  readonly sent: OutboundMessage[];
  /** Resolves the moment send() has been entered (i.e. the send is "in flight"). */
  readonly entered: Promise<void>;
  release(result?: ProviderResult): void;
};

export function blockingProvider(
  channel: Channel = 'email',
  providerMessageId = 'pm-slow',
): BlockingProvider {
  const sent: OutboundMessage[] = [];
  let onEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    onEntered = resolve;
  });
  let onRelease: (r: ProviderResult) => void = () => undefined;
  const released = new Promise<ProviderResult>((resolve) => {
    onRelease = resolve;
  });

  return {
    name: 'mock',
    channel,
    sent,
    entered,
    release(result: ProviderResult = { ok: true, providerMessageId }) {
      onRelease(result);
    },
    send(msg: OutboundMessage): Promise<ProviderResult> {
      sent.push(msg);
      onEntered();
      return released;
    },
    verifyWebhook: () => true,
    parseWebhook: () => [],
  };
}

/** A provider whose send() REJECTS, the way a socket hang-up actually surfaces. */
export function throwingProvider(channel: Channel = 'email'): MessageProvider & {
  readonly attempted: OutboundMessage[];
} {
  const attempted: OutboundMessage[] = [];
  return {
    name: 'mock',
    channel,
    attempted,
    send(msg: OutboundMessage): Promise<ProviderResult> {
      attempted.push(msg);
      return Promise.reject(new Error('ECONNRESET: socket hang up'));
    },
    verifyWebhook: () => true,
    parseWebhook: () => [],
  };
}

/** A provider that returns a scripted sequence of results. */
export function scriptedProvider(
  results: readonly ProviderResult[],
  channel: Channel = 'email',
): MessageProvider & { readonly sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  let i = 0;
  return {
    name: 'mock',
    channel,
    sent,
    send(msg: OutboundMessage): Promise<ProviderResult> {
      sent.push(msg);
      const result = results[Math.min(i, results.length - 1)]!;
      i++;
      return Promise.resolve(result);
    },
    verifyWebhook: () => true,
    parseWebhook: () => [],
  };
}

/** Delivery deps bound to an explicit provider and clock. */
export function depsFor(
  provider: MessageProvider,
  clock: FakeClock,
  overrides: Partial<DeliveryDeps> = {},
): DeliveryDeps {
  const db: Pool = testDb();
  return {
    db,
    clock,
    sendMode: 'mock',
    workerId: 'qa-worker',
    batchSize: 50,
    resolveProvider: () => provider,
    resolveSender: () => Promise.resolve({ provider: 'mock', fromAddress: 'sender@example.com' }),
    classifyError: (_p, code) =>
      code.startsWith('terminal')
        ? { class: 'terminal', maxAttempts: 1 }
        : { class: 'transient', maxAttempts: 5 },
    backoffMs: () => 60_000,
    maxAttempts: 5,
    ...overrides,
  };
}

/** Full queue row, including the columns tests/support/delivery.ts does not select. */
export async function fullQueueRow(id: string) {
  const { rows } = await testDb().query<{
    id: string;
    status: string;
    attempts: number;
    deferrals: number;
    claimed_at: Date | null;
    claimed_by: string | null;
    scheduled_at: Date;
    next_attempt_at: Date | null;
    sent_at: Date | null;
    provider: string | null;
    provider_message_id: string | null;
    provider_error_code: string | null;
    error_class: string | null;
  }>(`SELECT * FROM message_queue WHERE id = $1`, [id]);
  return rows[0];
}

export { FakeClock };
