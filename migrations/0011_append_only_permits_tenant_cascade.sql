-- 0011 — append-only tables must still be deletable WITH their tenant
--
-- THE BUG THIS FIXES, exactly.
--
-- `scripts/seed-demo.ts` begins by removing the demo tenant so a reseed is a reset
-- rather than an accumulation:
--
--     DELETE FROM tenants WHERE name = 'Demo Store (seeded data)'
--
-- Every append-only table references tenants with ON DELETE CASCADE, so that
-- statement asks Postgres to delete their rows too. `refuse_mutation()` then
-- refused the cascade:
--
--     contact_consents is append-only: DELETE is not permitted.
--
-- So re-seeding was impossible. Seeding a VIRGIN database worked — the DELETE
-- matched no tenant, nothing cascaded, no trigger fired — which is why nobody
-- noticed: the first seed of a new database is the only one anybody runs by hand.
-- The nightly `demo-reset` workflow failed every single night, the deployed demo's
-- data was frozen at whatever the first seed produced, and the storefront's
-- campaign — added later — never existed in production at all.
--
-- The deeper problem is that the schema contradicted itself. `ON DELETE CASCADE`
-- is a promise that deleting the parent deletes these rows; the trigger made that
-- promise unkeepable. A tenant could therefore never be deleted by any means at
-- all, which is a GDPR erasure problem long before it is a demo problem.
--
-- THE RULE, NARROWED RATHER THAN WEAKENED.
--
-- The guarantee worth having is "consent history is never rewritten or quietly
-- erased **while it is somebody's history**". That is preserved exactly. What is
-- now permitted is the one case where the rows have no subject left to protect:
-- the owning tenant row is already gone, so the only thing that can be running is
-- the cascade the foreign key already declares.
--
--   UPDATE while the tenant exists  -> refused, as before
--   DELETE while the tenant exists  -> refused, as before
--   either, once the tenant is gone -> permitted; it is the declared cascade
--
-- A table with no `tenant_id` at all — `prompts` — has no cascade to permit and
-- stays refused unconditionally. The lookup is via to_jsonb(OLD) rather than
-- OLD.tenant_id precisely so that this one function can guard both shapes without
-- erroring on the column it does not have.
--
-- UPDATE returns NEW rather than OLD, which matters: `send_decisions.order_id` is
-- ON DELETE SET NULL, so deleting a tenant's orders issues an UPDATE against an
-- append-only table. Returning OLD there would silently keep the old id and leave
-- a dangling reference behind a trigger that reported success.
--
-- TRUNCATE is unaffected, as before: row-level triggers do not fire for it, which
-- is what keeps test teardown working.

CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  owning_tenant UUID;
BEGIN
  owning_tenant := (to_jsonb(OLD) ->> 'tenant_id')::uuid;

  IF owning_tenant IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = owning_tenant) THEN
    -- The tenant is already gone. This can only be the ON DELETE CASCADE, or the
    -- ON DELETE SET NULL, that the foreign keys declare.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    '% is append-only: % is not permitted. Record a new row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
