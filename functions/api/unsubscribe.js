// functions/api/unsubscribe.js
// GET /api/unsubscribe — one-click unsubscribe, honored in BOTH tables.
//   ?email=a@b.com        — direct one-click (from the on-site form)
//   ?token=<signed>       — one-click from an email link. token format:
//                           base64url(email) + "." + hex(HMAC_SHA256(email, secret))
//
// Sets status='unsubscribed' in truesketch_subscribers (plus unsubscribed_at)
// and in subscribers_global WHERE brand='truesketch'.
// Browser hits get a friendly redirect to /unsubscribe.html?done=1;
// API clients get JSON.

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

function hexOf(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyToken(token, secret) {
  try {
    const dot = token.indexOf(".");
    if (dot < 1) return null;
    const email = b64urlDecode(token.slice(0, dot)).trim().toLowerCase();
    const sig = token.slice(dot + 1);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email));
    const expect = hexOf(mac);
    if (expect.length !== sig.length) return null;
    let d = 0;
    for (let i = 0; i < expect.length; i++) d |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
    return d === 0 ? email : null;
  } catch {
    return null;
  }
}

export async function onRequestGet({ request, env }) {
  const db = env.LEADS_DB;
  if (!db) return json({ ok: false, error: "no_db" }, 503);

  const url = new URL(request.url);
  const emailParam = (url.searchParams.get("email") || "").trim().toLowerCase();
  const tokenParam = url.searchParams.get("token") || "";
  const wantsHtml = (request.headers.get("accept") || "").includes("text/html");

  let email = null;
  if (tokenParam) {
    const secret = env.TRUESKETCH_GENERATE_SECRET || env.UNSUB_SECRET || "truesketch-unsub";
    email = await verifyToken(tokenParam, secret);
    if (!email) {
      if (wantsHtml) return Response.redirect(new URL("/unsubscribe.html?err=badtoken", url).toString(), 302);
      return json({ ok: false, error: "bad_token" }, 400);
    }
  } else if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailParam)) {
    email = emailParam;
  } else {
    if (wantsHtml) return Response.redirect(new URL("/unsubscribe.html", url).toString(), 302);
    return json({ ok: false, error: "missing_email" }, 400);
  }

  try {
    await db
      .prepare(
        `UPDATE truesketch_subscribers
         SET status='unsubscribed', unsubscribed_at=${NOW}
         WHERE email=?`
      )
      .bind(email)
      .run();
    await db
      .prepare(
        `UPDATE subscribers_global
         SET status='unsubscribed', updated_at=${NOW}
         WHERE email=? AND brand='truesketch'`
      )
      .bind(email)
      .run();
  } catch (e) {
    console.error("truesketch/unsubscribe failed", e && e.message);
    return json({ ok: false, error: "store_failed" }, 502);
  }

  console.log(`truesketch/unsubscribed ${email}`);
  if (wantsHtml) return Response.redirect(new URL("/unsubscribe.html?done=1", url).toString(), 302);
  return json({ ok: true, email });
}
