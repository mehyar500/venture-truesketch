// functions/api/intake.js
// POST /api/intake — collect the buyer's story before checkout.
// multipart/form-data: name, birthdate, email, personality_goals, [selfie]
// Validates, stores the selfie (if any) in R2, writes a truesketch_intakes row,
// and returns {ok:true, intake_id} for the checkout params.

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const MAX_SELFIE = 1024 * 1024; // ~1MB

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function clean(s, max) {
  s = String(s == null ? "" : s).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function selfieExt(file) {
  const t = (file.type || "").toLowerCase();
  if (t === "image/jpeg") return "jpg";
  if (t === "image/png") return "png";
  if (t === "image/webp") return "webp";
  return null;
}

export async function onRequestPost({ request, env }) {
  try {
    const db = env.LEADS_DB;
    const r2 = env.TRUESKETCH_R2;
    if (!db) return json({ ok: false, error: "no_db" }, 503);

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ ok: false, error: "bad_form" }, 400);
    }

    const name = clean(form.get("name"), 100);
    const birthdate = clean(form.get("birthdate"), 20);
    const email = clean(form.get("email"), 200);
    const personality_goals = clean(form.get("personality_goals"), 1000);
    const selfie = form.get("selfie");

    if (!name) return json({ ok: false, error: "missing_name" }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return json({ ok: false, error: "bad_birthdate" }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "bad_email" }, 400);
    if (personality_goals.length < 20) return json({ ok: false, error: "personality_too_short" }, 400);

    const intake_id = crypto.randomUUID();
    let selfie_r2_key = null;

    if (selfie && typeof selfie === "object" && selfie.size > 0) {
      const ext = selfieExt(selfie);
      if (!ext) return json({ ok: false, error: "bad_selfie_type" }, 400);
      if (selfie.size > MAX_SELFIE) return json({ ok: false, error: "selfie_too_large" }, 400);
      if (!r2) return json({ ok: false, error: "no_storage" }, 503);
      selfie_r2_key = `truesketch/intakes/${intake_id}/selfie.${ext}`;
      const bytes = new Uint8Array(await selfie.arrayBuffer());
      await r2.put(selfie_r2_key, bytes, {
        httpMetadata: { contentType: selfie.type || "application/octet-stream" },
      });
    }

    await db
      .prepare(
        `INSERT INTO truesketch_intakes
           (intake_id, name, email, birthdate, personality_goals, selfie_r2_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ${nowSql})`
      )
      .bind(intake_id, name, email, birthdate, personality_goals, selfie_r2_key)
      .run();

    return json({ ok: true, intake_id });
  } catch (e) {
    console.error("truesketch/intake failed", e && e.message);
    return json({ ok: false, error: "intake_failed" }, 500);
  }
}
