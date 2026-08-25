-- 0001 — extensions, tenancy, operators, contacts
--
-- Every table in this schema carries tenant_id. Every repository function takes an
-- explicit tenant. There is no hardcoded tenant constant anywhere in this repository,
-- and tests/integration/repository-tenant-scoping.test.ts asserts it.

CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email identity
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- required by the EXCLUDE in 0002

-- ─────────────────────────────────────────────────────────────────────────────
-- tenants
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tenants (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  default_timezone  TEXT NOT NULL DEFAULT 'UTC',

  -- The quiet-hours HARD FLOOR (I5). A campaign may narrow this window.
  -- Nothing in the product may widen it. See core/scheduling/quiet-hours.ts.
  quiet_hours_start TIME NOT NULL DEFAULT '08:00',
  quiet_hours_end   TIME NOT NULL DEFAULT '21:00',

  -- Frequency cap (I10). These columns have real readers; a test asserts that
  -- changing them changes send behaviour, because five cadence columns with no
  -- backend reader is a failure mode this project exists to refuse.
  freq_cap_count    INT NOT NULL DEFAULT 5,
  freq_cap_window   INTERVAL NOT NULL DEFAULT '7 days',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A tenant whose floor is inverted would make every send window unsatisfiable.
  CONSTRAINT tenants_quiet_hours_ordered CHECK (quiet_hours_start < quiet_hours_end),
  CONSTRAINT tenants_freq_cap_positive   CHECK (freq_cap_count > 0),
  -- IANA zone, validated on write by the repository; a CHECK cannot call Intl.
  CONSTRAINT tenants_timezone_nonempty   CHECK (length(default_timezone) > 0)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- users — operators of the product, not message recipients
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         CITEXT NOT NULL,
  password_hash TEXT NOT NULL,                          -- argon2id
  role          TEXT NOT NULL DEFAULT 'operator'
                CHECK (role IN ('owner','operator','viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- contacts — message recipients
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE contacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id    TEXT,                    -- id in the source system, if any
  email          CITEXT,
  phone          TEXT,                    -- E.164 only, normalised on write

  first_name     TEXT,
  last_name      TEXT,

  -- IANA timezone. NULL means "fall back to the tenant default" — and NEVER to
  -- the server's timezone. A server in UTC deciding that 02:00 local is fine is
  -- exactly the bug I5 exists to prevent.
  timezone       TEXT,
  locale         TEXT NOT NULL DEFAULT 'en',

  tags           TEXT[] NOT NULL DEFAULT '{}',
  attributes     JSONB  NOT NULL DEFAULT '{}',

  first_order_at TIMESTAMPTZ,
  last_order_at  TIMESTAMPTZ,
  order_count    INT NOT NULL DEFAULT 0,
  lifetime_value NUMERIC(12,2) NOT NULL DEFAULT 0,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A contact reachable on no channel cannot be a recipient.
  CONSTRAINT contacts_has_an_address CHECK (email IS NOT NULL OR phone IS NOT NULL),
  -- E.164: leading +, country digit 1-9, up to 15 digits total.
  CONSTRAINT contacts_phone_is_e164  CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT contacts_ltv_nonneg     CHECK (lifetime_value >= 0),
  CONSTRAINT contacts_order_count_nonneg CHECK (order_count >= 0)
);

-- Partial uniqueness: two contacts may both have a NULL email, but not the same one.
CREATE UNIQUE INDEX contacts_tenant_email ON contacts(tenant_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX contacts_tenant_phone ON contacts(tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX contacts_tags_gin       ON contacts USING gin(tags);
CREATE INDEX contacts_attributes_gin ON contacts USING gin(attributes jsonb_path_ops);
CREATE INDEX contacts_tenant_created ON contacts(tenant_id, created_at DESC);
