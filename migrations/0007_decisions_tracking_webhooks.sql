-- 0007 — the decision log, tracking surfaces, webhooks, provider credentials

-- ─────────────────────────────────────────────────────────────────────────────
-- send_decisions — I14. This table IS the feature.
-- ─────────────────────────────────────────────────────────────────────────────
-- Every enqueue AND every skip writes a row here. "Nothing happened" is never an
-- acceptable system state: an operator asking "why didn't Jane get the review
-- request?" gets 'suppressed: SMS opt-out recorded 2026-04-02 via STOP reply',
-- not a shrug and an invitation to read the source.
--
-- Retention: at portfolio scale this is a plain table. The scale-out path is
-- monthly range partitioning on decided_at plus a retention job; the threshold and
-- the reasoning are in docs/ADR-005-decision-log-retention.md rather than being
-- built now, because building it now would be complexity that has not been earned.
CREATE TABLE send_decisions (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id)             ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id)                    ON DELETE CASCADE,
  campaign_message_id UUID REFERENCES campaign_messages(id)    ON DELETE CASCADE,
  contact_id  UUID REFERENCES contacts(id)                     ON DELETE CASCADE,
  order_id    UUID REFERENCES orders(id)                       ON DELETE SET NULL,
  message_queue_id UUID REFERENCES message_queue(id)           ON DELETE SET NULL,

  stage    TEXT NOT NULL CHECK (stage IN
             ('trigger','audience','enrollment','schedule','send')),
  decision TEXT NOT NULL CHECK (decision IN ('proceed','skip')),

  -- Machine-readable, and deliberately specific. 'error' is not a reason code.
  reason_code   TEXT NOT NULL,
  -- The human sentence rendered directly in the /inspect UI.
  reason_detail TEXT,
  -- The evaluated facts, so the call can be reproduced without rerunning the world.
  inputs        JSONB NOT NULL DEFAULT '{}',

  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER send_decisions_append_only
  BEFORE UPDATE OR DELETE ON send_decisions
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE INDEX send_decisions_lookup   ON send_decisions(tenant_id, contact_id, decided_at DESC);
CREATE INDEX send_decisions_order    ON send_decisions(order_id, decided_at DESC);
CREATE INDEX send_decisions_campaign ON send_decisions(campaign_id, decided_at DESC);
CREATE INDEX send_decisions_reason   ON send_decisions(tenant_id, reason_code, decided_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- tracking + consent surfaces
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tracking_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_queue_id UUID NOT NULL REFERENCES message_queue(id) ON DELETE CASCADE,
  short_code       TEXT NOT NULL UNIQUE,        -- base62, 10 chars, crypto.randomBytes
  target_url       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tracking_links_message ON tracking_links(message_queue_id);

CREATE TABLE unsubscribe_tokens (
  token            TEXT PRIMARY KEY,            -- 32 bytes, base64url, crypto-random
  tenant_id        UUID NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_queue_id UUID REFERENCES message_queue(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at          TIMESTAMPTZ
);
CREATE INDEX unsubscribe_tokens_contact ON unsubscribe_tokens(contact_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- webhook_deliveries — I11
-- ─────────────────────────────────────────────────────────────────────────────
-- The raw payload is persisted BEFORE the signature is validated, so a batch
-- rejected because of a credential mistake can be replayed after the fix instead
-- of being lost. tenant_id is nullable precisely because a rejected payload may
-- not be attributable to a tenant at all.
CREATE TABLE webhook_deliveries (
  id        BIGSERIAL PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  provider  TEXT NOT NULL,
  signature_status TEXT NOT NULL CHECK (signature_status IN ('valid','invalid','missing')),
  headers   JSONB NOT NULL,
  payload   JSONB NOT NULL,
  processed_at     TIMESTAMPTZ,
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_replay
  ON webhook_deliveries(provider, received_at DESC) WHERE processed_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- provider_credentials — I11
-- ─────────────────────────────────────────────────────────────────────────────
-- A tenant may hold SEVERAL ACTIVE credentials per channel. Every code path that
-- reads them must iterate. A single-row lookup here is the bug that rejects every
-- provider callback with 403 for months without anyone noticing, because the
-- rejection looks like an attack rather than a defect.
CREATE TABLE provider_credentials (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel   TEXT NOT NULL CHECK (channel IN ('email','sms')),
  provider  TEXT NOT NULL CHECK (provider IN ('smtp','postmark','twilio','mock')),
  label     TEXT NOT NULL,
  from_address TEXT NOT NULL,

  -- AES-256-GCM. The key comes from ENCRYPTION_KEY and is never committed.
  secret_ciphertext BYTEA NOT NULL,
  secret_iv         BYTEA NOT NULL,
  secret_tag        BYTEA NOT NULL,

  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, label)
);
CREATE INDEX provider_credentials_active
  ON provider_credentials(tenant_id, channel) WHERE is_active;
