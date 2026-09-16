// functions/api/free-generate.js
// POST /api/free-generate — the IP-restricted free tier.
// Body: { name, birthdate?, personality }
//
// Rules:
//   - Exactly ONE free generation per IP. The IP is claimed (INSERT) BEFORE
//     generation so concurrent double-submits can't both run.
//   - Output is deliberately partial: a watermarked-by-CSS sketch + a short
//     reading excerpt (2 paragraphs). The full $37 reading is the upgrade.
//   - No auth, no payment, no email required.
//   - cf-connecting-ip is the only IP source (set by Cloudflare; not spoofable).
//
// On a second attempt from the same IP: HTTP 403 {ok:false, blocked:true}.

import { runText, runImage, parseJson, MODELS } from "./_lib/ai.js";

const ZERO_TEXT_SUFFIX =
  " CRITICAL: the image must contain absolutely no text, letters, numbers, " +
  "words, labels, signs, signatures, initials, monograms, or watermark-like " +
  "shapes anywhere. The artwork must be completely UNSIGNED. Pure imagery only.";

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
    // ── sketch (single generation; the text-free rule keeps it clean) ──
    const { base64, mime } = await runImage(env, buildFreeFluxPrompt({ personality }), {});
    const sketch = `data:${mime};base64,${base64}`;

    // ── short reading (2 paragraphs, ends on a hook) ──
    const reading = await generateFreeReading(env, { name, birthdate, personality });

    return json({
      ok: true,
      tier: "free",
      title: reading.title,
      paragraphs: reading.paragraphs,
      sketch,
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
