-- 0008 — operational surfaces: job runs, rate limiting, the mock outbox, replies

-- ─────────────────────────────────────────────────────────────────────────────
-- job_runs — a job that fails silently is worse than a job that does not exist
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE job_runs (
  id          BIGSERIAL PRIMARY KEY,
  job_name    TEXT NOT NULL,
  worker_id   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','failed','skipped_locked')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  -- Counts the job chose to report: claimed, sent, deferred, cancelled, enrolled…
  counts      JSONB NOT NULL DEFAULT '{}',
  error       TEXT,
  CONSTRAINT job_runs_finished_has_duration
    CHECK ((finished_at IS NULL) = (duration_ms IS NULL)),
  CONSTRAINT job_runs_failed_has_error CHECK (status <> 'failed' OR error IS NOT NULL)
);
CREATE INDEX job_runs_recent  ON job_runs(job_name, started_at DESC);
CREATE INDEX job_runs_failures ON job_runs(started_at DESC) WHERE status = 'failed';

-- ─────────────────────────────────────────────────────────────────────────────
-- provider_rate_buckets — cross-process token bucket
-- ─────────────────────────────────────────────────────────────────────────────
-- The limiter lives in the database because it has to hold across processes. An
-- in-process counter with two workers running enforces exactly twice the
-- configured limit, and it does so quietly — the symptom is provider throttling,
-- which looks like the provider's fault.
CREATE TABLE provider_rate_buckets (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('email','sms')),
  tokens      NUMERIC(12,4) NOT NULL,
  capacity    NUMERIC(12,4) NOT NULL,
  refill_per_second NUMERIC(12,4) NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, channel),
  CONSTRAINT rate_buckets_sane CHECK (capacity > 0 AND refill_per_second > 0 AND tokens >= 0)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- the mock outbox — a first-class citizen, not a stub
-- ─────────────────────────────────────────────────────────────────────────────
-- This is what lets a reviewer watch the complete lifecycle — including a bounce
-- and an opt-out — with zero credentials and zero accounts.
CREATE TABLE mock_outbox (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_queue_id UUID REFERENCES message_queue(id) ON DELETE CASCADE,
  channel          TEXT NOT NULL CHECK (channel IN ('email','sms')),
  to_address       TEXT NOT NULL,
  from_address     TEXT NOT NULL,
  subject          TEXT,
  body             TEXT NOT NULL,
  html             TEXT,
  provider_message_id TEXT NOT NULL,
  -- The simulated outcome this send was assigned, so the demo can show bounces
  -- and complaints rather than a uniform wall of successes.
  simulated_outcome TEXT NOT NULL DEFAULT 'delivered'
    CHECK (simulated_outcome IN ('delivered','bounced','complained','failed')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mock_outbox_recent ON mock_outbox(tenant_id, sent_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- inbound_replies — the responses inbox
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inbound_replies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id)          ON DELETE CASCADE,
  -- The message that prompted this reply, when it can be established.
  message_queue_id UUID REFERENCES message_queue(id) ON DELETE SET NULL,
  campaign_id      UUID REFERENCES campaigns(id)     ON DELETE SET NULL,

  channel      TEXT NOT NULL CHECK (channel IN ('email','sms')),
  from_address TEXT NOT NULL,
  subject      TEXT,
  body         TEXT NOT NULL,

  -- Content hash of the body, used as the classification cache key (V8).
  content_hash TEXT NOT NULL,

  provider     TEXT,
  provider_message_id TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at   TIMESTAMPTZ,

  UNIQUE (tenant_id, provider, provider_message_id)
);
CREATE INDEX inbound_replies_inbox ON inbound_replies(tenant_id, received_at DESC);
CREATE INDEX inbound_replies_open  ON inbound_replies(tenant_id, received_at DESC)
  WHERE handled_at IS NULL;
