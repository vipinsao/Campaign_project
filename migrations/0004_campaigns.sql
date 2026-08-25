-- 0004 — campaigns, versions, messages, stop conditions, goals

CREATE TABLE campaigns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,

  -- Deliberately small and DB-enforced. Adding a fifth category requires a
  -- migration and an ADR, not a one-line TypeScript change. Taxonomies grow by
  -- accretion until nobody can say what a category means; a CHECK constraint is
  -- the structural fix, not a naming convention.
  category    TEXT NOT NULL CHECK (category IN
                ('lifecycle','promotional','transactional','operational')),

  trigger_type TEXT NOT NULL CHECK (trigger_type IN
                 ('order_placed','order_shipped','order_delivered','order_cancelled',
                  'days_since_last_order','contact_created','manual','api_event')),
  trigger_config JSONB NOT NULL DEFAULT '{}',

  channels    TEXT[] NOT NULL DEFAULT '{email}',

  -- 'observe' evaluates and LOGS every decision but never enqueues. Ship every new
  -- campaign in observe for a day and read the decision log before going active.
  -- This state is the cheapest insurance in the system.
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                ('draft','observe','active','paused','archived')),

  audience    JSONB NOT NULL DEFAULT '{}',

  -- These NARROW the tenant quiet-hours floor. They can never widen it (I5).
  send_window_start TIME,
  send_window_end   TIME,
  send_days         INT[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',

  one_time_per_contact BOOLEAN NOT NULL DEFAULT false,
  flow_definition      JSONB,
  active_version_id    UUID,          -- FK added in 0005, after campaign_versions

  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT campaigns_channels_nonempty CHECK (cardinality(channels) > 0),
  CONSTRAINT campaigns_channels_valid
    CHECK (channels <@ ARRAY['email','sms']::TEXT[]),
  CONSTRAINT campaigns_send_days_valid
    CHECK (send_days <@ ARRAY[0,1,2,3,4,5,6] AND cardinality(send_days) > 0),

  -- A campaign window of 22:00–23:00 would produce start > end after being clamped
  -- against the tenant floor, and the scheduler would search for a slot that cannot
  -- exist — spinning forward through days forever. Reject the configuration at
  -- write time instead of discovering it in a scheduler loop.
  CONSTRAINT campaigns_send_window_ordered
    CHECK (send_window_start IS NULL OR send_window_end IS NULL
           OR send_window_start < send_window_end),
  CONSTRAINT campaigns_send_window_paired
    CHECK ((send_window_start IS NULL) = (send_window_end IS NULL))
);

CREATE INDEX campaigns_tenant_status ON campaigns(tenant_id, status);
CREATE INDEX campaigns_trigger       ON campaigns(tenant_id, trigger_type)
  WHERE status IN ('active','observe');

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_versions — an immutable snapshot taken at activation
-- ─────────────────────────────────────────────────────────────────────────────
-- Editing a live campaign must not retroactively change what analytics say was
-- sent. Queued rows reference the version that produced them, so "what did this
-- recipient actually receive" stays answerable after the operator rewrites the copy.
CREATE TABLE campaign_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  version      INT NOT NULL,
  snapshot     JSONB NOT NULL,            -- campaign + messages + audience, frozen
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (campaign_id, version)
);

CREATE TRIGGER campaign_versions_append_only
  BEFORE UPDATE OR DELETE ON campaign_versions
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES campaign_versions(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_messages
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE campaign_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email','sms')),

  -- Ordering is across the whole journey, not per channel, because "the previous
  -- message" in an email -> SMS sequence crosses channels. A per-channel sequence
  -- would make not_opened_previous resolve to the wrong message.
  sequence_order INT NOT NULL,

  -- 'delivery' means "N hours after the order is DELIVERED", which is unknowable at
  -- enrolment time. See core/scheduling/delivery-anchor.ts.
  delay_anchor TEXT NOT NULL DEFAULT 'trigger'
               CHECK (delay_anchor IN ('trigger','previous','delivery')),
  delay_minutes INT NOT NULL DEFAULT 0,

  send_condition TEXT NOT NULL DEFAULT 'always' CHECK (send_condition IN
    ('always','opened_previous','not_opened_previous',
     'clicked_previous','not_clicked_previous','replied','not_replied')),

  subject_template TEXT,
  html_template    TEXT,
  body_template    TEXT NOT NULL,
  preview_text     TEXT,

  node_id     TEXT,                    -- links back to the flow-canvas node
  branch_path TEXT CHECK (branch_path IS NULL OR branch_path IN ('yes','no')),
  is_enabled  BOOLEAN NOT NULL DEFAULT true,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (campaign_id, sequence_order),
  -- The canvas syncs by node_id, so it must be unique where present.
  UNIQUE (campaign_id, node_id),

  CONSTRAINT campaign_messages_delay_nonneg CHECK (delay_minutes >= 0),
  -- An email with no subject is not a sendable email.
  CONSTRAINT campaign_messages_email_has_subject
    CHECK (channel <> 'email' OR (subject_template IS NOT NULL AND length(subject_template) > 0)),
  CONSTRAINT campaign_messages_body_nonempty CHECK (length(body_template) > 0)
);

CREATE INDEX campaign_messages_campaign ON campaign_messages(campaign_id, sequence_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_stop_conditions — cancel a contact's remaining queued messages
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE campaign_stop_conditions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  campaign_id    UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  condition_type TEXT NOT NULL CHECK (condition_type IN
                   ('replied','clicked','order_placed','order_cancelled',
                    'unsubscribed','goal_reached')),
  config         JSONB NOT NULL DEFAULT '{}',
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, condition_type)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_goals — what the campaign is FOR, measured
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE campaign_goals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  metric       TEXT NOT NULL CHECK (metric IN
                 ('open_rate','click_rate','reply_rate','conversion_rate','attributed_revenue')),
  label        TEXT NOT NULL,
  target_value NUMERIC(12,2) NOT NULL,
  unit         TEXT NOT NULL DEFAULT 'percent' CHECK (unit IN ('percent','count','currency')),

  -- NULL until the value is actually measurable. NEVER a placeholder zero.
  -- A zero here is indistinguishable from "measured, and it is zero", and the UI
  -- renders the two differently on purpose.
  measured_value NUMERIC(12,2),
  measured_at    TIMESTAMPTZ,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, metric),
  CONSTRAINT campaign_goals_measured_together
    CHECK ((measured_value IS NULL) = (measured_at IS NULL))
);
