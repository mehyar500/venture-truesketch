-- schema.sql — TrueSketch D1 schema + billing catalog seed.
-- Apply to the mehyar_leads_prod D1 (the DB whose LEADS_DB binding the
-- mehyar-web webhook uses — same DB as designful_orders/billing_products).
-- Safe to re-run (IF NOT EXISTS / upserts).

-- ── orders: one row per paid TrueSketch purchase ───────────────────────────
CREATE TABLE IF NOT EXISTS truesketch_orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id       INTEGER NOT NULL,   -- billing_payments.id (UNIQUE: idempotent fulfill)
  access_token     TEXT NOT NULL,      -- buyer capability token (the billing token, stored by /api/generate)
  email            TEXT NOT NULL,
  product_id       TEXT NOT NULL DEFAULT 'truesketch-reading',
  name             TEXT,
  birthdate        TEXT,
  personality_goals TEXT,
  intake_id        TEXT,               -- truesketch_intakes.intake_id (nullable: checkout without intake)
  sketch_r2_key    TEXT,               -- R2 key of the sketch JPEG
  reading          TEXT,               -- rendered reading HTML
  status           TEXT NOT NULL DEFAULT 'generating', -- generating|ready|failed
  created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fulfilled_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ts_orders_payment ON truesketch_orders(payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ts_orders_token ON truesketch_orders(access_token);

-- ── intakes: buyer details captured before checkout ────────────────────────
CREATE TABLE IF NOT EXISTS truesketch_intakes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  intake_id         TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,
  birthdate         TEXT,
  personality_goals TEXT,
  selfie_r2_key     TEXT,              -- optional selfie (style reference only)
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ts_intakes_id ON truesketch_intakes(intake_id);

-- ── billing catalog: the one SKU, fulfillment='truesketch' ─────────────────
INSERT INTO billing_products
  (id, name, brand, price_cents, currency, fulfillment, description,
   success_url_template, cancel_url, allowed_return_hosts, active, digital_file)
VALUES
  ('truesketch-reading', 'TrueSketch Reading', 'truesketch', 3700, 'usd', 'truesketch',
   'A personalized AI portrait sketch plus a 2-page reading about you.',
   'https://truesketch.mehyar.us/success.html?token={access_token}',
   'https://truesketch.mehyar.us/#pricing', 'truesketch.mehyar.us', 1, NULL)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name, price_cents=excluded.price_cents, fulfillment=excluded.fulfillment,
  description=excluded.description, success_url_template=excluded.success_url_template,
  cancel_url=excluded.cancel_url, allowed_return_hosts=excluded.allowed_return_hosts,
  active=excluded.active;
