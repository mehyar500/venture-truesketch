// functions/api/sketch.js
// GET /api/sketch?token= — streams the buyer's sketch JPEG from R2.
// The token is the capability: verified against truesketch_orders first.

export async function onRequestGet({ request, env }) {
  const notFound = () =>
    new Response(JSON.stringify({ ok: false, error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  try {
    const db = env.LEADS_DB;
    const r2 = env.TRUESKETCH_R2;
    if (!db || !r2) return notFound();
    const token = new URL(request.url).searchParams.get("token") || "";
    if (token.length < 16) return notFound();

    const order = await db
      .prepare("SELECT sketch_r2_key FROM truesketch_orders WHERE access_token=? AND status='ready'")
      .bind(token)
      .first();
    if (!order || !order.sketch_r2_key) return notFound();

    const obj = await r2.get(order.sketch_r2_key);
    if (!obj) return notFound();
    return new Response(obj.body, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "private, max-age=31536000",
        "content-disposition": 'inline; filename="truesketch-portrait.jpg"',
      },
    });
  } catch (e) {
    console.error("truesketch/sketch failed", e && e.message);
    return notFound();
  }
}
