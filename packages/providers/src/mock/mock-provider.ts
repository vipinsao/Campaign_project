import type { Channel, MessageProvider, OutboundMessage, ProviderEvent, ProviderResult } from '@campaign/shared';
import type { Clock, Db, Rng } from '../deps.ts';
import { defaultRng } from '../deps.ts';
import { parseMockWebhook, verifyMockWebhook } from './webhook.ts';

/**
 * The mock providers are first-class, not stubs.
 *
 * This is the piece that lets a reviewer clone the repository and watch the whole
 * message lifecycle -- queued, sent, delivered, bounced, complained, suppressed --
 * with no accounts, no credentials and no network. Everything downstream of the
 * provider boundary is therefore exercised by the demo rather than described by it.
 *
 * Three decisions make that work:
 *
 *  1. Sends land in a real table (`mock_outbox`), not an in-memory array. The demo
 *     UI reads the outbox the same way it would read any other record of what was
 *     sent, and the send path exercises the same transaction and the same foreign
 *     keys the real thing does.
 *  2. Outcomes are drawn from configured rates, so the demo shows bounces and
 *     complaints. A mock that always succeeds leaves the bounce handling, the
 *     suppression rules and the retry classifier permanently untested, and those
 *     are the parts of a messaging system that actually go wrong.
 *  3. Every draw goes through an injected `rng`, so a test can pin the entire
 *     sequence of outcomes and assert on it exactly.
 */

export type SimulatedOutcome = 'delivered' | 'bounced' | 'complained' | 'failed';

export type MockProviderOptions = {
  readonly db: Db;
  readonly clock: Clock;
  /** Artificial delay before `send` resolves. Zero skips the timer entirely. */
  readonly latencyMs?: number | undefined;
  /** Probability the send itself is rejected, returning `ok: false`. */
  readonly failureRate?: number | undefined;
  /** Probability the send is accepted and later bounces. */
  readonly bounceRate?: number | undefined;
  /** Probability the send is accepted, delivered, and then reported as spam. */
  readonly complaintRate?: number | undefined;
  /** How long after acceptance the simulated callback becomes due. */
  readonly webhookDelayMs?: number | undefined;
  readonly rng?: Rng | undefined;
};

const DEFAULT_FAILURE_RATE = 0.02;
const DEFAULT_BOUNCE_RATE = 0.05;
const DEFAULT_COMPLAINT_RATE = 0.01;

/**
 * Real providers call back seconds to minutes after accepting a message, never
 * inside the send call. Two seconds is long enough that a reviewer sees the row
 * sit at `sent` before it becomes `delivered`, which is the state transition worth
 * seeing, and short enough not to be tedious.
 */
const DEFAULT_WEBHOOK_DELAY_MS = 2_000;

/** A complaint follows a delivery in reality, so the simulated one does too. */
const COMPLAINT_LAG_MS = 1_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Choose an outcome from one uniform draw.
 *
 * One draw partitioning the unit interval, rather than three independent
 * comparisons, is what makes the configured rates the actual marginal
 * probabilities. Three separate draws would give a message that "failed" a second
 * chance to also "bounce", and the observed bounce rate would then depend on the
 * failure rate -- which is both wrong and extremely annoying to debug in a
 * distribution assertion.
 */
export function drawOutcome(
  u: number,
  rates: { failureRate: number; bounceRate: number; complaintRate: number },
): SimulatedOutcome {
  if (u < rates.failureRate) return 'failed';
  if (u < rates.failureRate + rates.bounceRate) return 'bounced';
  if (u < rates.failureRate + rates.bounceRate + rates.complaintRate) return 'complained';
  return 'delivered';
}

type OutboxRow = { readonly id: string };

export class MockProvider implements MessageProvider {
  readonly name = 'mock';
  readonly channel: Channel;

  readonly #db: Db;
  readonly #clock: Clock;
  readonly #latencyMs: number;
  readonly #failureRate: number;
  readonly #bounceRate: number;
  readonly #complaintRate: number;
  readonly #webhookDelayMs: number;
  readonly #rng: Rng;

  /**
   * Callbacks the simulated provider owes us, ordered by when they come due.
   *
   * The queue is in memory, and that is a deliberate boundary rather than an
   * oversight. The durable record of what is supposed to happen to each message is
   * already in `mock_outbox.simulated_outcome`; this queue only holds the schedule
   * on which the current process should fire those callbacks. A restart therefore
   * loses a timer, not a fact -- a recovery job can rebuild the queue from outbox
   * rows whose outcome has not yet been observed on the message. Persisting the
   * queue as well would give the mock two sources of truth about the same
   * simulated event, which is a class of bug the real system does not have and the
   * mock has no business inventing.
   */
  #scheduled: { readonly dueAt: number; readonly event: ProviderEvent }[] = [];

  constructor(channel: Channel, options: MockProviderOptions) {
    this.channel = channel;
    this.#db = options.db;
    this.#clock = options.clock;
    this.#latencyMs = options.latencyMs ?? 0;
    this.#failureRate = options.failureRate ?? DEFAULT_FAILURE_RATE;
    this.#bounceRate = options.bounceRate ?? DEFAULT_BOUNCE_RATE;
    this.#complaintRate = options.complaintRate ?? DEFAULT_COMPLAINT_RATE;
    this.#webhookDelayMs = options.webhookDelayMs ?? DEFAULT_WEBHOOK_DELAY_MS;
    this.#rng = options.rng ?? defaultRng;

    const total = this.#failureRate + this.#bounceRate + this.#complaintRate;
    if (total > 1) {
      // Rejected at construction rather than normalised silently. Rates summing
      // above one means the operator's intent is genuinely unclear, and quietly
      // rescaling them produces a demo that does not show what it was asked to.
      throw new Error(
        `Mock provider rates sum to ${total.toFixed(3)}, which exceeds 1. ` +
          `failureRate + bounceRate + complaintRate must leave room for a delivery.`,
      );
    }
    for (const [label, value] of [
      ['latencyMs', this.#latencyMs],
      ['webhookDelayMs', this.#webhookDelayMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Mock provider ${label} must be a non-negative number.`);
      }
    }
  }

  async send(msg: OutboundMessage): Promise<ProviderResult> {
    if (msg.channel !== this.channel) {
      // A channel mismatch here means the registry handed the message to the wrong
      // adapter, which would otherwise surface as an SMS with a subject line.
      throw new Error(
        `Mock ${this.channel} provider was handed a ${msg.channel} message (${msg.id}).`,
      );
    }

    if (this.#latencyMs > 0) await delay(this.#latencyMs);

    const outcome = drawOutcome(this.#rng(), {
      failureRate: this.#failureRate,
      bounceRate: this.#bounceRate,
      complaintRate: this.#complaintRate,
    });
    const providerMessageId = this.#nextProviderMessageId();
    const sentAt = this.#clock.now();

    // The outbox row is written for every outcome, failures included. A send that
    // the provider rejected still happened, and an outbox that only records
    // successes cannot answer "what did we actually attempt for this contact".
    //
    // `message_queue_id` is resolved through a subquery rather than bound
    // directly. In production `msg.id` is the queue row's id and the subquery is a
    // primary-key lookup; but the mock is also driven from unit tests and from
    // scripts/simulate.ts with synthetic ids that have no queue row behind them,
    // and a foreign-key violation there would make the mock harder to use than the
    // real provider it stands in for. The column is nullable for exactly this.
    const queueId = UUID_PATTERN.test(msg.id) ? msg.id : null;
    const inserted = await this.#db.query<OutboxRow>(
      `INSERT INTO mock_outbox
         (tenant_id, message_queue_id, channel, to_address, from_address,
          subject, body, html, provider_message_id, simulated_outcome, sent_at)
       VALUES ($1, (SELECT id FROM message_queue WHERE id = $2::uuid), $3, $4, $5,
               $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        msg.tenantId,
        queueId,
        msg.channel,
        msg.to,
        msg.from,
        msg.subject ?? null,
        msg.body,
        msg.html ?? null,
        providerMessageId,
        outcome,
        sentAt,
      ],
    );

    if (outcome === 'failed') {
      // A rejected send produces no callback, because a provider that never
      // accepted the message has nothing to report on it later.
      const errorCode = this.#rng() < 0.5 ? 'mock_invalid_recipient' : 'mock_rate_limited';
      return {
        ok: false,
        errorCode,
        errorMessage:
          errorCode === 'mock_invalid_recipient'
            ? `Simulated permanent rejection of ${msg.to}.`
            : 'Simulated rate limiting; the message was not accepted.',
        raw: { outboxId: inserted.rows[0]?.id ?? null, providerMessageId, simulatedOutcome: outcome },
      };
    }

    this.#schedule(providerMessageId, outcome, sentAt);
    return { ok: true, providerMessageId };
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer, secret: string): boolean {
    return verifyMockWebhook(headers, rawBody, secret);
  }

  parseWebhook(payload: unknown): ProviderEvent[] {
    return parseMockWebhook(payload);
  }

  /**
   * Drain the callbacks that have come due.
   *
   * A worker job calls this on its tick and posts the result to the real webhook
   * endpoint, signature and all, so the demo exercises the same ingestion path a
   * live provider would. Draining rather than acknowledging is the right pairing
   * here: the webhook endpoint is already idempotent on `providerEventId` (I11),
   * so an at-most-once drain into an idempotent sink needs no second delivery
   * state machine to go wrong.
   *
   * Due-ness is measured against the injected clock, which is what lets the
   * simulation advance three days and collect three days of callbacks at once.
   */
  pendingWebhookEvents(): ProviderEvent[] {
    const now = this.#clock.now().getTime();
    const due: ProviderEvent[] = [];
    const remaining: { readonly dueAt: number; readonly event: ProviderEvent }[] = [];
    for (const entry of this.#scheduled) {
      if (entry.dueAt <= now) due.push(entry.event);
      else remaining.push(entry);
    }
    this.#scheduled = remaining;
    return due;
  }

  /** Callbacks scheduled but not yet due. Exposed so a job can log a backlog. */
  scheduledWebhookCount(): number {
    return this.#scheduled.length;
  }

  #schedule(providerMessageId: string, outcome: SimulatedOutcome, sentAt: Date): void {
    const dueAt = sentAt.getTime() + this.#webhookDelayMs;
    const at = (offsetMs: number) => new Date(dueAt + offsetMs);

    if (outcome === 'bounced') {
      this.#push(dueAt, {
        providerMessageId,
        type: 'bounced',
        occurredAt: at(0),
        providerEventId: `${providerMessageId}:bounced`,
        errorCode: 'mock_invalid_recipient',
      });
      return;
    }

    // Delivery always precedes a complaint, because a recipient cannot report as
    // spam a message they were never handed. Emitting both is what gives the demo
    // a message that is delivered and then suppressed, which is the sequence the
    // consent rules actually have to cope with.
    this.#push(dueAt, {
      providerMessageId,
      type: 'delivered',
      occurredAt: at(0),
      providerEventId: `${providerMessageId}:delivered`,
    });
    if (outcome === 'complained') {
      this.#push(dueAt + COMPLAINT_LAG_MS, {
        providerMessageId,
        type: 'complained',
        occurredAt: at(COMPLAINT_LAG_MS),
        providerEventId: `${providerMessageId}:complained`,
      });
    }
  }

  #push(dueAt: number, event: ProviderEvent): void {
    this.#scheduled.push({ dueAt, event });
  }

  /**
   * Message ids come from the injected rng rather than `randomUUID` so that a
   * seeded test run produces the same ids twice. An id that changes between runs
   * cannot appear in a snapshot or in an assertion about a specific event.
   */
  #nextProviderMessageId(): string {
    let hex = '';
    for (let i = 0; i < 4; i++) {
      hex += Math.floor(this.#rng() * 0x1_0000)
        .toString(16)
        .padStart(4, '0');
    }
    return `mock-${hex}`;
  }
}

export class MockEmailProvider extends MockProvider {
  constructor(options: MockProviderOptions) {
    super('email', options);
  }
}

export class MockSmsProvider extends MockProvider {
  constructor(options: MockProviderOptions) {
    super('sms', options);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
