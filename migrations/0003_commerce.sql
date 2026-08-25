-- 0003 — commerce facts: the trigger substrate
--
-- Deliberately minimal. Enough to drive triggers and merge fields, no more.
-- Campaign Engine is not an order management system, and the fastest way to make a
-- portfolio project unfinishable is to let it become one.

CREATE TABLE stores (
  id        UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  code      TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE orders (
  id            UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  store_id      UUID NOT NULL REFERENCES stores(id)    ON DELETE CASCADE,
  contact_id    UUID NOT NULL REFERENCES contacts(id)  ON DELETE CASCADE,

  order_number  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('placed','shipped','delivered','cancelled','refunded')),
  total         NUMERIC(12,2) NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',

  placed_at     TIMESTAMPTZ NOT NULL,
  shipped_at    TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,

  carrier         TEXT,
  tracking_number TEXT,
  items           JSONB NOT NULL DEFAULT '[]',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ─── I13, expressed as one constraint ───────────────────────────────────────
  -- The unique key is (tenant, STORE, order_number) — NOT (tenant, order_number).
  -- Order numbers are unique per store, not globally. Because this constraint is
  -- honest about that, a lookup by order number alone CAN return more than one row,
  -- the type system is forced to model it, and the API returns
  -- {kind:'ambiguous', candidates:[...]} instead of silently taking LIMIT 1.
  -- Picking the most recent match sends one customer's data to a different customer.
  UNIQUE (tenant_id, store_id, order_number),

  CONSTRAINT orders_total_nonneg CHECK (total >= 0),
  -- A delivered order that was never shipped is a data-integrity failure, not a
  -- state the product should be able to reach.
  CONSTRAINT orders_delivery_follows_shipment
    CHECK (delivered_at IS NULL OR shipped_at IS NULL OR delivered_at >= shipped_at),
  CONSTRAINT orders_shipment_follows_placement
    CHECK (shipped_at IS NULL OR shipped_at >= placed_at),
  -- The status column and the timestamp columns must agree with each other.
  CONSTRAINT orders_status_matches_timestamps CHECK (
    (status <> 'delivered' OR delivered_at IS NOT NULL) AND
    (status <> 'shipped'   OR shipped_at   IS NOT NULL) AND
    (status <> 'cancelled' OR cancelled_at IS NOT NULL)
  )
);

CREATE INDEX orders_delivered_at ON orders(tenant_id, delivered_at) WHERE delivered_at IS NOT NULL;
CREATE INDEX orders_contact      ON orders(tenant_id, contact_id, placed_at DESC);
CREATE INDEX orders_number_lookup ON orders(tenant_id, order_number);  -- I13 lookup path
