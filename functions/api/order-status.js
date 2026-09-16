// functions/api/order-status.js
// GET /api/order-status?token= — live generation status for success.html.
// Verifies the token against truesketch_orders; if no order row exists yet,
// checks billing_payments for a paid row (webhook hasn't called generate yet).

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const db = env.LEADS_DB;
    if (!db) return json({ ok: false, error: "no_db" }, 503);
    const token = new URL(request.url).searchParams.get("token") || "";
    if (token.length < 16) return json({ ok: false, error: "bad_token" }, 400);

    const order = await db
      .prepare("SELECT status, name, email, created_at, fulfilled_at FROM truesketch_orders WHERE access_token=?")
      .bind(token)
      .first();
    if (order) {
      return json({ ok: true, status: order.status, name: order.name, email: order.email });
    }

    // Paid but not yet handed to /api/generate: still "in the pipeline".
    let paid = false;
    try {
      const pay = await db
        .prepare("SELECT id FROM billing_payments WHERE access_token=? AND status='paid'")
        .bind(token)
        .first();
      paid = !!pay;
    } catch {}
    if (paid) return json({ ok: true, status: "paid" });
    return json({ ok: false, error: "unknown_order" }, 404);
  } catch (e) {
    console.error("truesketch/order-status failed", e && e.message);
    return json({ ok: false, error: "status_failed" }, 500);
  }
}
