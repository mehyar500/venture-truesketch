// functions/api/gallery.js
// GET /api/gallery?token= — token-gated deliverable for gallery.html.
// Verifies the token against truesketch_orders (must be status='ready').

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
    if (token.length < 16) return json({ ok: false, error: "bad_token" }, 403);

    const order = await db
      .prepare(
        "SELECT name, reading, fulfilled_at FROM truesketch_orders WHERE access_token=? AND status='ready'"
      )
      .bind(token)
      .first();
    if (!order) return json({ ok: false, error: "not_found" }, 404);

    return json({
      ok: true,
      name: order.name || "",
      reading_html: order.reading || "",
      fulfilled_at: order.fulfilled_at,
    });
  } catch (e) {
    console.error("truesketch/gallery failed", e && e.message);
    return json({ ok: false, error: "gallery_failed" }, 500);
  }
}
