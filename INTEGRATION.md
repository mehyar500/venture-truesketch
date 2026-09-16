# INTEGRATION.md — TrueSketch ↔ mehyar-web contract

How the centralized mehyar.us checkout/webhook talks to the TrueSketch PWA.

## SKU (D1 `billing_products`, database `mehyar_leads_prod`)
- id: `truesketch-reading` · price: 3700¢ ($37) · fulfillment: `truesketch`
- success_url_template: `https://truesketch.mehyar.us/success.html?token={access_token}`
- cancel_url: `https://truesketch.mehyar.us/#pricing` · allowed_return_hosts: `truesketch.mehyar.us`

## Checkout (frontend → mehyar.us)
`POST https://mehyar.us/api/pay/checkout`
```json
{
  "product_id": "truesketch-reading",
  "email": "buyer@example.com",
  "params": { "intake_id": "<uuid from /api/intake>", "name": "Maya" },
  "success_url": "https://truesketch.mehyar.us/success.html",
  "cancel_url": "https://truesketch.mehyar.us/#pricing"
}
```

## Webhook fulfillment (mehyar-web → TrueSketch)
The `truesketch` fulfillment hook (registered in `fulfillHooks`) must, inside
`waitUntil`, POST to the product backend:

`POST https://truesketch.mehyar.us/api/generate`
- Header: `Authorization: Bearer <TRUESKETCH_GENERATE_SECRET>`
  (secret lives in the mehyar-web env as `TRUESKETCH_GENERATE_SECRET`)
- Body:
```json
{
  "payment_id": 123,
  "access_token": "<billing_payments.access_token>",
  "email": "buyer@example.com",
  "product_id": "truesketch-reading",
  "intake_id": "<uuid or null>"
}
```
  (`intake_id` comes from `metadata_json` — checkout stores `params` flat.)

Responses (always HTTP 200 on the happy/failure paths; 401 only on bad secret,
400 on bad input — **never a 500**):
- `{ok:true, replay:false, status:"ready", gallery_url, sketch_url, ...}` — generated
- `{ok:true, replay:true, status, gallery_url, sketch_url}` — duplicate delivery (idempotent on `payment_id`)
- `{ok:false, error, status:"failed"}` — generation failed; row marked failed

## Buyer email (mehyar-web owns this)
The product backend does **not** send email (no ESP credentials on the Pages
project). The fulfillment hook should email the buyer from `team@mehyar.us`
using the injected `sendEmail`, with the gallery link from the `/api/generate`
response. The success page + gallery are token-gated, so email is the
notification layer, not the delivery layer.

## Buyer surfaces (all token-gated on the billing `access_token`)
- `GET https://truesketch.mehyar.us/api/order-status?token=` →
  `{ok, status: "paid"|"generating"|"ready"|"failed"}` (404 on bogus token)
- `GET https://truesketch.mehyar.us/api/gallery?token=` →
  `{ok, name, reading_html, fulfilled_at}` (404 unless ready)
- `GET https://truesketch.mehyar.us/api/sketch?token=` → the sketch JPEG

## Token unification
`/api/generate` stores the **billing** `access_token` on the order row, so one
token gates `success.html`, `gallery.html`, and the API. No token rewrite on
`billing_payments` is needed.
