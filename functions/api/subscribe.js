// functions/api/subscribe.js
// POST /api/subscribe — opt-in email capture for TrueSketch.
// Body: { email, source? }
//
// Writes to BOTH tables, sequentially:
//   1. truesketch_subscribers (brand list)
//   2. subscribers_global      (brand='truesketch')
// Both must succeed; if either fails the request reports the failure.
// Resubscribing a previously-unsubscribed address flips status back to
// 'subscribed' (and clears unsubscribed_at on the brand table).

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function clean(s, max) {
  s = String(s == null ? "" : s).trim().toLowerCase();
  return s.length > max ? s.slice(0, max) : s;
}

export async function onRequestPost({ request, env }) {
  const db = env.LEADS_DB;
  if (!db) return json({ ok: false, error: "no_db" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  const email = clean(body && body.email, 200);
  const source = clean(body && body.source, 60) || "free-tier";
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "invalid_email" }, 400);

  // ── 1. brand table ──
  try {
    await db
      .prepare(
        `INSERT INTO truesketch_subscribers (email, status, created_at, unsubscribed_at)
         VALUES (?, 'subscribed', ${NOW}, NULL)
         ON CONFLICT(email) DO UPDATE SET
           status='subscribed', unsubscribed_at=NULL`
      )
      .bind(email)
      .run();
  } catch (e) {
    console.error("truesketch/subscribe brand insert failed", e && e.message);
    return json({ ok: false, error: "brand_store_failed" }, 502);
  }

  // ── 2. global table (brand='truesketch') ──
  try {
    await db
      .prepare(
        `INSERT INTO subscribers_global (email, brand, status, created_at, updated_at)
         VALUES (?, 'truesketch', 'subscribed', ${NOW}, ${NOW})
         ON CONFLICT(email, brand) DO UPDATE SET
           status='subscribed', updated_at=${NOW}`
      )
      .bind(email)
      .run();
  } catch (e) {
    console.error("truesketch/subscribe global insert failed", e && e.message);
    // Brand write already landed; be honest about the partial failure.
    return json({ ok: false, error: "global_store_failed" }, 502);
  }

  console.log(`truesketch/subscribed ${email} via ${source}`);
  return json({ ok: true, email });
}
