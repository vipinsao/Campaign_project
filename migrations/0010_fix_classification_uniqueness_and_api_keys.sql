-- 0010 — two corrections, applied forward rather than by editing history
--
-- Migrations here are forward-only and content-hashed: the runner refuses to
-- proceed if a file that has already been applied is edited afterwards, because
-- that silently produces two different schemas from the same migration number.
-- So these are fixes to 0009, not edits of it.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. classifications: the same NULLS-NOT-DISTINCT trap as enrollments
-- ─────────────────────────────────────────────────────────────────────────────
-- `UNIQUE (reply_id, prompt_id)` in 0009 looks like it makes classification
-- idempotent. It does not, and it fails in exactly the worst place.
--
-- A DETERMINISTIC classification has `prompt_id IS NULL` — no model was consulted,
-- so there is no prompt version to name. PostgreSQL treats NULLs as distinct in a
-- unique index by default, so the one path that is guaranteed to be reproducible
-- is the one path with no uniqueness protection at all. Classifying the same reply
-- twice deterministically inserts two rows.
--
-- Worse, working around it in application code means a check-then-insert — the
-- exact pattern I4 bans in the queue, for the exact same reason: between the check
-- and the insert, every concurrent caller passes the check.
--
-- This is the second instance of this trap in the schema. The first was
-- enrollments, caught before it shipped. Recorded in docs/DECISIONS.md as a
-- pattern to grep for rather than a one-off.
ALTER TABLE classifications DROP CONSTRAINT IF EXISTS classifications_reply_id_prompt_id_key;

ALTER TABLE classifications
  ADD CONSTRAINT classifications_one_per_reply_and_prompt
  UNIQUE NULLS NOT DISTINCT (reply_id, prompt_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. api_keys: ingest credentials that can actually be revoked
-- ─────────────────────────────────────────────────────────────────────────────
-- `POST /events` authenticates with an API key. Without a table, the only
-- self-verifying option is an HMAC of the tenant id — which works, carries the
-- tenant, and cannot be forged, but has no revocation and no rotation: the key is
-- a pure function of the tenant, so the only way to invalidate one is to rotate
-- the server secret and break every other tenant at the same time.
--
-- A credential that cannot be revoked is not a credential, it is a permanent
-- grant. Keys are stored as argon2id hashes for the same reason passwords are:
-- a database disclosure must not hand over working credentials.
CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,

  -- The first characters of the key, stored in clear so an operator can identify
  -- which key to revoke from a list without the server ever being able to
  -- reconstruct it.
  key_prefix  TEXT NOT NULL,
  key_hash    TEXT NOT NULL,

  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,

  UNIQUE (tenant_id, label),
  CONSTRAINT api_keys_prefix_shape CHECK (length(key_prefix) BETWEEN 6 AND 16)
);

-- Lookup is by prefix, then a constant-time hash comparison against the candidates.
-- Revoked keys stay in the table: deleting them destroys the audit trail of what
-- was authorised when, which is the question asked after an incident.
CREATE INDEX api_keys_active ON api_keys(key_prefix) WHERE revoked_at IS NULL;
CREATE INDEX api_keys_tenant ON api_keys(tenant_id, created_at DESC);
