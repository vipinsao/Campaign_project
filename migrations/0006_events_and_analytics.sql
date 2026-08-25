-- 0006 — the event store and the derived rollup  (I9, I12)
--
-- Analytics are event-sourced. message_events is append-only and is the only
-- source of truth; campaign_daily_stats is a derived rollup that can be dropped
-- and rebuilt from events at any time.
--
-- Counter columns incremented in-line by the sender are banned. They drift — a
-- crash between the send and the increment, a retry that increments twice, a
-- backfill that increments none — and once a counter has drifted there is no way
-- to recover the truth, because the evidence was never written down.

CREATE TABLE message_events (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES tenants(id)       ON DELETE CASCADE,
  message_queue_id UUID REFERENCES message_queue(id)          ON DELETE CASCADE,
  campaign_id      UUID REFERENCES campaigns(id)              ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES contacts(id)      ON DELETE CASCADE,

  event_type TEXT NOT NULL CHECK (event_type IN
    ('queued','sent','delivered','opened','clicked','bounced','complained',
     'failed','cancelled','suppressed','unsubscribed','replied','converted')),
  channel    TEXT CHECK (channel IN ('email','sms')),

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Deduplicates provider webhook redeliveries AND repeated opens by the same
  -- client. A provider that retries a delivery receipt four times must not produce
  -- four delivered events; a mail client that prefetches must not produce an open
  -- per prefetch.
  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',

  UNIQUE (tenant_id, idempotency_key)
);

CREATE TRIGGER message_events_append_only
  BEFORE UPDATE OR DELETE ON message_events
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

CREATE INDEX message_events_campaign_time ON message_events(campaign_id, event_type, occurred_at);
CREATE INDEX message_events_contact       ON message_events(contact_id, occurred_at DESC);
CREATE INDEX message_events_queue_row     ON message_events(message_queue_id, event_type);
-- Range-unique counts (see the note on campaign_daily_stats below) scan this.
CREATE INDEX message_events_unique_counts
  ON message_events(campaign_id, event_type, channel, contact_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_daily_stats — DERIVED. Droppable. Rebuildable. Never the source.
-- ─────────────────────────────────────────────────────────────────────────────
-- IMPORTANT, and stated in denominators.ts and in the UI tooltip:
--
--   unique_opens here is unique-per-CONTACT-per-DAY. Summing it across a date
--   range does NOT give a range-unique count — a contact who opens on Monday and
--   again on Tuesday contributes 2. Range queries therefore compute uniques
--   directly from message_events with COUNT(DISTINCT contact_id); this table
--   backs the daily time series only.
--
-- Getting this wrong is the exact class of bug that produces a plausible,
-- confidently-wrong number that nobody questions because it has a chart next to it.
CREATE TABLE campaign_daily_stats (
  tenant_id   UUID NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('email','sms')),

  queued      INT NOT NULL DEFAULT 0,
  sent        INT NOT NULL DEFAULT 0,
  delivered   INT NOT NULL DEFAULT 0,
  failed      INT NOT NULL DEFAULT 0,
  bounced     INT NOT NULL DEFAULT 0,
  complained  INT NOT NULL DEFAULT 0,

  unique_opens  INT NOT NULL DEFAULT 0,
  total_opens   INT NOT NULL DEFAULT 0,
  unique_clicks INT NOT NULL DEFAULT 0,
  total_clicks  INT NOT NULL DEFAULT 0,
  unsubscribes  INT NOT NULL DEFAULT 0,

  -- Counted ONLY where a clickable link was actually present in the rendered body.
  -- A message with no link must never sit in the denominator of a click rate; if it
  -- does, campaigns get graded on whether they contained a link at all. (I12)
  clickable_delivered INT NOT NULL DEFAULT 0,

  attributed_orders   INT NOT NULL DEFAULT 0,
  attributed_revenue  NUMERIC(12,2) NOT NULL DEFAULT 0,

  rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (campaign_id, day, channel)
);

CREATE INDEX campaign_daily_stats_tenant_day ON campaign_daily_stats(tenant_id, day DESC);
