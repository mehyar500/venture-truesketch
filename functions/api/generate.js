// functions/api/generate.js
// POST /api/generate — build the paid TrueSketch deliverable (sketch + reading).
//
// Called by the mehyar-web webhook fulfillment hook (inside waitUntil).
// Auth: Authorization: Bearer <TRUESKETCH_GENERATE_SECRET>.
// Body: { payment_id, access_token, email, product_id, intake_id? }
//
// Flow:
//   1. auth + validate (401/400 JSON — never a 500 to the webhook)
//   2. idempotency: INSERT order row with status='generating' (payment_id is
//      UNIQUE); on conflict, return the existing row as {replay:true}
//   3. flux-1-schnell sketch (text-free prompt; optional selfie folded in via
//      a single vision description — never a likeness promise)
//   4. vision QC gate, auto-regenerate up to MAX_QC_RETRIES
//   5. llama-3.3-70b 2-page reading (warm, fun, entertaining)
//   6. sketch -> R2, order row -> ready, return deliverable URLs
//
// On ANY failure: the row is marked failed and we return
// {ok:false, error, status:'failed'} with HTTP 200 — never a 500, so the
// webhook never retries blindly. The buyer's success page shows live status.

import { runText, runTextJson, runImage, runVision, parseJson, MODELS } from "./_lib/ai.js";

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const MAX_QC_RETRIES = 3;

const ZERO_TEXT_SUFFIX =
  " CRITICAL: the image must contain absolutely no text, letters, numbers, " +
  "words, labels, signs, signatures, initials, monograms, or watermark-like " +
  "shapes anywhere. The artwork must be completely UNSIGNED — no artist " +
  "signature in any corner or edge. Pure imagery only.";

const QC_VISION_PROMPT = [
  "You are a quality-control inspector for AI-generated portrait art.",
  "Look at this image carefully and answer in JSON ONLY:",
  '{"has_text": true|false, "visible_text": "<any text/letters/words you can see, or empty>",',
  ' "is_portrait_sketch": true|false, "notes": "<one short sentence>"}',
  "Rules: has_text is true if ANY letter, word, number, sign, or gibberish",
  "mark appears anywhere, even tiny. is_portrait_sketch is true only if the",
  "image looks like a hand-drawn pencil/charcoal portrait of a person.",
].join(" ");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clean(s, max) {
  s = String(s == null ? "" : s).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function orderUrls(env, token) {
  const base = (env.TRUESKETCH_BASE_URL || "https://truesketch.mehyar.us").replace(/\/$/, "");
  return {
    gallery_url: `${base}/gallery.html?token=${encodeURIComponent(token)}`,
    sketch_url: `${base}/api/sketch?token=${encodeURIComponent(token)}`,
  };
}

// ── auth: timing-safe bearer compare ───────────────────────────────────────
// Plain `!==` leaks secret length/order through timing; the fixed-length
// random generate secret deserves a constant-time check.
async function bearerMatches(auth, secret) {
  const prefix = "Bearer ";
  if (typeof auth !== "string" || !auth.startsWith(prefix)) return false;
  const a = new TextEncoder().encode(auth.slice(prefix.length));
  const b = new TextEncoder().encode(secret);
  if (a.length !== b.length) return false;
  try {
    return crypto.subtle.timingSafeEqual(a, b);
  } catch {
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }
}

function orderPayload(env, order) {
  const urls = orderUrls(env, order.access_token);
  return {
    ok: true,
    replay: true,
    status: order.status,
    payment_id: order.payment_id,
    email: order.email,
    name: order.name,
    gallery_url: urls.gallery_url,
    sketch_url: urls.sketch_url,
  };
}

// ── vision QC ──────────────────────────────────────────────────────────────

function parseQCVerdict(raw) {
  const d = parseJson(String(raw || ""));
  if (d && typeof d === "object") {
    let hasText = d.has_text === true;
    const visText = String(d.visible_text || "").trim();
    // Guard against self-contradictory model output (observed: has_text=true
    // with visible_text="No text visible" or "None"). If the model cannot point
    // to any actual transcribable characters, there is nothing to reject.
    if (hasText && (!visText || /^(no|none|n\/a|nothing)\b/i.test(visText))) {
      hasText = false;
    }
    const isSketch = d.is_portrait_sketch !== false;
    return {
      clean: !hasText && isSketch,
      has_text: hasText,
      visible_text: visText.slice(0, 200),
      is_portrait_sketch: isSketch,
      notes: String(d.notes || "").slice(0, 200),
    };
  }
  // Fallback: keyword heuristics on the raw text.
  const t = String(raw || "").toLowerCase();
  const bad = /gibberish|fake|distorted text|unreadable|letters|words? (visible|appear)/.test(t);
  return { clean: !bad, has_text: bad, visible_text: "", is_portrait_sketch: true, notes: raw.slice(0, 200) };
}

async function qcSketch(env, dataUri) {
  const raw = await runVision(env, dataUri, QC_VISION_PROMPT, { max_tokens: 1024 });
  return parseQCVerdict(raw);
}

function isTransientImageError(e) {
  return /8007|nsfw/i.test(String((e && e.message) || e));
}

async function runImageTransient(env, prompt, label) {
  let last = null;
  for (let i = 1; i <= 3; i++) {
    try {
      return await runImage(env, prompt, {});
    } catch (e) {
      last = e;
      if (!isTransientImageError(e) || i === 3) throw e;
      console.error(`truesketch/flux ${label}: transient error, retry ${i}/3`, String(e.message).slice(0, 120));
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw last;
}

async function generateSketch(env, fluxPrompt, label) {
  // width/height are NOT sent to flux (it always returns 1024x1024); the
  // zero-text rule is appended server-side on every attempt.
  let last = null;
  for (let attempt = 1; attempt <= 1 + MAX_QC_RETRIES; attempt++) {
    const prompt = fluxPrompt.includes("no text") ? fluxPrompt : fluxPrompt + ZERO_TEXT_SUFFIX;
    const { base64, mime, ext } = await runImageTransient(env, prompt, label);
    const dataUri = `data:${mime};base64,${base64}`;
    const verdict = await qcSketch(env, dataUri);
    last = { base64, mime, ext, attempts: attempt, qc: verdict };
    if (verdict.clean) return { ...last, ok: true };
    console.error(`truesketch/qc ${label}: attempt ${attempt} failed`, verdict.notes);
  }
  return { ...last, ok: false };
}

// ── prompt builders ────────────────────────────────────────────────────────

async function describeSelfie(env, r2, selfieKey) {
  if (!selfieKey || !r2) return "";
  try {
    const obj = await r2.get(selfieKey);
    if (!obj) return "";
    const buf = await obj.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    const ctype = (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg";
    const desc = await runVision(
      env,
      `data:${ctype};base64,${b64}`,
      "Describe ONLY artistic, non-identifying style cues visible in this photo for a sketch artist: " +
        "hair (length, texture, style), general age impression (young/adult/older), any striking features " +
        "like a beard or glasses, and the overall vibe. Two short sentences. Do NOT identify the person.",
      { max_tokens: 300 }
    );
    return clean(desc, 400);
  } catch (e) {
    console.error("truesketch/selfie describe failed", e && e.message);
    return "";
  }
}

function buildFluxPrompt({ selfieDesc }) {
  // Style-only prompt. Personality text is EXCLUDED — raw words ("builder")
  // become literal objects (hard hats) or rendered text. Personalization lives
  // in the reading (text); the sketch is a beautiful mystical portrait.
  // "Pencil sketch" (not "illustration") avoids the TM-watermark prior.
  let p = "Mystical pencil sketch portrait, graphite on deep indigo paper, " +
    "expressive linework, soft shading, head and shoulders, artistic, elegant. ";
  if (selfieDesc) p += "Style inspiration: " + selfieDesc.slice(0, 150) + ". ";
  p += "No text, no words, no letters, no numbers, no signature, no initials, " +
    "no watermark, no trademark symbols, no logos, no captions.";
  return p;
}

const READING_SYSTEM = [
  "You write warm, playful, insightful 2-page personal readings for an entertainment product called TrueSketch.",
  "Voice: a kind, witty friend who sees people clearly — vivid, specific, never generic horoscope fluff.",
  "Rules:",
  "- Write ONLY about what the buyer told us (name, birthdate, their own words). Never invent facts about their life.",
  "- No medical, legal, or financial advice. No predictions presented as certainty — frame the future as momentum and possibility.",
  "- Ban unprovable superlatives: never say only/best/#1/first ever about the buyer or the product.",
  "- End with the exact disclaimer sentence: 'For entertainment purposes only — a mirror, not a map.'",
  "- Reply with ONLY the JSON object, no prose, no fences.",
].join("\n");

function readingValidate(d) {
  if (!d || typeof d.title !== "string" || !d.title.trim()) return "missing title";
  if (!Array.isArray(d.sections) || d.sections.length < 3) return "need >=3 sections";
  for (const s of d.sections) {
    if (typeof s.heading !== "string" || typeof s.body !== "string") return "bad section shape";
    if (s.body.trim().length < 120) return "section body too short";
  }
  if (typeof d.closing !== "string" || d.closing.trim().length < 20) return "missing closing";
  return true;
}

async function generateReading(env, intake) {
  const user = [
    `Name: ${intake.name || "friend"}`,
    intake.birthdate ? `Birthdate: ${intake.birthdate}` : "",
    `In their own words: ${intake.personality_goals || ""}`,
    intake.selfieDesc ? `Sketch style cues: ${intake.selfieDesc}` : "",
    "",
    "Write the reading as JSON: {\"title\": \"<evocative 2-4 word title>\",",
    " \"sections\": [{\"heading\": \"<short>\", \"body\": \"<2-4 paragraphs of warm, specific prose>\"} x4],",
    " \"closing\": \"<one warm send-off paragraph>\"}.",
    "Sections should cover: who they are at their core, their pattern/strength,",
    "their current momentum, and one gentle nudge about what's ahead.",
  ].filter(Boolean).join("\n");
  const { parsed } = await runTextJson(
    env,
    MODELS.text,
    [
      { role: "system", content: READING_SYSTEM },
      { role: "user", content: user },
    ],
    { max_tokens: 3500, temperature: 0.8, retries: 2, label: "reading", validate: readingValidate }
  );
  return parsed;
}

function renderReadingHtml(reading) {
  const sections = (reading.sections || [])
    .map(
      (s) =>
        `<h3>${esc(s.heading)}</h3>` +
        esc(s.body)
          .split(/\n{2,}|\r\n\r\n/)
          .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
          .join("")
    )
    .join("");
  return (
    `<h2>${esc(reading.title)}</h2>` +
    sections +
    `<p><em>${esc(reading.closing)}</em></p>` +
    `<p style="font-size:13px;color:#a99fc4;font-family:var(--font)">For entertainment purposes only — a mirror, not a map.</p>`
  );
}

// ── main handler ───────────────────────────────────────────────────────────

export async function onRequestPost({ request, env }) {
  // orderId/db are hoisted so the outer catch can mark the row failed — the
  // webhook always gets HTTP 200 on failure paths, never a 500.
  let orderId = null;
  let db = null;
  const markFailed = async () => {
    try {
      if (db && orderId) {
        await db
          .prepare(`UPDATE truesketch_orders SET status='failed' WHERE id=?`)
          .bind(orderId)
          .run();
      }
    } catch {}
  };
  const fail = async (error, httpStatus = 200, details = null) => {
    await markFailed();
    const out = { ok: false, error, status: "failed" };
    if (details && typeof details === "object") out.details = details;
    return json(out, httpStatus);
  };

  try {
    // ── auth (timing-safe bearer compare) ──
    const secret = env.TRUESKETCH_GENERATE_SECRET;
    const auth = request.headers.get("authorization") || "";
    if (!secret || !(await bearerMatches(auth, secret))) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    db = env.LEADS_DB;
    const r2 = env.TRUESKETCH_R2;
    if (!db) return fail("no_db");
    if (!r2) return fail("no_storage");

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "bad_json" }, 400);
    }
    const payment_id = Number(body && body.payment_id);
    const access_token = clean(body && body.access_token, 200);
    const email = clean(body && body.email, 200);
    const product_id = clean(body && body.product_id, 100) || "truesketch-reading";
    const intake_id = clean(body && body.intake_id, 100);

    if (!Number.isFinite(payment_id) || payment_id <= 0) return json({ ok: false, error: "bad_payment_id" }, 400);
    if (access_token.length < 16) return json({ ok: false, error: "bad_token" }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "bad_email" }, 400);

    // ── idempotency: one row per payment. INSERT first (status=generating);
    // a UNIQUE conflict means this payment was already seen → replay.
    try {
      const ins = await db
        .prepare(
          `INSERT INTO truesketch_orders
             (payment_id, access_token, email, product_id, intake_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'generating', ${nowSql})`
        )
        .bind(payment_id, access_token, email, product_id, intake_id || null)
        .run();
      orderId = Number(ins.meta.last_row_id);
    } catch (e) {
      const existing = await db
        .prepare("SELECT * FROM truesketch_orders WHERE payment_id=?")
        .bind(payment_id)
        .first();
      if (existing) return json(orderPayload(env, existing));
      throw e;
    }

    // ── load intake (best effort) ──
    let intake = { name: "", birthdate: "", personality_goals: "", selfie_r2_key: null, selfieDesc: "" };
    if (intake_id) {
      try {
        const row = await db
          .prepare("SELECT * FROM truesketch_intakes WHERE intake_id=?")
          .bind(intake_id)
          .first();
        if (row) {
          intake = {
            name: clean(row.name, 100),
            birthdate: clean(row.birthdate, 20),
            personality_goals: clean(row.personality_goals, 1000),
            selfie_r2_key: row.selfie_r2_key,
            selfieDesc: "",
          };
        }
      } catch (e) {
        console.error("truesketch/intake lookup failed", e && e.message);
      }
    }

    // ── sketch ──
    intake.selfieDesc = await describeSelfie(env, r2, intake.selfie_r2_key);
    const fluxPrompt = buildFluxPrompt(intake);
    const art = await generateSketch(env, fluxPrompt, `payment:${payment_id}`);
    if (!art.ok) {
      console.error("truesketch/sketch QC exhausted", art.qc && art.qc.notes);
      try {
        if (r2 && art.base64) {
          const dbgBytes = Uint8Array.from(atob(art.base64), (c) => c.charCodeAt(0));
          await r2.put(`truesketch/debug/qc-fail-${payment_id}.jpg`, dbgBytes, {
            httpMetadata: { contentType: "image/jpeg" },
          });
        }
      } catch {}
      return fail("image_qc_failed", 200, { qc: art.qc || null, attempts: art.attempts || 0 });
    }
    const sketchBytes = Uint8Array.from(atob(art.base64), (c) => c.charCodeAt(0));
    const sketchKey = `truesketch/${access_token}/sketch.jpg`;
    await r2.put(sketchKey, sketchBytes, { httpMetadata: { contentType: "image/jpeg" } });

    // ── reading ──
    let reading;
    try {
      reading = await generateReading(env, intake);
    } catch (e) {
      console.error("truesketch/reading failed", e && e.message);
      return fail("reading_failed");
    }
    const readingHtml = renderReadingHtml(reading);
    const displayName = intake.name || email.split("@")[0];

    await db
      .prepare(
        `UPDATE truesketch_orders
           SET name=?, birthdate=?, personality_goals=?, sketch_r2_key=?,
               reading=?, status='ready', fulfilled_at=${nowSql}
         WHERE id=?`
      )
      .bind(displayName, intake.birthdate, intake.personality_goals, sketchKey, readingHtml, orderId)
      .run();

    const urls = orderUrls(env, access_token);
    return json({
      ok: true,
      replay: false,
      status: "ready",
      payment_id,
      email,
      name: displayName,
      qc_attempts: art.attempts,
      gallery_url: urls.gallery_url,
      sketch_url: urls.sketch_url,
    });
  } catch (e) {
    const msg = String((e && e.message) || e || "unknown").slice(0, 300);
    console.error("truesketch/generate failed", msg);
    return fail("generate_failed", 200, { detail: msg });
  }
}
