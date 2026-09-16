# TrueSketch — personalized AI sketch + reading
https://truesketch.mehyar.us · $37 one-time

## Flow
`intake.html` (name, birthdate, email, personality, optional selfie -> POST /api/intake)
→ Stripe checkout via centralized https://mehyar.us/api/pay/checkout (`truesketch-reading`)
→ webhook fulfillment POSTs `/api/generate` (Bearer TRUESKETCH_GENERATE_SECRET)
→ flux sketch (vision-QC'd) + llama-3.3-70b 2-page reading → R2 + D1
→ `success.html?token=` polls `/api/order-status` → `gallery.html?token=` gated deliverable

## Local structure
- `index.html` landing · `teaser.html` free preview · `intake.html` form+checkout
- `success.html` polling status · `gallery.html` token-gated deliverable
- `functions/api/intake.js` · `generate.js` · `order-status.js` · `gallery.js` · `sketch.js`
- `functions/api/_lib/ai.js` — Workers AI helpers (adapted from Designful's proven lib)

## Deploy
Push to `main` → GitHub Actions (`.github/workflows/deploy.yml`) runs
`wrangler pages deploy` with the `CLOUDFLARE_API_TOKEN` repo secret.
Env vars/bindings are managed via the Cloudflare API (never committed).

## D1 (mehyar_leads_prod)
Tables: `truesketch_orders` (payment_id UNIQUE — idempotent fulfill),
`truesketch_intakes`. SKU `truesketch-reading` in `billing_products`.
