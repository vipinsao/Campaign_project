-- 0005 — enrolment state and the message queue  (I3, I4, I8, I9)

-- ─────────────────────────────────────────────────────────────────────────────
-- enrollments — explicit state, not implied
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE enrollments (
  id         UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id)           ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id)        ON DELETE CASCADE,
  campaign_version_id UUID NOT NULL REFERENCES campaign_versions(id) ON DELETE RESTRICT,
  contact_id UUID NOT NULL REFERENCES contacts(id)          ON DELETE CASCADE,

  anchor_type TEXT NOT NULL CHECK (anchor_type IN ('order','contact','manual')),
  anchor_id   UUID,                       -- the order that triggered it, if any

  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','completed','stopped')),
  stop_reason TEXT,                       -- machine-readable; joins to send_decisions

  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  stopped_at   TIMESTAMPTZ,

  -- One enrolment per contact per campaign per anchor. The database enforces the
  -- rule that application code forgets under concurrency.
  --
  -- NULLS NOT DISTINCT is the whole point. Postgres treats NULLs as distinct in a
  -- unique index by default, so without this clause every contact_created and
  -- manual campaign (anchor_id NULL) could create unlimited duplicate enrolments —
  -- which is precisely the case this constraint is supposed to prevent, silently
  -- not working.
  CONSTRAINT enrollments_one_per_anchor
    UNIQUE NULLS NOT DISTINCT (campaign_id, contact_id, anchor_id),

  CONSTRAINT enrollments_stopped_has_reason
    CHECK (status <> 'stopped' OR stop_reason IS NOT NULL),
  CONSTRAINT enrollments_terminal_timestamps CHECK (
    (status <> 'completed' OR completed_at IS NOT NULL) AND
    (status <> 'stopped'   OR stopped_at   IS NOT NULL)
  )
);

CREATE INDEX enrollments_campaign_status ON enrollments(campaign_id, status);
CREATE INDEX enrollments_contact         ON enrollments(tenant_id, contact_id, enrolled_at DESC);
CREATE INDEX enrollments_active          ON enrollments(campaign_id) WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- message_queue
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE message_queue (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id)            ON DELETE CASCADE,
  enrollment_id       UUID NOT NULL REFERENCES enrollments(id)        ON DELETE CASCADE,
  campaign_id         UUID NOT NULL REFERENCES campaigns(id)          ON DELETE CASCADE,
  campaign_version_id UUID NOT NULL REFERENCES campaign_versions(id)  ON DELETE RESTRICT,
  campaign_message_id UUID NOT NULL REFERENCES campaign_messages(id)  ON DELETE CASCADE,
  contact_id          UUID NOT NULL REFERENCES contacts(id)           ON DELETE CASCADE,
  order_id            UUID REFERENCES orders(id) ON DELETE SET NULL,

  -- Denormalised from the enrolment so that dedup_key below can be GENERATED.
  -- The dedup key must be computable from the row itself; a key that depends on a
  -- join is a key the database cannot enforce.
  anchor_id           UUID,

  channel           TEXT NOT NULL CHECK (channel IN ('email','sms')),
  recipient_address TEXT NOT NULL,
  rendered_subject  TEXT,
  rendered_body     TEXT NOT NULL,
  rendered_html     TEXT,
  -- Deliberately gen_random_uuid() (v4) and NOT uuidv7, unlike every primary key
  -- in this schema. tracking_id is embedded in an unauthenticated URL (the open
  -- pixel and the click redirect); a uuidv7 carries an extractable millisecond
  -- timestamp, so anyone holding one could read exactly when the message was
  -- generated. Primary keys benefit from v7's index locality; a public identifier
  -- benefits from having no structure at all.
  tracking_id       UUID NOT NULL DEFAULT gen_random_uuid(),

  scheduled_at TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                 ('pending','processing','sent','delivered','failed',
                  'cancelled','suppressed','bounced','complained')),

  -- ─── claim bookkeeping (I3) ──────────────────────────────────────────────
  claimed_at      TIMESTAMPTZ,
  claimed_by      TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,

  -- Deferrals are NOT attempts. A message held back three nights by recipient-local
  -- quiet hours must not burn three of its five delivery attempts and then be
  -- reclaimed as permanently failed. Counting a "we correctly chose not to send
  -- yet" as a "we tried and it broke" is how a working guard becomes an outage.
  deferrals        INT NOT NULL DEFAULT 0,
  last_deferred_at TIMESTAMPTZ,

  -- ─── provider truth (I8) — the provider's own code, never a paraphrase ────
  provider              TEXT,
  provider_message_id   TEXT,
  provider_error_code   TEXT,
  provider_error_message TEXT,
  error_class           TEXT CHECK (error_class IN ('terminal','transient')),

  sent_at      TIMESTAMPTZ,
  -- I9: written ONLY by a provider receipt. Never inferred from sent_at.
  delivered_at TIMESTAMPTZ,

  -- ─── I4: deduplication is a GENERATED column plus a UNIQUE index ──────────
  -- Making the key a generated column removes the failure mode one level below
  -- the constraint: application code cannot compute the key inconsistently across
  -- the enqueue path, the retry path and the bulk path, because application code
  -- does not compute it at all.
  --
  -- The anchor is part of the key. Without it, a customer who orders twice has the
  -- second journey silently swallowed by the first order's dedup key.
  dedup_key TEXT GENERATED ALWAYS AS (
    campaign_id::text || ':' ||
    campaign_message_id::text || ':' ||
    contact_id::text || ':' ||
    COALESCE(anchor_id::text, 'none')
  ) STORED,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT message_queue_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT message_queue_body_nonempty   CHECK (length(rendered_body) > 0),
  -- I9, as a constraint rather than a convention: a row cannot claim a delivery
  -- receipt it never got, and cannot be delivered before it was sent.
  CONSTRAINT message_queue_delivered_implies_sent
    CHECK (delivered_at IS NULL OR (sent_at IS NOT NULL AND delivered_at >= sent_at)),
  CONSTRAINT message_queue_sent_status_has_timestamp
    CHECK (status NOT IN ('sent','delivered') OR sent_at IS NOT NULL),
  -- A failed row must carry the provider's own classification, so forensics never
  -- depend on a framework's stringified error.
  CONSTRAINT message_queue_failed_has_error_class
    CHECK (status <> 'failed' OR error_class IS NOT NULL)
);

CREATE UNIQUE INDEX message_queue_dedup ON message_queue(tenant_id, dedup_key);   -- I4

-- The claimable index excludes delivery-anchored rows parked at 'infinity'.
-- Without the infinity predicate the index carries every parked row forever and
-- the planner walks them on every claim.
CREATE INDEX message_queue_claimable
  ON message_queue(scheduled_at)
  WHERE status = 'pending' AND scheduled_at < 'infinity';

CREATE INDEX message_queue_stale
  ON message_queue(claimed_at) WHERE status = 'processing';

CREATE INDEX message_queue_tracking ON message_queue(tracking_id);

-- Frequency cap lookup (I10): "how many did this contact get on this channel
-- inside the rolling window".
CREATE INDEX message_queue_contact_recent
  ON message_queue(tenant_id, contact_id, channel, sent_at DESC)
  WHERE sent_at IS NOT NULL;

-- Delivery-anchored rows awaiting an order delivery (and the expiry job that
-- stops them parking forever).
CREATE INDEX message_queue_anchored
  ON message_queue(order_id) WHERE status = 'pending' AND scheduled_at = 'infinity';

CREATE INDEX message_queue_enrollment ON message_queue(enrollment_id);
