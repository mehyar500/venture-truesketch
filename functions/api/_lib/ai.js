// functions/api/_lib/ai.js
// Thin Workers AI helpers for TrueSketch (adapted from Designful's proven lib).
// No secrets, no hardcoded keys — everything runs through the env.AI binding.
//
// Model lessons baked in (see ~/AGENTS.md):
// - flux-1-schnell returns {image:"<base64>"} — sniff magic bytes for the
//   real container (FFD8=JPEG, 89504E47=PNG); never trust a filename.
// - @cf/meta/llama-3.2-11b-vision-instruct FAILS (error 3030) when one call
//   carries two image_url entries. runVision() takes exactly ONE image;
//   fan out with Promise.all if you need several.
// - Workers AI json_object mode on some models (proven 2026-09-15 on
//   @cf/meta/llama-3.3-70b-instruct-fp8-fast) returns result.response
//   PRE-PARSED as an object, not a string — String(obj) gives "[object Object]"
//   and silently kills every JSON parse downstream. aiText() below serializes
//   objects back to JSON so parseJson() sees the real payload either way.

/**
 * Extract generated text from an env.AI.run() result (string or pre-parsed
 * object; see the model lesson above).
 */
function aiText(out) {
  if (typeof out === "string") return out;
  const r = out && out.response;
  if (r == null) return "";
  return typeof r === "string" ? r : JSON.stringify(r);
}

export const MODELS = {
  text: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", // strong writing/reasoning
  textFast: "@cf/meta/llama-3.2-3b-instruct", // cheap, high-volume
  vision: "@cf/meta/llama-3.2-11b-vision-instruct", // ONE image per call
  image: "@cf/bytedance/stable-diffusion-xl-lightning", // returns {image: base64}; Flux hallucinates text 100% of runs (2026-09-16)
};

/**
 * Run a chat/text model. Returns the raw response string (trimmed).
 * jsonMode adds response_format json_object; callers must still parseJson().
 */
export async function runText(env, model, messages, opts = {}) {
  const { max_tokens = 2048, temperature = 0.7, jsonMode = false } = opts;
  const body = { messages, max_tokens, temperature };
  if (jsonMode) body.response_format = { type: "json_object" };
  const out = await env.AI.run(model, body);
  return aiText(out).trim();
}

/**
 * Run the image model. Returns {base64, mime, ext} with the container
 * sniffed from magic bytes — never inferred from the prompt.
 */
export async function runImage(env, prompt, opts = {}) {
  const {
    model = MODELS.image,
    steps = 8, // SDXL-lightning sweet spot
  } = opts;
  // NOTE: width/height are NOT sent. The Workers AI flux-1-schnell endpoint
  // rejects them ("unevaluated properties '/width, /height' not allowed",
  // proven 2026-09-15) and always returns 1024x1024. Callers that need a
  // non-square deliverable must crop/letterbox client-side; actual dims are
  // sniffed from the bytes and returned so manifests never lie.
  const out = await env.AI.run(model, { prompt, num_steps: steps });
  const base64 = out && out.image;
  if (!base64) throw new Error("image_model_empty_response");
  const bytes = b64ToBytes(base64);
  let mime = "application/octet-stream";
  let ext = "bin";
  let width = 0;
  let height = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = "image/jpeg";
    ext = "jpg";
    ({ width, height } = jpegDims(bytes));
  } else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    mime = "image/png";
    ext = "png";
    width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  } else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    // RIFF....WEBP
    mime = "image/webp";
    ext = "webp";
  }
  return { base64, mime, ext, width, height };
}

/** Sniff JPEG dimensions from SOF0/SOF2 marker. Returns {width, height}. */
function jpegDims(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
      };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) break;
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

/**
 * Run the vision model on a SINGLE image. Passing two images in one call
 * triggers error 3030 — fan out with Promise.all for multiple images.
 */
export async function runVision(env, imageUrl, prompt, opts = {}) {
  const model = opts.model || MODELS.vision;
  const out = await env.AI.run(model, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: opts.max_tokens || 2048,
  });
  return aiText(out).trim();
}

/** Parse model output as JSON; tolerates ```json fences. Returns null on failure.
 * Fallback layers, in order:
 *   1. strict JSON.parse
 *   2. fenced ```json block
 *   3. outermost {...} block
 *   4. Python-dict normalization (single quotes -> double) — llama-3.3-70b
 *      emits single-quoted "JSON" despite json_object mode; observed in
 *      validation repeatedly. Applied only to candidates that failed strict
 *      parsing, so valid JSON never passes through the normalizer. */
/** Convert single-quoted Python-dict-ish output to valid JSON.
 * Handles: 'key': 'value', 'key': "value", trailing commas, True/False/None.
 * String contents with apostrophes (e.g. "it's") are preserved: the regex
 * only rewrites quotes that are structural (followed/preceded by : , { [ }). */
function normalizePyDict(s) {
  return s
    // \' is not valid JSON anywhere; in single-quoted model output it is an
    // escaped apostrophe — stash it as a placeholder so the quote rewriting
    // below does not mistake it for a structural quote, then restore it.
    .replace(/\\'/g, "__APOS__")
    // 'key':  ->  "key":
    .replace(/([{,\s])'([^'\n]*?)'(\s*:)/g, '$1"$2"$3')
    // : 'value'  ->  : "value"   (and [ 'value' / , 'value')
    .replace(/([:\[,\]\s])'([^'\n]*?)'(\s*[,}\]])/g, '$1"$2"$3')
    // trailing commas before } or ]
    .replace(/,\s*([}\]])/g, "$1")
    // Python literals
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
    .replace(/__APOS__/g, "'");
}


export function parseJson(s) {
  if (!s) return null;
  const candidates = [s];
  const m = /```(?:json)?\s*([\s\S]+?)\s*```/i.exec(s);
  if (m) candidates.push(m[1]);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(s.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {}
    const norm = normalizePyDict(c);
    if (norm !== c) {
      try {
        return JSON.parse(norm);
      } catch {}
    }
  }
  return null;
}

/**
 * Run a JSON-mode text call with schema validation and bounded retries.
 * validate(parsed) must return true for acceptable output. On parse failure
 * or validation failure, the model is re-prompted with a repair nudge that
 * quotes the specific problem. Throws after retries are exhausted.
 */
export async function runTextJson(env, model, messages, opts = {}) {
  const { max_tokens = 2048, temperature = 0.7, retries = 2, validate = null, label = "json" } = opts;
  let lastErr = "unknown";
  let msgs = messages;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const text = await runText(env, model, msgs, { max_tokens, temperature, jsonMode: true });
    const parsed = parseJson(text);
    if (!parsed) {
      lastErr = "parse_failed";
    } else if (validate) {
      // A validator may return true (pass), false (generic fail), or a
      // string naming the failure (surfaced in the repair nudge).
      const v = validate(parsed);
      if (v === true) {
        return { parsed, attempts: attempt + 1 };
      }
      lastErr = typeof v === "string" && v ? v : "schema_validation_failed";
    } else {
      return { parsed, attempts: attempt + 1 };
    }
    // Repair nudge: name the failure so the next attempt fixes it.
    const why = lastErr === "parse_failed"
      ? "was not valid JSON"
      : lastErr === "schema_validation_failed"
        ? "did not match the required schema"
        : lastErr; // specific validator reason, used verbatim
    msgs = [
      ...messages,
      {
        role: "user",
        content:
          `Your last response ${why}. ` +
          `Reply with ONLY a corrected JSON object matching the schema — no prose, no fences, no apologies.`,
      },
    ];
  }
  throw new Error(`runTextJson(${label}) failed after ${retries + 1} attempts: ${lastErr}`);
}

/** Run fn over items with bounded concurrency; results stay in input order. */
export async function boundedMap(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        out[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (err) {
        out[idx] = { ok: false, error: String((err && err.message) || err) };
      }
    }
  }
  const pool = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) pool.push(worker());
  await Promise.all(pool);
  return out;
}

// atob() chokes on very large single strings in some runtimes — decode in chunks.
function b64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

