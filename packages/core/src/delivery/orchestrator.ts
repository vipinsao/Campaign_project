import type { PoolClient } from 'pg';
import { type Db, queryOne } from '../db/pool.ts';
import type { Clock } from '../clock.ts';
import {
  type QueueRow,
  claimBatch,
  deferClaimed,
  markCancelled,
  markFailed,
  markSent,
  scheduleRetry,
} from '../queue/message-queue.ts';
import {
  activePause,
  activeSuppression,
  consentState,
  suppressionReasonCode,
} from '../consent/consent.ts';
import { isQuietHoursExempt, resolveSendTime } from '../scheduling/quiet-hours.ts';
import { recordDecision } from '../decisions/decision-log.ts';
import type {
  CampaignCategory,
  CampaignStatus,
  Channel,
  GateResult,
  MessageProvider,
  ReasonCode,
  SendCondition,
  SendOutcome,
} from '@campaign/shared';

/**
 * The send-time gate chain  (I1, I2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the heart of the system, and the two things worth understanding about
 * it are both about ORDER rather than about logic.
 *
 * I1 — every gate runs HERE, at send time, on the real send path.
 *
 *   Evaluating consent at enqueue time is an optimisation. It is never the
 *   authority. The gap between enqueue and send is hours or days, and in that gap
 *   the customer can opt out, the campaign can be paused, the frequency cap can
 *   fill up, and the recipient's local clock can pass 21:00. A guard that runs only
 *   in the enqueue path is a guard that the bulk-send path, the retry path and the
 *   event-triggered path all bypass — and a guard that exists in one of four code
 *   paths is not a guard.
 *
 *   This is why `provider.send` is called from exactly one place in this
 *   repository, and why tests/invariants/i1-gates-run-on-every-path.test.ts scans
 *   the source to prove it. There is no second send path to forget to guard.
 *
 * I2 — the environment guard runs BEFORE the row is claimed.
 *
 *   This one is subtle enough that it survived in production for months. Put the
 *   guard inside the send function instead, and a non-production worker pointed at
 *   a production database will claim a row, increment `attempts`, decline to send,
 *   and release it. Three passes later the message is permanently failed — a
 *   message production itself would have sent perfectly well.
 *
 *   It is invisible in production, because production never refuses. The position
 *   of a guard relative to a state transition is part of its correctness.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type SendMode = 'off' | 'mock' | 'live';

/**
 * I2. A fresh clone, a CI run and a developer laptop all refuse to send, because
 * the default is `off` and it has to be changed deliberately.
 */
export function liveSendAllowed(sendMode: SendMode): boolean {
  return sendMode === 'live' || sendMode === 'mock';
}

/** Everything a gate is allowed to look at. Gates are pure over this context. */
export type SendContext = {
  readonly message: QueueRow;
  readonly campaign: {
    readonly id: string;
    readonly status: CampaignStatus;
    readonly category: CampaignCategory;
    readonly send_window_start: string | null;
    readonly send_window_end: string | null;
    readonly send_days: number[];
  };
  readonly enrollment: {
    readonly id: string;
    readonly status: string;
    readonly stop_reason: string | null;
  };
  readonly contact: { readonly id: string; readonly timezone: string | null };
  readonly tenant: {
    readonly id: string;
    readonly default_timezone: string;
    readonly quiet_hours_start: string;
    readonly quiet_hours_end: string;
    readonly freq_cap_count: number;
    readonly freq_cap_window: string;
  };
  readonly campaignMessage: {
    readonly id: string;
    readonly send_condition: SendCondition;
    readonly sequence_order: number;
  };
  readonly db: Db | PoolClient;
  readonly clock: Clock;
};

/**
 * A gate may be synchronous. Three of the eight need no I/O at all, and forcing
 * them to be `async` just to satisfy one signature would be ceremony that hides
 * which gates actually touch the database.
 */
type Gate = {
  readonly name: string;
  evaluate(ctx: SendContext): GateResult | Promise<GateResult>;
};

const pass: GateResult = { pass: true };

function fail(
  code: ReasonCode,
  detail: string,
  opts: { retryable: boolean; nextEligibleAt?: Date },
): GateResult {
  return opts.nextEligibleAt
    ? { pass: false, retryable: opts.retryable, code, detail, nextEligibleAt: opts.nextEligibleAt }
    : { pass: false, retryable: opts.retryable, code, detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// The gates, in order. This is a literal array of named functions on purpose:
// each one is independently testable, the order is reviewable in one glance, and
// a new send path cannot accidentally skip one because there is no new send path.
// ─────────────────────────────────────────────────────────────────────────────

const campaignStillActive: Gate = {
  name: 'campaignStillActive',
  evaluate: (ctx) => {
    if (ctx.campaign.status === 'active') return pass;
    // Deliberately RETRYABLE. A paused campaign is "not now", not "not ever" — an
    // operator who pauses to fix a typo and resumes an hour later should not
    // discover that pausing destroyed every message in flight.
    if (ctx.campaign.status === 'paused') {
      return fail(
        'campaign_not_active',
        'Campaign is paused; the message is held, not cancelled.',
        {
          retryable: true,
          nextEligibleAt: new Date(ctx.clock.now().getTime() + 15 * 60_000),
        },
      );
    }
    return fail(
      'campaign_not_active',
      `Campaign status is '${ctx.campaign.status}'; queued messages will not be sent.`,
      { retryable: false },
    );
  },
};

const enrollmentStillActive: Gate = {
  name: 'enrollmentStillActive',
  evaluate: (ctx) => {
    if (ctx.enrollment.status === 'active') return pass;
    return fail(
      'enrollment_stopped',
      ctx.enrollment.stop_reason
        ? `Journey ended before this message: ${ctx.enrollment.stop_reason}.`
        : 'The contact’s journey is no longer active.',
      { retryable: false },
    );
  },
};

const consentCurrent: Gate = {
  name: 'consentCurrent',
  evaluate: async (ctx) => {
    // Transactional messages ride on the underlying transaction, not on marketing
    // consent: a receipt for a purchase the customer just made is not marketing,
    // and refusing to send it because they unsubscribed from promotions would be
    // both wrong and, for some message types, a worse compliance position.
    if (ctx.campaign.category === 'transactional') return pass;

    const state = await consentState(ctx.db, {
      tenantId: ctx.tenant.id,
      contactId: ctx.contact.id,
      channel: ctx.message.channel,
      category: ctx.campaign.category,
    });

    if (state === 'opted_out') {
      return fail(
        'consent_opted_out',
        `Contact opted out of ${ctx.message.channel} for '${ctx.campaign.category}'.`,
        { retryable: false },
      );
    }
    if (state === undefined) {
      return fail(
        'consent_never_given',
        `No opt-in on record for ${ctx.message.channel}/'${ctx.campaign.category}'.`,
        { retryable: false },
      );
    }

    const paused = await activePause(ctx.db, {
      contactId: ctx.contact.id,
      channel: ctx.message.channel,
      clock: ctx.clock,
    });
    if (paused) {
      return fail('consent_paused', `Contact paused ${ctx.message.channel} messages.`, {
        retryable: true,
        nextEligibleAt: paused.upper,
      });
    }
    return pass;
  },
};

const notSuppressed: Gate = {
  name: 'notSuppressed',
  evaluate: async (ctx) => {
    const suppression = await activeSuppression(ctx.db, {
      tenantId: ctx.tenant.id,
      channel: ctx.message.channel,
      address: ctx.message.recipient_address,
      clock: ctx.clock,
    });
    if (!suppression) return pass;
    return fail(
      suppressionReasonCode(suppression.reason),
      `${ctx.message.recipient_address} is suppressed (${suppression.reason}, recorded ` +
        `${suppression.created_at.toISOString().slice(0, 10)}).`,
      { retryable: false },
    );
  },
};

const withinQuietHours: Gate = {
  name: 'withinQuietHours',
  evaluate: (ctx) => {
    if (isQuietHoursExempt(ctx.campaign.category)) return pass;

    let decision;
    try {
      decision = resolveWindow(ctx);
    } catch (error) {
      // A campaign whose send window does not overlap the tenant floor has no
      // satisfiable send time, and `effectiveWindow` throws rather than returning
      // an empty range that would send the day-advancing loop looking for a slot
      // that cannot exist.
      //
      // That throw used to escape all the way out of processQueue, which aborted
      // the ENTIRE claimed batch: one misconfigured campaign stranded every
      // unrelated message claimed alongside it, left them in `processing` with an
      // incremented attempt count, and repeated every minute until reclaim-stale
      // burned them to permanent failure. A configuration mistake on one campaign
      // is not permitted to be an outage for the others.
      return fail(
        'campaign_window_unsatisfiable',
        error instanceof Error ? error.message : 'The campaign send window is unsatisfiable.',
        { retryable: false },
      );
    }
    return decision;
  },
};

function resolveWindow(ctx: SendContext): GateResult {
  {
    const decision = resolveSendTime({
      target: ctx.clock.now(),
      timezone: ctx.contact.timezone,
      tenantTimezone: ctx.tenant.default_timezone,
      config: {
        floorStart: ctx.tenant.quiet_hours_start,
        floorEnd: ctx.tenant.quiet_hours_end,
        windowStart: ctx.campaign.send_window_start,
        windowEnd: ctx.campaign.send_window_end,
        sendDays: ctx.campaign.send_days,
      },
    });
    if (decision.eligible) return pass;

    // Retryable, and deferral does not consume an attempt. A message held back for
    // three consecutive nights must not arrive at "permanently failed".
    return fail(
      'quiet_hours_deferred',
      `Outside the recipient’s local sending window (${ctx.contact.timezone ?? ctx.tenant.default_timezone}).`,
      { retryable: true, nextEligibleAt: decision.nextEligibleAt },
    );
  }
}

const underFrequencyCap: Gate = {
  name: 'underFrequencyCap',
  evaluate: async (ctx) => {
    // Per contact, per CHANNEL, per rolling window. Per-channel is the reading the
    // build spec implied but never stated; it is the one that matches how a
    // recipient experiences the cap, since an email and an SMS are not
    // interchangeable interruptions.
    const row = await queryOne<{ n: string }>(
      ctx.db,
      `SELECT count(*)::text AS n FROM message_queue
        WHERE tenant_id = $1 AND contact_id = $2 AND channel = $3
          AND sent_at IS NOT NULL
          AND sent_at > $4::timestamptz - $5::interval`,
      [
        ctx.tenant.id,
        ctx.contact.id,
        ctx.message.channel,
        ctx.clock.now(),
        ctx.tenant.freq_cap_window,
      ],
    );
    const sent = Number(row?.n ?? '0');
    if (sent < ctx.tenant.freq_cap_count) return pass;

    return fail(
      'frequency_cap',
      `Contact has had ${sent} ${ctx.message.channel} messages in the last ` +
        `${ctx.tenant.freq_cap_window}; the cap is ${ctx.tenant.freq_cap_count}.`,
      {
        retryable: true,
        // Re-examine tomorrow rather than spinning: the window is measured in days.
        nextEligibleAt: new Date(ctx.clock.now().getTime() + 24 * 3_600_000),
      },
    );
  },
};

const hasValidRecipientAddress: Gate = {
  name: 'hasValidRecipientAddress',
  evaluate: (ctx) => {
    const address = ctx.message.recipient_address.trim();
    const valid =
      ctx.message.channel === 'sms'
        ? /^\+[1-9]\d{6,14}$/.test(address)
        : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
    if (valid) return pass;
    return fail(
      'no_recipient_address',
      `'${address}' is not a usable ${ctx.message.channel} address.`,
      { retryable: false },
    );
  },
};

const messageConditionSatisfied: Gate = {
  name: 'messageConditionSatisfied',
  evaluate: async (ctx) => {
    const condition = ctx.campaignMessage.send_condition;
    if (condition === 'always') return pass;

    // "Previous" is the most recent SENT message in this enrolment ordered before
    // this one — regardless of channel. An email-then-SMS journey is the common
    // case, so resolving "previous" within the same channel would silently compare
    // against the wrong message, or against none at all.
    const previous = await queryOne<{ id: string }>(
      ctx.db,
      `SELECT q.id
         FROM message_queue q
         JOIN campaign_messages cm ON cm.id = q.campaign_message_id
        WHERE q.enrollment_id = $1
          AND cm.sequence_order < $2
          AND q.sent_at IS NOT NULL
        ORDER BY cm.sequence_order DESC
        LIMIT 1`,
      [ctx.message.enrollment_id, ctx.campaignMessage.sequence_order],
    );

    const needsPrevious =
      condition === 'opened_previous' ||
      condition === 'not_opened_previous' ||
      condition === 'clicked_previous' ||
      condition === 'not_clicked_previous';

    if (needsPrevious && !previous) {
      // No previous message was sent, so the condition cannot be evaluated. Failing
      // closed is the safe direction: a positive condition ("only if they opened
      // the last one") must not fire when there was no last one.
      const positive = condition === 'opened_previous' || condition === 'clicked_previous';
      return positive
        ? fail(
            'send_condition_unmet',
            `No previous message was sent, so '${condition}' cannot hold.`,
            {
              retryable: false,
            },
          )
        : pass;
    }

    const eventType =
      condition === 'opened_previous' || condition === 'not_opened_previous'
        ? 'opened'
        : condition === 'clicked_previous' || condition === 'not_clicked_previous'
          ? 'clicked'
          : 'replied';

    const scope =
      eventType === 'replied'
        ? {
            sql: 'e.contact_id = $1 AND e.campaign_id = $2',
            params: [ctx.contact.id, ctx.campaign.id],
          }
        : { sql: 'e.message_queue_id = $1', params: [previous?.id ?? null] };

    const observed = await queryOne<{ n: string }>(
      ctx.db,
      `SELECT count(*)::text AS n FROM message_events e
        WHERE ${scope.sql} AND e.event_type = $${scope.params.length + 1}`,
      [...scope.params, eventType],
    );
    const happened = Number(observed?.n ?? '0') > 0;

    const wantHappened =
      condition === 'opened_previous' ||
      condition === 'clicked_previous' ||
      condition === 'replied';

    if (happened === wantHappened) return pass;
    return fail('send_condition_unmet', `Send condition '${condition}' was not satisfied.`, {
      retryable: false,
    });
  },
};

/** The chain. Order is part of the contract; see the tests for why each place matters. */
export const GATES: readonly Gate[] = [
  campaignStillActive,
  enrollmentStillActive,
  consentCurrent,
  notSuppressed,
  withinQuietHours,
  underFrequencyCap,
  hasValidRecipientAddress,
  messageConditionSatisfied,
];

export const GATE_NAMES: readonly string[] = GATES.map((g) => g.name);

export async function runGates(ctx: SendContext): Promise<GateResult> {
  for (const gate of GATES) {
    const result = await gate.evaluate(ctx);
    if (!result.pass) return result;
  }
  return pass;
}

// ─────────────────────────────────────────────────────────────────────────────
// The send path
// ─────────────────────────────────────────────────────────────────────────────

export type DeliveryDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly sendMode: SendMode;
  readonly workerId: string;
  readonly batchSize: number;
  /** Resolves the adapter for a channel and the tenant's chosen provider. */
  readonly resolveProvider: (channel: Channel, provider: string) => MessageProvider;
  /** Chooses the sending identity. Iterates ALL active credentials; never `.single()` (I11). */
  readonly resolveSender: (
    tenantId: string,
    channel: Channel,
  ) => Promise<{ provider: string; fromAddress: string } | undefined>;
  readonly classifyError: (
    provider: string,
    code: string,
  ) => { class: 'terminal' | 'transient'; maxAttempts: number };
  readonly backoffMs: (attempts: number) => number;
  readonly maxAttempts: number;
  readonly onEvent?: (e: {
    messageId: string;
    type: string;
    tenantId: string;
    contactId: string;
    campaignId: string;
    channel: Channel;
  }) => Promise<void>;
};

type LoadedContext = Omit<SendContext, 'db' | 'clock'>;

/** One query assembles everything the gates need, so a gate cannot issue a
 *  surprise N+1 in the middle of the send path. */
async function loadContext(db: Db, message: QueueRow): Promise<LoadedContext | undefined> {
  const row = await queryOne<Record<string, unknown>>(
    db,
    `SELECT
        c.id  AS campaign_id, c.status AS campaign_status, c.category AS campaign_category,
        to_char(c.send_window_start,'HH24:MI') AS send_window_start,
        to_char(c.send_window_end,'HH24:MI')   AS send_window_end,
        c.send_days,
        e.id AS enrollment_id, e.status AS enrollment_status, e.stop_reason,
        ct.id AS contact_id, ct.timezone AS contact_timezone,
        t.id AS tenant_id, t.default_timezone,
        to_char(t.quiet_hours_start,'HH24:MI') AS quiet_hours_start,
        to_char(t.quiet_hours_end,'HH24:MI')   AS quiet_hours_end,
        t.freq_cap_count, t.freq_cap_window::text AS freq_cap_window,
        cm.id AS cm_id, cm.send_condition, cm.sequence_order
       FROM message_queue q
       JOIN campaigns c          ON c.id  = q.campaign_id
       JOIN enrollments e        ON e.id  = q.enrollment_id
       JOIN contacts ct          ON ct.id = q.contact_id
       JOIN tenants t            ON t.id  = q.tenant_id
       JOIN campaign_messages cm ON cm.id = q.campaign_message_id
      WHERE q.id = $1`,
    [message.id],
  );
  if (!row) return undefined;

  return {
    message,
    campaign: {
      id: row['campaign_id'] as string,
      status: row['campaign_status'] as CampaignStatus,
      category: row['campaign_category'] as CampaignCategory,
      send_window_start: row['send_window_start'] as string | null,
      send_window_end: row['send_window_end'] as string | null,
      send_days: row['send_days'] as number[],
    },
    enrollment: {
      id: row['enrollment_id'] as string,
      status: row['enrollment_status'] as string,
      stop_reason: row['stop_reason'] as string | null,
    },
    contact: {
      id: row['contact_id'] as string,
      timezone: row['contact_timezone'] as string | null,
    },
    tenant: {
      id: row['tenant_id'] as string,
      default_timezone: row['default_timezone'] as string,
      quiet_hours_start: row['quiet_hours_start'] as string,
      quiet_hours_end: row['quiet_hours_end'] as string,
      freq_cap_count: Number(row['freq_cap_count']),
      freq_cap_window: row['freq_cap_window'] as string,
    },
    campaignMessage: {
      id: row['cm_id'] as string,
      send_condition: row['send_condition'] as SendCondition,
      sequence_order: Number(row['sequence_order']),
    },
  };
}

/**
 * Deliver one already-claimed row.
 *
 * THIS IS THE ONLY FUNCTION IN THE REPOSITORY THAT CALLS `provider.send`.
 * tests/invariants/i1-gates-run-on-every-path.test.ts scans the source tree and
 * fails if a second call site appears, because a second send path is a send path
 * with no gates in front of it.
 */
export async function deliverClaimed(deps: DeliveryDeps, message: QueueRow): Promise<SendOutcome> {
  const loaded = await loadContext(deps.db, message);
  if (!loaded) {
    await markCancelled(deps.db, {
      id: message.id,
      reasonCode: 'recipient_not_found',
      clock: deps.clock,
    });
    return 'SKIPPED';
  }

  const ctx: SendContext = { ...loaded, db: deps.db, clock: deps.clock };
  const gate = await runGates(ctx);

  if (!gate.pass) {
    const base = {
      tenantId: ctx.tenant.id,
      campaignId: ctx.campaign.id,
      campaignMessageId: ctx.campaignMessage.id,
      contactId: ctx.contact.id,
      messageQueueId: message.id,
      orderId: message.order_id ?? undefined,
      stage: 'send' as const,
      decision: 'skip' as const,
      reasonCode: gate.code as ReasonCode,
      detail: gate.detail,
      inputs: {
        channel: message.channel,
        attempts: message.attempts,
        deferrals: message.deferrals,
        evaluatedAt: deps.clock.now().toISOString(),
        ...(gate.nextEligibleAt ? { nextEligibleAt: gate.nextEligibleAt.toISOString() } : {}),
      },
    };

    if (gate.retryable) {
      const until = gate.nextEligibleAt ?? new Date(deps.clock.now().getTime() + 3_600_000);
      await deferClaimed(deps.db, { id: message.id, until, clock: deps.clock });
      await recordDecision(deps.db, base);
      return 'DEFERRED';
    }

    await markCancelled(deps.db, { id: message.id, reasonCode: gate.code, clock: deps.clock });
    await recordDecision(deps.db, base);
    await deps.onEvent?.({
      messageId: message.id,
      type: 'cancelled',
      tenantId: ctx.tenant.id,
      contactId: ctx.contact.id,
      campaignId: ctx.campaign.id,
      channel: message.channel,
    });
    return 'SKIPPED';
  }

  // I11: the sender identity comes from iterating every ACTIVE credential for the
  // tenant and channel, not from a single-row lookup that throws the moment a
  // tenant holds more than one.
  const sender = await deps.resolveSender(ctx.tenant.id, message.channel);
  if (!sender) {
    await markCancelled(deps.db, {
      id: message.id,
      reasonCode: 'no_recipient_address',
      clock: deps.clock,
    });
    await recordDecision(deps.db, {
      tenantId: ctx.tenant.id,
      stage: 'send',
      decision: 'skip',
      reasonCode: 'no_recipient_address',
      detail: `No active ${message.channel} sender is configured for this tenant.`,
      campaignId: ctx.campaign.id,
      contactId: ctx.contact.id,
      messageQueueId: message.id,
    });
    return 'SKIPPED';
  }

  const provider = deps.resolveProvider(message.channel, sender.provider);
  const result = await provider.send({
    id: message.id,
    tenantId: ctx.tenant.id,
    channel: message.channel,
    to: message.recipient_address,
    from: sender.fromAddress,
    subject: message.rendered_subject ?? undefined,
    body: message.rendered_body,
    html: message.rendered_html ?? undefined,
    trackingId: message.tracking_id,
  });

  if (result.ok) {
    // 'sent', not 'delivered' (I9). Delivery is a fact only the provider can
    // report, and a receipt may never arrive; the UI renders "awaiting receipt"
    // rather than assuming success.
    await markSent(deps.db, {
      id: message.id,
      provider: provider.name,
      providerMessageId: result.providerMessageId,
      clock: deps.clock,
    });
    await recordDecision(deps.db, {
      tenantId: ctx.tenant.id,
      stage: 'send',
      decision: 'proceed',
      reasonCode: 'sent',
      campaignId: ctx.campaign.id,
      campaignMessageId: ctx.campaignMessage.id,
      contactId: ctx.contact.id,
      messageQueueId: message.id,
      orderId: message.order_id ?? undefined,
      inputs: { provider: provider.name, providerMessageId: result.providerMessageId },
    });
    await deps.onEvent?.({
      messageId: message.id,
      type: 'sent',
      tenantId: ctx.tenant.id,
      contactId: ctx.contact.id,
      campaignId: ctx.campaign.id,
      channel: message.channel,
    });
    return 'SENT';
  }

  // I8: the classification comes from an explicit table, and the provider's own
  // error code is persisted rather than a framework's paraphrase of it. Forensics
  // three months later depend on having the code the provider actually returned.
  const classification = deps.classifyError(provider.name, result.errorCode);
  const isTerminal = classification.class === 'terminal';
  const attemptsExhausted =
    message.attempts >= Math.min(classification.maxAttempts, deps.maxAttempts);

  if (isTerminal || attemptsExhausted) {
    await markFailed(deps.db, {
      id: message.id,
      provider: provider.name,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      errorClass: classification.class,
      clock: deps.clock,
    });
    await recordDecision(deps.db, {
      tenantId: ctx.tenant.id,
      stage: 'send',
      decision: 'skip',
      reasonCode: isTerminal ? 'provider_terminal_error' : 'retry_exhausted',
      detail: `${provider.name} returned ${result.errorCode}: ${result.errorMessage}`,
      campaignId: ctx.campaign.id,
      campaignMessageId: ctx.campaignMessage.id,
      contactId: ctx.contact.id,
      messageQueueId: message.id,
      inputs: {
        providerErrorCode: result.errorCode,
        errorClass: classification.class,
        attempts: message.attempts,
      },
    });
    await deps.onEvent?.({
      messageId: message.id,
      type: 'failed',
      tenantId: ctx.tenant.id,
      contactId: ctx.contact.id,
      campaignId: ctx.campaign.id,
      channel: message.channel,
    });
    return 'FAILED';
  }

  await scheduleRetry(deps.db, {
    id: message.id,
    provider: provider.name,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    delayMs: deps.backoffMs(message.attempts),
    clock: deps.clock,
  });
  await recordDecision(deps.db, {
    tenantId: ctx.tenant.id,
    stage: 'send',
    decision: 'skip',
    reasonCode: 'provider_transient_error',
    detail: `${provider.name} returned ${result.errorCode}; retrying.`,
    campaignId: ctx.campaign.id,
    contactId: ctx.contact.id,
    messageQueueId: message.id,
    inputs: { providerErrorCode: result.errorCode, attempts: message.attempts },
  });
  return 'DEFERRED';
}

export type QueueRunSummary = {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly deferred: number;
  readonly skipped: number;
  readonly refusedWithoutClaim: boolean;
};

/**
 * One pass of the queue.
 *
 * The ordering here IS invariant I2. `liveSendAllowed` is consulted before
 * `claimBatch`, so a worker that is not permitted to send never touches a row and
 * therefore never increments an attempt counter. Move this check three lines down,
 * inside the per-message loop, and a staging worker pointed at production silently
 * burns every message's retries.
 */
export async function processQueue(deps: DeliveryDeps): Promise<QueueRunSummary> {
  const empty = { claimed: 0, sent: 0, failed: 0, deferred: 0, skipped: 0 };

  if (!liveSendAllowed(deps.sendMode)) {
    return { ...empty, refusedWithoutClaim: true };
  }

  const claimed = await claimBatch(deps.db, {
    workerId: deps.workerId,
    batchSize: deps.batchSize,
    clock: deps.clock,
  });

  let sent = 0;
  let failed = 0;
  let deferred = 0;
  let skipped = 0;

  for (const row of claimed) {
    // One message must never be able to take the batch down with it.
    //
    // Before this, an exception anywhere in deliverClaimed - a misconfigured send
    // window, a provider adapter throwing rather than returning, an unexpected
    // null - propagated out of processQueue and abandoned every remaining row in
    // the batch. Those rows stayed in `processing` with an incremented attempt
    // count, the job retried a minute later, hit the same poison row, and
    // reclaim-stale eventually burned all of them to permanent failure. Messages
    // on entirely unrelated campaigns died because one campaign was misconfigured.
    //
    // A single message failing is a message-level event, and it is recorded as
    // one. The batch continues.
    let outcome: SendOutcome;
    try {
      outcome = await deliverClaimed(deps, row);
    } catch (error) {
      outcome = 'FAILED';
      const message = error instanceof Error ? error.message : String(error);
      try {
        await markFailed(deps.db, {
          id: row.id,
          provider: row.provider ?? 'unknown',
          errorCode: 'internal_error',
          errorMessage: message,
          errorClass: 'terminal',
          clock: deps.clock,
        });
        await recordDecision(deps.db, {
          tenantId: row.tenant_id,
          campaignId: row.campaign_id,
          contactId: row.contact_id,
          messageQueueId: row.id,
          stage: 'send',
          decision: 'skip',
          reasonCode: 'internal_error',
          detail: message,
          inputs: { error: message, attempts: row.attempts },
          decidedAt: deps.clock.now(),
        });
      } catch {
        // The database itself is unhappy. Leave the row for reclaim-stale rather
        // than losing the rest of the batch to a second failure.
      }
    }

    if (outcome === 'SENT') sent++;
    else if (outcome === 'FAILED') failed++;
    else if (outcome === 'DEFERRED') deferred++;
    else skipped++;
  }

  return { claimed: claimed.length, sent, failed, deferred, skipped, refusedWithoutClaim: false };
}
