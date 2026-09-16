// functions/api/free-generate.js
// POST /api/free-generate — the IP-restricted free tier.
// Body: { name, birthdate?, personality }
//
// Rules:
//   - Exactly ONE free generation per IP. The IP is claimed (INSERT) BEFORE
//     generation so concurrent double-submits can't both run.
//   - Output is deliberately partial: a watermarked sketch + a short
//     reading excerpt (2 paragraphs). The full $37 reading is the upgrade.
//   - The sketch goes through the SAME vision-QC gate as the paid path
//     (text-free check, up to 3 regenerations) BEFORE the SAMPLE watermark
//     is baked in server-side.
//   - The delivered `sketch` is an SVG data URI: the QC-passed JPEG embedded
//     with a vector "SAMPLE" overlay baked into the asset itself (no CSS-only
//     protection — the raw API response carries the watermark too).
//   - No auth, no payment, no email required.
//   - cf-connecting-ip is the only IP source (set by Cloudflare; not spoofable).
//
// On a second attempt from the same IP: HTTP 403 {ok:false, blocked:true}.

import { runText, runImage, runVision, parseJson, MODELS } from "./_lib/ai.js";

const MAX_QC_RETRIES = 3;

const ZERO_TEXT_SUFFIX =
  " CRITICAL: the image must contain absolutely no text, letters, numbers, " +
  "words, labels, signs, signatures, initials, monograms, or watermark-like " +
  "shapes anywhere. The artwork must be completely UNSIGNED. Pure imagery only.";

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

function clean(s, max) {
  s = String(s == null ? "" : s).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function blocked() {
  return json(
    {
      ok: false,
      blocked: true,
      error: "already_used",
      message: "You've already used your free sketch. Get the full portrait + 2-page reading for $37.",
    },
    403
  );
}

function buildFreeFluxPrompt({ personality }) {
  const mood = (personality || "").slice(0, 200).replace(/[\r\n]+/g, " ");
  let p =
    "Pencil sketch portrait, graphite drawing on textured indigo paper, " +
    "head and shoulders, expressive linework, soft shading, " +
    "subtle gold celestial accents, artistic and mystical. ";
  if (mood) p += "Mood: " + mood + ". ";
  p += "Absolutely no text, no words, no letters, no numbers, no signature, " +
    "no watermark, no captions anywhere in the image." + ZERO_TEXT_SUFFIX;
  return p;
}

// ── vision QC (same gate as the paid path) ───────────────────────────────

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
  const t = String(raw || "").toLowerCase();
  const bad = /gibberish|fake|distorted text|unreadable|letters|words? (visible|appear)/.test(t);
  return { clean: !bad, has_text: bad, visible_text: "", is_portrait_sketch: true, notes: String(raw || "").slice(0, 200) };
}

async function qcSketch(env, dataUri) {
  const raw = await runVision(env, dataUri, QC_VISION_PROMPT, { max_tokens: 1024 });
  return parseQCVerdict(raw);
}

async function generateQCPassedSketch(env, fluxPrompt) {
  let last = null;
  for (let attempt = 1; attempt <= 1 + MAX_QC_RETRIES; attempt++) {
    const { base64, mime } = await runImage(env, fluxPrompt, {});
    const dataUri = `data:${mime};base64,${base64}`;
    const verdict = await qcSketch(env, dataUri);
    last = { base64, mime, attempts: attempt, qc: verdict };
    if (verdict.clean) return { ...last, ok: true };
    console.error(`truesketch/free-qc: attempt ${attempt} failed`, verdict.notes);
  }
  return { ...last, ok: false };
}

// ── server-side SAMPLE watermark ─────────────────────────────────────────
// The QC-passed JPEG is embedded in an SVG with a vector "SAMPLE" overlay
// baked into the delivered asset. Pure string work — no pixel decode, so no
// Workers CPU risk. Dimensions come from the JPEG SOF marker (Flux returns
// 1024x1024; the parser falls back to that).

function jpegDimensions(base64) {
  try {
    const bin = atob(base64.slice(0, 4096));
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xda) break; // SOS: image data follows
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
  } catch {}
  return null;
}

function watermarkedSvg(base64, mime) {
  const dims = jpegDimensions(base64) || { w: 1024, h: 1024 };
  const W = dims.w, H = dims.h;
  const fs = Math.round(W / 7);
  const cx = W / 2, cy = H / 2;
  const rows = [0.22, 0.5, 0.78].map((f) => Math.round(H * f));
  const texts = rows.map((y) => `      <text x="${cx}" y="${y}">SAMPLE</text>`).join("\n");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `  <image xlink:href="data:${mime};base64,${base64}" href="data:${mime};base64,${base64}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>\n` +
    `  <g font-family="Arial, Helvetica, sans-serif" font-size="${fs}" font-weight="bold" text-anchor="middle" fill="#ffffff" fill-opacity="0.55" stroke="#0a0a18" stroke-opacity="0.35" stroke-width="1">\n` +
    `    <g transform="rotate(-30 ${cx} ${cy})">\n${texts}\n    </g>\n` +
    `  </g>\n` +
    `  <g font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(W / 22)}" font-weight="bold" text-anchor="middle">\n` +
    `    <rect x="${cx - W * 0.16}" y="${Math.round(H * 0.035)}" width="${W * 0.32}" height="${Math.round(H * 0.075)}" rx="${Math.round(H * 0.02)}" fill="#0a0a18" fill-opacity="0.72"/>\n` +
    `    <text x="${cx}" y="${Math.round(H * 0.035 + H * 0.058)}" fill="#ffd97a" fill-opacity="0.95" stroke="none">SAMPLE</text>\n` +
    `  </g>\n` +
    `</svg>`;
  // SVG is strict ASCII by construction (base64 + numeric attrs only); btoa is safe.
  return "data:image/svg+xml;base64," + btoa(svg);
}

const FREE_READING_SYSTEM = [
  "You write the OPENING of a warm, playful personal reading for an entertainment",
  "product called TrueSketch. Voice: a kind, witty friend who sees people clearly —",
  "vivid, specific, never generic horoscope fluff.",
  "Rules:",
  "- Write ONLY about what the user told us. Never invent facts about their life.",
  "- No medical, legal, or financial advice. No predictions stated as certainty.",
  "- Ban unprovable superlatives: never say only/best/#1/first ever.",
  "- This is a TEASER: write exactly 2 short paragraphs (2-4 sentences each) plus",
  "  a 2-4 word title. End on a hook that makes them curious for more — do NOT",
  "  wrap up or conclude.",
  "- Reply with ONLY the JSON object: {\"title\": \"<evocative title>\",",
  "  \"paragraphs\": [\"<paragraph 1>\", \"<paragraph 2>\"]}. No prose, no fences.",
].join("\n");

function freeReadingValidate(d) {
  if (!d || typeof d.title !== "string" || !d.title.trim()) return "missing title";
  if (!Array.isArray(d.paragraphs) || d.paragraphs.length < 2) return "need 2 paragraphs";
  for (const p of d.paragraphs) {
    if (typeof p !== "string" || p.trim().length < 40) return "paragraph too short";
  }
  return true;
}

async function generateFreeReading(env, { name, birthdate, personality }) {
  const user = [
    `Name: ${name || "friend"}`,
    birthdate ? `Birthdate: ${birthdate}` : "",
    `In their own words: ${personality || ""}`,
  ].filter(Boolean).join("\n");
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await runText(
      env,
      MODELS.text,
      [
        { role: "system", content: FREE_READING_SYSTEM },
        { role: "user", content: user + (attempt ? "\nReply with ONLY the corrected JSON object." : "") },
      ],
      { max_tokens: 700, temperature: 0.85, jsonMode: true }
    );
    const d = parseJson(raw);
    if (freeReadingValidate(d) === true) return d;
  }
  // Last-resort fallback so the free tier never hard-fails on prose.
  return {
    title: `The ${name || "Friend"} Sketch`,
    paragraphs: [
      `${name || "Friend"}, there's a steadiness in the way you describe yourself — the kind people lean on without quite saying so. The sketch picks that up first: the set of the shoulders, the calm in the linework.`,
      `Your pattern is quieter than you think, and stronger than you give it credit for. What the full reading would show you next is where that pattern is quietly carrying you — and the one blind spot riding along with it…`,
    ],
  };
}

export async function onRequestPost({ request, env }) {
  const db = env.LEADS_DB;
  if (!db || !env.AI) return json({ ok: false, error: "unavailable" }, 503);

  const ip = request.headers.get("cf-connecting-ip") || "";
  if (!ip) return json({ ok: false, error: "no_ip" }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  const name = clean(body && body.name, 80);
  const birthdate = clean(body && body.birthdate, 20);
  const personality = clean(body && body.personality, 600);
  if (!name) return json({ ok: false, error: "missing_name" }, 400);
  if (personality.length < 20) return json({ ok: false, error: "personality_too_short" }, 400);

  // ── claim the IP first (atomic-ish: INSERT with PK rejects races) ──
  try {
    await db
      .prepare("INSERT INTO truesketch_free_uses (ip, used_at, count) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)")
      .bind(ip)
      .run();
  } catch (e) {
    // PRIMARY KEY conflict => this IP already used its free sketch.
    return blocked();
  }

  try {
    // ── sketch: generate + vision QC (up to 3 regenerations), then bake the
    //    SAMPLE watermark into the delivered asset server-side ──
    const art = await generateQCPassedSketch(env, buildFreeFluxPrompt({ personality }));
    if (!art.ok) {
      console.error("truesketch/free-generate QC exhausted", art.qc && art.qc.notes);
      return json({ ok: false, error: "generation_failed" }, 502);
    }
    const sketch = watermarkedSvg(art.base64, art.mime);

    // ── short reading (2 paragraphs, ends on a hook) ──
    const reading = await generateFreeReading(env, { name, birthdate, personality });

    return json({
      ok: true,
      tier: "free",
      title: reading.title,
      paragraphs: reading.paragraphs,
      sketch,
      qc: { attempts: art.attempts, clean: true },
      upgrade: {
        price: "$37",
        cta: "Get your full portrait + 2-page reading — $37",
        url: "intake.html",
      },
    });
  } catch (e) {
    // The IP stays claimed (they got their attempt); surface a clean error.
    console.error("truesketch/free-generate failed", e && e.message);
    return json({ ok: false, error: "generation_failed" }, 502);
  }
}
