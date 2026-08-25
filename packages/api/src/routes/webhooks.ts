import { Hono } from 'hono';
import { query, queryOne, addSuppression } from '@campaign/core';
import { resolveProvider, isProviderName } from '@campaign/providers';
import type { Channel, ProviderEvent } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { HttpMetrics } from '../observability/metrics.ts';
import type { AppEnv } from '../middleware/context.ts';
import { ApiError, badRequest, unauthorized } from '../errors.ts';
import { openSecret } from '../auth/secrets.ts';

/**
 * Inbound provider callbacks  (I11).
 *
 * Two properties, both of which exist because of the same class of outage.
 *
 * PERSIST BEFORE VALIDATING. The raw body and headers land in
 * `webhook_deliveries` before a single byte of it is trusted. A credential
 * rotated on the provider's side at 02:00 makes every callback fail its signature
 * check; if the endpoint rejects and discards, the delivery receipts, bounces and
 * complaints for those hours are gone permanently, and the system's own record of
 * what happened to its mail has a hole in it that nothing can fill. Persisting
 * first turns that outage into a replay.
 *
 * ITERATE EVERY ACTIVE CREDENTIAL. A tenant legitimately holds several — a
 * migration between two providers, a per-brand sending identity, a key being
 * rotated with an overlap window. `provider_credentials` says so in its own
 * comment, and the schema's UNIQUE key is (tenant, channel, LABEL) precisely so
 * several can coexist. The single-row lookup that "works" in every test with one
 * credential is the bug that rejects every callback for months once a second
 * credential appears — and it never gets investigated, because a 401 on a webhook
 * endpoint looks like someone probing you rather than like a defect.
 *
 * FAIL CLOSED. No credential matched means 401, not "process it anyway". The row
 * is kept regardless, marked `invalid`, and a replay after the credential is fixed
 * costs nothing.
 */

const MAX_BODY_BYTES = 1_000_000;

type CredentialRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly channel: Channel;
  readonly provider: string;
  readonly label: string;
  readonly secret_ciphertext: Buffer;
  readonly secret_iv: Buffer;
  readonly secret_tag: Buffer;
};

export type WebhookOutcome = {
  readonly deliveryId: string;
  readonly signatureStatus: 'valid' | 'invalid' | 'missing';
  readonly tenantId: string | null;
  readonly credentialId: string | null;
  readonly credentialsTried: number;
  readonly eventsAccepted: number;
};

export function webhookRoutes(deps: ApiDeps, metrics: HttpMetrics): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/webhooks/:provider', async (c) => {
    const provider = c.req.param('provider');
    if (!isProviderName(provider)) {
      // Rejected before anything is written: an unknown provider name is not a
      // payload worth replaying, and accepting it would let anyone fill the table.
      throw badRequest('unknown_provider', `'${provider}' is not a configured provider.`, {
        provider,
      });
    }

    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) {
      throw new ApiError(400, 'payload_too_large', 'The callback body exceeds 1 MB.', {
        bytes: raw.byteLength,
        limit: MAX_BODY_BYTES,
      });
    }

    const headers = headerRecord(c.req.raw.headers);
    const payload = parseJsonOrRaw(raw);
    const hinted = c.req.header('x-tenant-id');

    const outcome = await ingestWebhook(deps, {
      provider,
      raw,
      headers,
      payload,
      ...(hinted === undefined ? {} : { tenantHint: hinted }),
    });

    metrics.webhooks.inc({ provider, signature_status: outcome.signatureStatus });

    if (outcome.signatureStatus !== 'valid') {
      // The details name the delivery row on purpose. An operator staring at a 401
      // needs to be able to find the stored payload and replay it after fixing the
      // credential, and "which row was that?" is otherwise a timestamp hunt.
      throw unauthorized('No active credential validated this callback signature.', {
        provider,
        deliveryId: outcome.deliveryId,
        signatureStatus: outcome.signatureStatus,
        credentialsTried: outcome.credentialsTried,
        replayable: true,
      });
    }

    return c.json({
      ok: true,
      deliveryId: outcome.deliveryId,
      tenantId: outcome.tenantId,
      credentialId: outcome.credentialId,
      credentialsTried: outcome.credentialsTried,
      eventsAccepted: outcome.eventsAccepted,
    });
  });

  return app;
}

/**
 * The ingest itself, separated from the HTTP shell so the replay tool and the
 * tests drive exactly the same code the provider does. A replay path that
 * reimplements ingestion is a replay path that diverges from ingestion.
 */
export async function ingestWebhook(
  deps: ApiDeps,
  input: {
    readonly provider: string;
    readonly raw: Buffer;
    readonly headers: Record<string, string>;
    readonly payload: unknown;
    readonly tenantHint?: string;
  },
): Promise<WebhookOutcome> {
  const signaturePresent = Object.keys(input.headers).some((h) => h.includes('signature'));

  // Step one, before anything is trusted: the row exists and is replayable.
  const stored = await queryOne<{ id: string }>(
    deps.db,
    `INSERT INTO webhook_deliveries (tenant_id, provider, signature_status, headers, payload)
     VALUES (NULL, $1, $2, $3, $4) RETURNING id::text AS id`,
    [
      input.provider,
      signaturePresent ? 'invalid' : 'missing',
      JSON.stringify(input.headers),
      JSON.stringify(input.payload),
    ],
  );
  if (stored === undefined) throw new Error('webhook_deliveries insert returned no row');
  const deliveryId = stored.id;

  const credentials = await query<CredentialRow>(
    deps.db,
    `SELECT id, tenant_id, channel, provider, label, secret_ciphertext, secret_iv, secret_tag
       FROM provider_credentials
      WHERE provider = $1 AND is_active
        AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
      ORDER BY created_at, label`,
    [input.provider, input.tenantHint ?? null],
  );

  let matched: CredentialRow | undefined;
  for (const credential of credentials) {
    const secret = openSecret(
      {
        ciphertext: credential.secret_ciphertext,
        iv: credential.secret_iv,
        tag: credential.secret_tag,
      },
      deps.encryptionKey,
    );
    // A credential whose ciphertext will not open is skipped rather than fatal.
    // One unopenable row must not stop the loop before it reaches the credential
    // that would have matched — that is the single-credential bug wearing a
    // different hat.
    if (secret === undefined) continue;

    const adapter = resolveProvider(credential.channel, credential.provider, {
      db: deps.db,
      clock: deps.clock,
    });
    if (adapter.verifyWebhook(input.headers, input.raw, secret)) {
      matched = credential;
      break;
    }
  }

  if (matched === undefined) {
    return {
      deliveryId,
      signatureStatus: signaturePresent ? 'invalid' : 'missing',
      tenantId: null,
      credentialId: null,
      credentialsTried: credentials.length,
      eventsAccepted: 0,
    };
  }

  const adapter = resolveProvider(matched.channel, matched.provider, {
    db: deps.db,
    clock: deps.clock,
  });
  const events = adapter.parseWebhook(input.payload);

  let accepted = 0;
  for (const event of events) {
    accepted += await applyProviderEvent(deps, matched.tenant_id, matched.channel, event);
  }

  await deps.db.query(
    `UPDATE webhook_deliveries
        SET tenant_id = $2, signature_status = 'valid', processed_at = $3
      WHERE id = $1::bigint`,
    [deliveryId, matched.tenant_id, deps.clock.now()],
  );

  return {
    deliveryId,
    signatureStatus: 'valid',
    tenantId: matched.tenant_id,
    credentialId: matched.id,
    credentialsTried: credentials.length,
    eventsAccepted: accepted,
  };
}

const QUEUE_STATUS_FOR: Readonly<Partial<Record<ProviderEvent['type'], string>>> = {
  delivered: 'delivered',
  bounced: 'bounced',
  complained: 'complained',
  failed: 'failed',
};

/**
 * Apply one provider event to the queue row and the event store.
 *
 * `idempotency_key` is the provider's own event id, so a provider that redelivers
 * a receipt four times produces one `delivered` event rather than four. That is
 * not a nicety: `campaign_daily_stats` is rebuilt from this table, so a duplicated
 * receipt is a permanently wrong delivery rate with no evidence of how it got
 * that way.
 */
async function applyProviderEvent(
  deps: ApiDeps,
  tenantId: string,
  channel: Channel,
  event: ProviderEvent,
): Promise<number> {
  const row = await queryOne<{
    id: string;
    campaign_id: string;
    contact_id: string;
    recipient_address: string;
    sent_at: Date | null;
  }>(
    deps.db,
    `SELECT id, campaign_id, contact_id, recipient_address, sent_at
       FROM message_queue
      WHERE tenant_id = $1 AND provider_message_id = $2`,
    [tenantId, event.providerMessageId],
  );

  // An event for a message this tenant never sent is not an error and not a 500.
  // Providers replay across account boundaries during migrations, and the raw row
  // is already stored, so dropping the event here loses nothing.
  if (row === undefined) return 0;

  const inserted = await queryOne<{ id: string }>(
    deps.db,
    `INSERT INTO message_events
       (tenant_id, message_queue_id, campaign_id, contact_id, event_type, channel,
        occurred_at, idempotency_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      tenantId,
      row.id,
      row.campaign_id,
      row.contact_id,
      event.type,
      channel,
      event.occurredAt,
      event.providerEventId,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
  if (inserted === undefined) return 0;

  const status = QUEUE_STATUS_FOR[event.type];
  if (status === 'delivered') {
    // I9: `delivered_at` is written only here, from a receipt, and the CHECK
    // constraint refuses a delivery that precedes its own send — so a provider
    // whose clock runs slow cannot make the row unrepresentable.
    await deps.db.query(
      `UPDATE message_queue
          SET status = 'delivered',
              delivered_at = GREATEST($2::timestamptz, sent_at),
              updated_at = $3
        WHERE id = $1 AND sent_at IS NOT NULL`,
      [row.id, event.occurredAt, deps.clock.now()],
    );
  } else if (status !== undefined) {
    await deps.db.query(
      `UPDATE message_queue
          SET status = $2,
              provider_error_code = COALESCE($3, provider_error_code),
              error_class = CASE WHEN $2 = 'failed' THEN 'terminal' ELSE error_class END,
              updated_at = $4
        WHERE id = $1`,
      [row.id, status, event.errorCode ?? null, deps.clock.now()],
    );
  }

  // A hard bounce and a complaint suppress the ADDRESS, not the contact — see the
  // note in migrations/0002. A re-import that recreates the contact must not
  // resurrect an address the provider has already told us not to use.
  if (event.type === 'bounced' || event.type === 'complained') {
    await addSuppression(deps.db, {
      clock: deps.clock,
      tenantId,
      channel,
      address: row.recipient_address,
      reason: event.type === 'bounced' ? 'hard_bounce' : 'complaint',
      evidence: {
        provider: event.providerMessageId,
        providerEventId: event.providerEventId,
        errorCode: event.errorCode ?? null,
      },
    });
  }

  return 1;
}

export function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * A body that is not JSON is still stored, wrapped.
 *
 * `webhook_deliveries.payload` is JSONB and NOT NULL, so a form-encoded or
 * truncated body has nowhere to go unless it is wrapped. Throwing instead would
 * discard exactly the payload most worth keeping: the malformed one.
 */
export function parseJsonOrRaw(raw: Buffer): unknown {
  const text = raw.toString('utf8');
  if (text.length === 0) return { unparsed: '' };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { unparsed: text.slice(0, 10_000) };
  }
}
