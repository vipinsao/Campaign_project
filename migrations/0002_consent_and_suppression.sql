-- 0002 — consent ledger, suppression list, consent pauses  (I6)
--
-- This is the single most important modelling decision in the project.
--
--   Consent is a LEDGER, not a flag.
--
-- A boolean `opted_in` column can answer "are they opted in?" and nothing else.
-- It cannot answer "were they opted in on 4 March, and where did that consent come
-- from?" — which is the question that actually gets asked, by a regulator or by an
-- operator trying to explain a complaint. An UPDATE to a boolean destroys the only
-- evidence that the previous state ever existed.

-- ─────────────────────────────────────────────────────────────────────────────
-- contact_consents — APPEND ONLY, enforced by the database
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE contact_consents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email','sms')),

  -- NULL means "all categories". A row with a category narrows to that category.
  category    TEXT CHECK (category IS NULL OR category IN
                ('lifecycle','promotional','transactional','operational')),

  state       TEXT NOT NULL CHECK (state IN ('opted_in','opted_out')),

  source      TEXT NOT NULL CHECK (source IN
                ('signup','checkout','preference_center','unsubscribe_link',
                 'sms_stop','bounce','complaint','import','operator','api')),

  -- ip, user agent, the message id that carried the link, the raw STOP text.
  -- This is the difference between "they opted out" and "they opted out, here is
  -- the proof, at this second, from this address".
  evidence    JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX consents_lookup
  ON contact_consents(tenant_id, contact_id, channel, occurred_at DESC);

-- "Append-only" as a database guarantee rather than a code review convention.
-- Without this, one well-meaning UPDATE in a data-fix script erases consent history
-- permanently and silently. TRUNCATE still works, so test teardown is unaffected.
CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Record a new row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER contact_consents_append_only
  BEFORE UPDATE OR DELETE ON contact_consents
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- consent_state() — the resolution rule, defined once
-- ─────────────────────────────────────────────────────────────────────────────
-- The build spec left category precedence undefined, and it is load-bearing: a
-- contact can simultaneously hold ('*', opted_out, Tuesday) and
-- ('promotional', opted_in, Wednesday). Three readings were possible; this one is
-- implemented, and docs/DECISIONS.md records why:
--
--   MOST RECENT INTENT WINS, considering wildcard and category-specific rows
--   together as one timeline.
--
-- Rationale: a preference centre that lets someone "drop one category instead of
-- all mail" is only honest if the later, narrower choice actually takes effect.
-- Resolving wildcard-always-wins would make the per-category toggles decorative.
CREATE OR REPLACE FUNCTION consent_state(
  p_tenant   UUID,
  p_contact  UUID,
  p_channel  TEXT,
  p_category TEXT
) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT state
    FROM contact_consents
   WHERE tenant_id  = p_tenant
     AND contact_id = p_contact
     AND channel    = p_channel
     AND (category IS NULL OR category = p_category)
   ORDER BY occurred_at DESC, id DESC     -- id breaks ties within the same instant
   LIMIT 1;
$$;

-- Convenience view for the contact timeline UI. Deliberately NOT the thing the
-- send-time gate reads — the gate calls consent_state() with the campaign's
-- category, because "opted in" is not a global fact.
CREATE VIEW contact_consent_current AS
SELECT DISTINCT ON (tenant_id, contact_id, channel, COALESCE(category, '*'))
       tenant_id,
       contact_id,
       channel,
       COALESCE(category, '*') AS category,
       state,
       source,
       occurred_at
  FROM contact_consents
 ORDER BY tenant_id, contact_id, channel, COALESCE(category, '*'), occurred_at DESC, id DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- suppressions — ADDRESS level, not contact level
-- ─────────────────────────────────────────────────────────────────────────────
-- Suppressing the contact row is not enough. Contacts get merged, re-imported and
-- duplicated, and every one of those operations is a chance to resurrect an address
-- someone asked never to be contacted on again. Suppressing the ADDRESS survives all
-- of it.
--
-- This table is a derived cache with an operational purpose; contact_consents
-- remains the audit trail. A resubscribe deletes from here and appends there.
CREATE TABLE suppressions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('email','sms')),
  address    TEXT NOT NULL,                     -- normalised email or E.164
  reason     TEXT NOT NULL CHECK (reason IN
               ('unsubscribe','sms_stop','hard_bounce','complaint','manual','invalid')),

  -- NULL = permanent. Soft bounces expire; a hard bounce never does.
  -- The send-time gate must ALSO check this, not just the nightly expiry job,
  -- or a suppression outlives its expiry by up to 24 hours.
  expires_at TIMESTAMPTZ,

  evidence   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, channel, address)
);

-- The (tenant_id, channel, address) UNIQUE constraint already serves the send-time
-- lookup. This index serves the nightly expiry job instead.
--
-- Note there is deliberately no `WHERE expires_at > now()` partial index here:
-- now() is STABLE, not IMMUTABLE, so Postgres rejects it in an index predicate.
-- An index cannot encode "currently active" for a time-varying definition of
-- currently — which is precisely why the send-time gate must evaluate expiry
-- itself rather than trusting a filtered index to have done it.
CREATE INDEX suppressions_expiring
  ON suppressions(expires_at) WHERE expires_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- consent_pauses — "pause for 30 days" from the preference centre
-- ─────────────────────────────────────────────────────────────────────────────
-- A pause is a time RANGE, so the correct constraint is a range constraint. Two
-- overlapping pauses for the same contact and channel is not a meaningful state,
-- and an EXCLUDE constraint makes it unrepresentable rather than merely discouraged.
-- This is the kind of rule that application code enforces correctly until the day
-- two requests arrive at once.
CREATE TABLE consent_pauses (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('email','sms')),
  period     TSTZRANGE NOT NULL,
  source     TEXT NOT NULL DEFAULT 'preference_center',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT consent_pauses_no_overlap
    EXCLUDE USING gist (contact_id WITH =, channel WITH =, period WITH &&),
  CONSTRAINT consent_pauses_period_nonempty CHECK (NOT isempty(period))
);

CREATE INDEX consent_pauses_lookup ON consent_pauses USING gist (contact_id, channel, period);
