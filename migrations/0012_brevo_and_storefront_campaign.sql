-- 0012 — Brevo as a provider, and the campaign the public storefront may send
--
-- ── 1. 'brevo' joins the provider set ────────────────────────────────────────
--
-- `packages/providers/src/registry.ts` keeps PROVIDER_NAMES equal to this CHECK on
-- purpose: a provider the schema does not know about would write rows nothing can
-- classify. Brevo's HTTPS adapter exists because Render's free tier blocks
-- outbound SMTP, so the SMTP adapter cannot reach Brevo from there.
ALTER TABLE provider_credentials DROP CONSTRAINT provider_credentials_provider_check;
ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_provider_check
  CHECK (provider IN ('smtp','postmark','brevo','twilio','mock'));

-- ── 2. campaigns.is_storefront ───────────────────────────────────────────────
--
-- THE PROBLEM. The public demo opens the operator console without a login, so
-- anybody can create and edit campaigns. The public storefront hands real
-- addresses to a real email provider inside the checkout request. Put together,
-- without this column:
--
--   1. open the console, create an active `order_placed` campaign whose body is
--      an advert, or rewrite the body of "Order confirmation";
--   2. place an order on /shop with a stranger's address;
--   3. the checkout flushes every row the order enqueued, and the operator's own
--      sending account delivers the advert to the stranger.
--
-- That is an open relay with two extra clicks, and a free email account caught
-- relaying is suspended — which takes the demo down for good.
--
-- THE RULE. Exactly one campaign per tenant may be marked as the storefront's.
-- The checkout flushes only that campaign's rows (anything else the order
-- enqueued stays in the queue for the worker, which the public deployment runs in
-- mock mode), and the API refuses to edit, pause or delete it. Operators who want
-- to experiment duplicate it; the copy is an ordinary campaign.
--
-- The flag is not settable through the API at all. It is written by the seed, and
-- by the backfill below for a database seeded before this column existed.
ALTER TABLE campaigns ADD COLUMN is_storefront BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX campaigns_one_storefront_per_tenant
  ON campaigns (tenant_id) WHERE is_storefront;

-- Backfill: the seed's storefront campaign, in a database seeded before 0012. The
-- earliest-created match wins so a later copy with the same name is never chosen.
UPDATE campaigns c
   SET is_storefront = true
 WHERE c.id IN (
   SELECT DISTINCT ON (tenant_id) id
     FROM campaigns
    WHERE name = 'Order confirmation'
      AND trigger_type = 'order_placed'
      AND category = 'transactional'
    ORDER BY tenant_id, created_at, id
 );
