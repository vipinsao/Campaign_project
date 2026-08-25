import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  activePause,
  activeSuppression,
  consentState,
  optOut,
  query,
  queryOne,
  recordConsent,
  withTransaction,
} from '@campaign/core';
import type { CampaignCategory, Channel } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { resolveUnsubscribeToken } from '../services/unsubscribe.ts';
import {
  CATEGORY_LABELS,
  TOGGLEABLE_CATEGORIES,
  renderPreferenceCentre,
  renderPreferenceResult,
  renderUnknownToken,
} from '../views/preference-centre.ts';

/**
 * The routes an email client reaches.
 *
 * Everything in this file is UNAUTHENTICATED, and it has to be: a mail client
 * fetching a tracking pixel cannot attach a bearer token, and a recipient
 * following an unsubscribe link three years after the fact has no session. The
 * capability is the URL itself, which is why the tracking id is a v4 UUID rather
 * than the uuidv7 used for every primary key in this schema (see the note in
 * migrations/0005), and why unsubscribe tokens are 32 random bytes rather than a
 * signed contact id.
 */

/** The smallest valid GIF: 1×1, one colour, transparent. 43 bytes. */
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The open-pixel idempotency key.
 *
 * `trackingId : UTC date : hash(user-agent)`. Every part of that is load-bearing.
 *
 * Mail clients prefetch. Gmail's image proxy fetches once for caching and again
 * when the message is opened; Outlook's preview pane fetches on every scroll past;
 * a security appliance fetches every URL in every message before delivering it.
 * Keying only on the tracking id would collapse a genuine second open a week later
 * into the first; keying on nothing would let one prefetching client report a
 * campaign's open rate as 400%.
 *
 * Per-day-per-client is the compromise that survives all three: repeated fetches
 * by the same client on the same day are one open, and the same person opening
 * again tomorrow is a second one. The user agent is hashed rather than stored
 * because the key ends up in an append-only table that cannot be rewritten, and a
 * raw UA string is a fingerprint nobody asked to keep.
 */
export function openIdempotencyKey(trackingId: string, at: Date, userAgent: string): string {
  const day = at.toISOString().slice(0, 10);
  const uaHash = createHash('sha256').update(userAgent).digest('hex').slice(0, 16);
  return `${trackingId}:${day}:${uaHash}`;
}

type TrackedMessage = {
  readonly id: string;
  readonly tenant_id: string;
  readonly campaign_id: string;
  readonly contact_id: string;
  readonly channel: Channel;
};

export function publicRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ───────────────────────────────────────────────────────────────────────────
  // GET /t/o/:trackingId — the open pixel
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * ALWAYS 200, always `no-store`, never a redirect and never an error.
   *
   * This endpoint is rendered inside somebody's inbox. A 404 for an unknown
   * tracking id shows a broken-image placeholder in a customer's email, and a 500
   * because analytics had a bad afternoon does the same. Worse, a distinguishable
   * response turns the endpoint into an oracle: a probe could confirm which
   * tracking ids exist, and a tracking id is a bearer capability for one message.
   *
   * `no-store` is what makes the count possible at all. Without it, the corporate
   * proxy in front of ten thousand mailboxes caches the pixel and every open after
   * the first never reaches this process.
   */
  app.get('/t/o/:trackingId', async (c) => {
    const trackingId = c.req.param('trackingId');
    try {
      await recordOpen(deps, trackingId, c.req.header('user-agent') ?? '');
    } catch (error) {
      // Analytics must never be able to break the rendering of a customer's email.
      deps.logger.warn({ err: error, trackingId }, 'open pixel could not be recorded');
    }

    c.header('content-type', 'image/gif');
    c.header('cache-control', 'no-store, no-cache, must-revalidate, private');
    c.header('pragma', 'no-cache');
    c.header('content-length', String(PIXEL.byteLength));
    return c.body(PIXEL.buffer.slice(PIXEL.byteOffset, PIXEL.byteOffset + PIXEL.byteLength), 200);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GET /t/c/:shortCode and GET /r/:shortCode — click and SMS redirects
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * Two paths, one handler. `/t/c/` is the email click wrapper; `/r/` is the SMS
   * short link, which is separate only because every character of an SMS costs
   * money and `/t/c/` is four characters more than `/r/`.
   *
   * The redirect target comes from `tracking_links`, a row this system wrote when
   * it rendered the message. It is never taken from the query string: an
   * open-redirect on a domain that also sends mail is a phishing kit, and the
   * domain's reputation is the asset being borrowed.
   */
  const redirect = async (c: Context<AppEnv>) => {
    const shortCode = c.req.param('shortCode') ?? '';
    const link = await queryOne<{
      target_url: string;
      tenant_id: string;
      message_queue_id: string;
      campaign_id: string;
      contact_id: string;
      channel: Channel;
    }>(
      deps.db,
      `SELECT tl.target_url, tl.tenant_id, tl.message_queue_id,
              q.campaign_id, q.contact_id, q.channel
         FROM tracking_links tl
         JOIN message_queue q ON q.id = tl.message_queue_id
        WHERE tl.short_code = $1`,
      [shortCode],
    );

    if (link === undefined || !/^https?:\/\//i.test(link.target_url)) {
      return c.html(renderUnknownToken(), 404);
    }

    try {
      await recordEvent(deps, {
        tenantId: link.tenant_id,
        messageQueueId: link.message_queue_id,
        campaignId: link.campaign_id,
        contactId: link.contact_id,
        channel: link.channel,
        eventType: 'clicked',
        idempotencyKey: `click:${openIdempotencyKey(shortCode, deps.clock.now(), c.req.header('user-agent') ?? '')}`,
        metadata: { shortCode },
      });
    } catch (error) {
      // The customer's click goes through whether or not we managed to count it.
      deps.logger.warn({ err: error, shortCode }, 'click could not be recorded');
    }

    c.header('cache-control', 'no-store');
    return c.redirect(link.target_url, 302);
  };

  app.get('/t/c/:shortCode', redirect);
  app.get('/r/:shortCode', redirect);

  // ───────────────────────────────────────────────────────────────────────────
  // GET /u/:token — the preference centre
  // ───────────────────────────────────────────────────────────────────────────
  app.get('/u/:token', async (c) => {
    const token = c.req.param('token');
    const resolved = await resolveUnsubscribeToken(deps.db, token);
    if (resolved === undefined) return c.html(renderUnknownToken(), 404);

    const channel: Channel = 'email';
    const categories = await Promise.all(
      TOGGLEABLE_CATEGORIES.map(async (category) => {
        const state = await consentState(deps.db, {
          tenantId: resolved.tenant_id,
          contactId: resolved.contact_id,
          channel,
          category: category as CampaignCategory,
        });
        return {
          category,
          label: CATEGORY_LABELS[category] ?? category,
          // Absence of a row shows as opted out. The page must never present
          // "you are subscribed" to somebody who never said so.
          optedIn: state === 'opted_in',
        };
      }),
    );

    const address = resolved.email ?? resolved.phone ?? '';
    const suppression =
      address.length === 0
        ? undefined
        : await activeSuppression(deps.db, {
            tenantId: resolved.tenant_id,
            channel,
            address,
            clock: deps.clock,
          });
    const paused = await activePause(deps.db, {
      contactId: resolved.contact_id,
      channel,
      clock: deps.clock,
    });

    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.html(
      renderPreferenceCentre({
        token,
        tenantName: resolved.tenant_name,
        greetingName: resolved.first_name ?? 'Hello',
        email: resolved.email,
        phone: resolved.phone,
        categories,
        pausedUntil: paused ? paused.upper.toISOString().slice(0, 10) : null,
        suppressed: suppression !== undefined,
      }),
      200,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // POST /u/:token — apply the change
  // ───────────────────────────────────────────────────────────────────────────
  app.post('/u/:token', async (c) => {
    const token = c.req.param('token');
    const resolved = await resolveUnsubscribeToken(deps.db, token);
    if (resolved === undefined) return c.html(renderUnknownToken(), 404);

    const form = await readSubmission(c.req.raw);
    const channel: Channel = form.channel === 'sms' ? 'sms' : 'email';
    const address = (channel === 'sms' ? resolved.phone : resolved.email) ?? '';
    const evidence = {
      token,
      userAgent: c.req.header('user-agent') ?? null,
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      messageQueueId: resolved.message_queue_id,
    };

    const outcome = await applyPreferenceChange(deps, {
      resolved,
      channel,
      address,
      form,
      evidence,
    });

    await deps.db.query(`UPDATE unsubscribe_tokens SET used_at = $2 WHERE token = $1`, [
      token,
      deps.clock.now(),
    ]);

    if (wantsJson(c.req.raw)) return c.json(outcome, 200);

    c.header('cache-control', 'no-store');
    return c.html(
      renderPreferenceResult({
        tenantName: resolved.tenant_name,
        headline: outcome.headline,
        detail: outcome.detail,
        token,
      }),
      200,
    );
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preference changes
// ─────────────────────────────────────────────────────────────────────────────

export type PreferenceSubmission = {
  readonly action: 'update' | 'pause' | 'unsubscribe_all';
  readonly channel: string;
  /** Category → desired state. Absent categories are left untouched. */
  readonly categories: Readonly<Record<string, 'opted_in' | 'opted_out'>>;
  readonly pauseDays: number;
};

export type PreferenceOutcome = {
  readonly action: PreferenceSubmission['action'];
  readonly headline: string;
  readonly detail: string;
  readonly cancelledMessageIds: readonly string[];
  readonly categories: Readonly<Record<string, 'opted_in' | 'opted_out'>>;
  readonly pausedUntil: string | null;
};

const PAUSE_DAYS_DEFAULT = 30;

async function applyPreferenceChange(
  deps: ApiDeps,
  input: {
    readonly resolved: { tenant_id: string; contact_id: string };
    readonly channel: Channel;
    readonly address: string;
    readonly form: PreferenceSubmission;
    readonly evidence: Record<string, unknown>;
  },
): Promise<PreferenceOutcome> {
  const { resolved, channel, address, form, evidence } = input;

  if (form.action === 'unsubscribe_all') {
    /**
     * One transaction: the ledger row, the address suppression and the queue
     * cancellation. `optOut` in packages/core does all three together, and it does
     * them together because any two of the three without the third is a system
     * that has half-listened — a recorded opt-out with three messages still
     * queued, or a suppression with no evidence of who asked for it.
     */
    const result = await withTransaction(deps.db, (tx) =>
      optOut(tx, {
        tenantId: resolved.tenant_id,
        contactId: resolved.contact_id,
        channel,
        address,
        category: null,
        source: 'unsubscribe_link',
        reason: 'unsubscribe',
        evidence,
        clock: deps.clock,
      }),
    );

    return {
      action: 'unsubscribe_all',
      headline: 'You have been unsubscribed',
      detail:
        result.cancelledMessageIds.length > 0
          ? `We have removed ${address} from all marketing messages and cancelled ` +
            `${result.cancelledMessageIds.length} message(s) that were already scheduled.`
          : `We have removed ${address} from all marketing messages.`,
      cancelledMessageIds: result.cancelledMessageIds,
      categories: {},
      pausedUntil: null,
    };
  }

  if (form.action === 'pause') {
    const days = Number.isFinite(form.pauseDays) && form.pauseDays > 0 ? form.pauseDays : PAUSE_DAYS_DEFAULT;
    const from = deps.clock.now();
    const until = new Date(from.getTime() + days * 86_400_000);

    await withTransaction(deps.db, async (tx) => {
      // `consent_pauses` carries an EXCLUDE constraint against overlapping ranges,
      // and an exclusion constraint cannot be resolved with ON CONFLICT. Replacing
      // the overlap is also the right semantics: somebody pressing "pause" again
      // means "pause from now", not "please error".
      await tx.query(
        `DELETE FROM consent_pauses
          WHERE contact_id = $1 AND channel = $2 AND period && tstzrange($3, $4, '[)')`,
        [resolved.contact_id, channel, from, until],
      );
      await tx.query(
        `INSERT INTO consent_pauses (tenant_id, contact_id, channel, period, source)
         VALUES ($1,$2,$3,tstzrange($4,$5,'[)'),'preference_center')`,
        [resolved.tenant_id, resolved.contact_id, channel, from, until],
      );
    });

    // Deliberately no cancellation here. A pause is "not now", and the send-time
    // gate defers rather than cancels — cancelling would mean a customer who asked
    // for a month of quiet loses the journey they were part way through.
    return {
      action: 'pause',
      headline: 'Messages paused',
      detail: `We will not send you marketing messages until ${until.toISOString().slice(0, 10)}.`,
      cancelledMessageIds: [],
      categories: {},
      pausedUntil: until.toISOString(),
    };
  }

  // ── action === 'update': per-category toggles ──────────────────────────────
  const applied: Record<string, 'opted_in' | 'opted_out'> = {};
  const optedOut: string[] = [];

  await withTransaction(deps.db, async (tx) => {
    for (const category of TOGGLEABLE_CATEGORIES) {
      const desired = form.categories[category] ?? 'opted_out';
      applied[category] = desired;
      await recordConsent(tx, {
        tenantId: resolved.tenant_id,
        contactId: resolved.contact_id,
        channel,
        category: category as CampaignCategory,
        state: desired,
        source: 'preference_center',
        evidence,
        clock: deps.clock,
      });
      if (desired === 'opted_out') optedOut.push(category);
    }

    // Re-enabling any category is a resubscribe, so the address-level suppression
    // has to go. Leaving it would make the toggles decorative: the ledger would say
    // opted in and the send-time gate would still refuse on the suppression, and
    // nothing in the UI would explain why.
    if (optedOut.length < TOGGLEABLE_CATEGORIES.length && address.length > 0) {
      await tx.query(
        `DELETE FROM suppressions
          WHERE tenant_id = $1 AND channel = $2 AND address = $3 AND reason = 'unsubscribe'`,
        [resolved.tenant_id, channel, address],
      );
    }
  });

  // Queued messages for a category the recipient just switched off are cancelled
  // now rather than left for the send-time gate. The gate would catch them, but the
  // recipient asked to stop and a row sitting at `pending` for two days looks, to
  // anyone reading the queue, like mail that is still going to go out.
  const cancelled =
    optedOut.length === 0
      ? []
      : await query<{ id: string }>(
          deps.db,
          `UPDATE message_queue q
              SET status = 'cancelled', provider_error_code = 'consent_opted_out', updated_at = $4
             FROM campaigns c
            WHERE c.id = q.campaign_id
              AND q.tenant_id = $1 AND q.contact_id = $2 AND q.channel = $5
              AND q.status IN ('pending','processing')
              AND c.category = ANY($3::text[])
          RETURNING q.id`,
          [resolved.tenant_id, resolved.contact_id, optedOut, deps.clock.now(), channel],
        );

  return {
    action: 'update',
    headline: 'Preferences saved',
    detail:
      optedOut.length === 0
        ? 'You will keep receiving the messages you selected.'
        : `We have stopped ${optedOut.join(' and ')} messages` +
          (cancelled.length > 0 ? ` and cancelled ${cancelled.length} already scheduled.` : '.'),
    cancelledMessageIds: cancelled.map((r) => r.id),
    categories: applied,
    pausedUntil: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event recording
// ─────────────────────────────────────────────────────────────────────────────

async function recordOpen(deps: ApiDeps, trackingId: string, userAgent: string): Promise<void> {
  if (!UUID.test(trackingId)) return;

  const message = await queryOne<TrackedMessage>(
    deps.db,
    `SELECT id, tenant_id, campaign_id, contact_id, channel
       FROM message_queue WHERE tracking_id = $1::uuid`,
    [trackingId],
  );
  if (message === undefined) return;

  await recordEvent(deps, {
    tenantId: message.tenant_id,
    messageQueueId: message.id,
    campaignId: message.campaign_id,
    contactId: message.contact_id,
    channel: message.channel,
    eventType: 'opened',
    idempotencyKey: openIdempotencyKey(trackingId, deps.clock.now(), userAgent),
    metadata: {},
  });
}

async function recordEvent(
  deps: ApiDeps,
  input: {
    readonly tenantId: string;
    readonly messageQueueId: string;
    readonly campaignId: string;
    readonly contactId: string;
    readonly channel: Channel;
    readonly eventType: string;
    readonly idempotencyKey: string;
    readonly metadata: Record<string, unknown>;
  },
): Promise<void> {
  await deps.db.query(
    `INSERT INTO message_events
       (tenant_id, message_queue_id, campaign_id, contact_id, event_type, channel,
        occurred_at, idempotency_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [
      input.tenantId,
      input.messageQueueId,
      input.campaignId,
      input.contactId,
      input.eventType,
      input.channel,
      deps.clock.now(),
      input.idempotencyKey,
      JSON.stringify(input.metadata),
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Request parsing
// ─────────────────────────────────────────────────────────────────────────────

function wantsJson(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  const contentType = request.headers.get('content-type') ?? '';
  return accept.includes('application/json') || contentType.includes('application/json');
}

/**
 * Accept both a browser form post and a JSON body.
 *
 * The form is what the preference-centre page sends and therefore the one that has
 * to work without JavaScript. JSON is what the tests and the demo script send.
 * Supporting both is four lines here, versus a page that only works with a bundle
 * loaded — which is the version that fails in the webmail clients that matter.
 */
export async function readSubmission(request: Request): Promise<PreferenceSubmission> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const parsed: unknown = await request.json();
    const raw: Record<string, unknown> =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const categories: Record<string, 'opted_in' | 'opted_out'> = {};
    const supplied = raw['categories'];
    if (typeof supplied === 'object' && supplied !== null) {
      for (const [key, value] of Object.entries(supplied as Record<string, unknown>)) {
        if (value === 'opted_in' || value === 'opted_out') categories[key] = value;
        else if (value === true) categories[key] = 'opted_in';
        else if (value === false) categories[key] = 'opted_out';
      }
    }
    return {
      action: normaliseAction(raw['action']),
      channel: typeof raw['channel'] === 'string' ? raw['channel'] : 'email',
      categories,
      pauseDays: typeof raw['pauseDays'] === 'number' ? raw['pauseDays'] : PAUSE_DAYS_DEFAULT,
    };
  }

  // `URLSearchParams` over the raw text rather than `Request.formData()`. The
  // preference-centre form is urlencoded and has no file inputs, so the multipart
  // machinery buys nothing — and `formData()` in a server runtime buffers whatever
  // it is given, which on a public unauthenticated POST is an invitation.
  const form = new URLSearchParams(await request.text());

  const categories: Record<string, 'opted_in' | 'opted_out'> = {};
  // An HTML checkbox that is OFF sends nothing at all, so every toggleable
  // category starts at opted_out and is upgraded only if its field arrived.
  // Reading only the present keys would make unchecking a box a silent no-op.
  for (const category of TOGGLEABLE_CATEGORIES) {
    categories[category] = form.has(`category:${category}`) ? 'opted_in' : 'opted_out';
  }

  const days = form.get('pauseDays');
  return {
    action: normaliseAction(form.get('action')),
    channel: form.get('channel') ?? 'email',
    categories,
    pauseDays: days === null ? PAUSE_DAYS_DEFAULT : Number(days),
  };
}

function normaliseAction(value: unknown): PreferenceSubmission['action'] {
  if (value === 'unsubscribe_all' || value === 'pause') return value;
  return 'update';
}
