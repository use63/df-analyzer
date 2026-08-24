/**
 * Image extraction & redaction for tool results.
 *
 * Why this exists
 * ---------------
 * EdgeOne sandbox tools (notably `browser.screenshot` and `code_interpreter`
 * with image output) return raw objects whose payloads can include base64-
 * encoded images. If we let those flow through `JSON.stringify` straight into
 * `messages.push({ role: 'tool', content })`, the next chat-completions round
 * re-feeds the entire image as text into the model — burning tokens, breaking
 * the context window, and pushing huge strings through the AI gateway.
 *
 * This module gives the chat handler a single hook:
 *
 *   const { images, redactedResult } = extractImagesFromToolResult(raw);
 *
 * Images are pulled out, replaced with a short `[image:<id>]` placeholder
 * (so the model still knows *something* visual happened), and the rest of
 * the structure is returned untouched for normal stringification.
 *
 * Detection rules — see `IMAGE_FIELDS` below. We deliberately:
 *  - require strings to be base64-shaped AND >= MIN_BASE64_LEN, to avoid
 *    treating tiny inline data (8x8 placeholder gifs, <img> srcset b64
 *    icons) as tool screenshots that deserve a separate UI row.
 *  - cap MAX_IMAGES per tool call, so a runaway tool can't spam thousands
 *    of SSE frames or fill IndexedDB.
 *
 * UUID generation uses the Web Crypto global (`crypto.randomUUID()`) — same
 * convention the EdgeOne runtime uses elsewhere in this template, and avoids
 * `node:crypto` which not all Pages Function runtimes expose.
 */

export interface ExtractedImage {
  imageId: string;
  /** Raw base64 payload, no `data:` prefix. */
  base64: string;
  mimeType: string;
  /** Approximate byte size of the decoded image (base64.length * 3 / 4). */
  size: number;
}

export interface ImageExtraction {
  images: ExtractedImage[];
  /**
   * Original value with image fields replaced by `[image:<imageId>]`
   * placeholders. Same shape as the input — caller can JSON.stringify
   * it as-is and feed it back to the model.
   */
  redactedResult: unknown;
  /** True when MAX_IMAGES was hit and additional images were dropped. */
  truncated: boolean;
}

/** Field names we treat as candidate base64 images on object values. */
const IMAGE_FIELDS = new Set([
  'base64Image',
  'imageBase64',
  'screenshot',
  // Conservative: do NOT include the bare `image` / `data` keys here — too
  // many tools use them for non-image payloads. If you need them, add a
  // mime-type check at the call site.
]);

/** Field names we treat as arrays of images. */
const IMAGE_ARRAY_FIELDS = new Set(['images', 'screenshots']);

const MIN_BASE64_LEN = 1024;
const MAX_IMAGES = 8;
// Tight base64 charset, including base64url's `-_` variants. Anchored.
// Whitespace is tolerated for tools that line-wrap their output.
const BASE64_RE = /^[A-Za-z0-9+/=_\-\s]+$/;
// `data:<mime>;base64,<payload>` — common from code_interpreter and any tool
// that hands the model an inline image URL. We strip the prefix and treat
// the payload like a normal base64 string.
const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=_\-\s]+)$/;

interface NormalizedB64 {
  base64: string;
  mimeType: string;
}

/**
 * Normalize a candidate string into a `{ base64, mimeType }` pair, or null
 * if it doesn't look like a base64 image at all. Handles plain base64,
 * base64url, and `data:image/...;base64,...` data URLs.
 */
function normalizeBase64(value: unknown, fallbackMime: string): NormalizedB64 | null {
  if (typeof value !== 'string') return null;
  // data: URL form — pull payload + explicit mime
  const m = value.match(DATA_URL_RE);
  if (m) {
    const [, mime, payload] = m;
    if (payload.length < MIN_BASE64_LEN) return null;
    return { base64: payload, mimeType: mime };
  }
  // Plain (or base64url) form — must clear the length bar AND match the charset
  if (value.length < MIN_BASE64_LEN) return null;
  if (!BASE64_RE.test(value)) return null;
  return { base64: value, mimeType: fallbackMime };
}

function approxByteSize(base64: string): number {
  // 3 bytes per 4 base64 chars; ignore trailing '='. This is a rough estimate
  // — we only use it for UI display, not for any allocation decision.
  const len = base64.replace(/[^A-Za-z0-9+/_\-]/g, '').length;
  return Math.floor((len * 3) / 4);
}

function placeholderFor(id: string): string {
  return `[image:${id}]`;
}

const TRUNCATED_PLACEHOLDER = '[image:truncated]';

interface Ctx {
  out: ExtractedImage[];
  truncated: boolean;
}

function extractFromString(value: string, mimeType: string, ctx: Ctx): string {
  const normalized = normalizeBase64(value, mimeType);
  if (!normalized) return value;
  if (ctx.out.length >= MAX_IMAGES) {
    // CRITICAL: do NOT leave the base64 in place — even if we can't surface
    // it to the UI, we still must not feed multi-MB strings back into the
    // model on the next round. The placeholder loses the visual but keeps
    // the structural cue (the model can see "an image was here").
    ctx.truncated = true;
    return TRUNCATED_PLACEHOLDER;
  }
  const id = crypto.randomUUID();
  ctx.out.push({
    imageId: id,
    base64: normalized.base64,
    mimeType: normalized.mimeType,
    size: approxByteSize(normalized.base64),
  });
  return placeholderFor(id);
}

function walk(node: unknown, ctx: Ctx): unknown {
  if (Array.isArray(node)) {
    return node.map(item => walk(item, ctx));
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    // Track an explicit mime type at this level for sibling base64 fields.
    const mimeType = typeof obj.mimeType === 'string'
      ? obj.mimeType
      : typeof obj.mime_type === 'string'
        ? obj.mime_type
        : 'image/png';

    for (const [key, val] of Object.entries(obj)) {
      if (IMAGE_FIELDS.has(key) && typeof val === 'string') {
        next[key] = extractFromString(val, mimeType, ctx);
        continue;
      }
      if (IMAGE_ARRAY_FIELDS.has(key) && Array.isArray(val)) {
        next[key] = val.map(item => {
          if (typeof item === 'string') {
            return extractFromString(item, mimeType, ctx);
          }
          if (item && typeof item === 'object') {
            const r = item as Record<string, unknown>;
            const itemMime =
              typeof r.mimeType === 'string'
                ? r.mimeType
                : typeof r.mime_type === 'string'
                  ? r.mime_type
                  : mimeType;
            const candidate = r.base64 ?? r.base64Image ?? r.data;
            const normalized = normalizeBase64(candidate, itemMime);
            if (normalized) {
              if (ctx.out.length >= MAX_IMAGES) {
                ctx.truncated = true;
                // Same redaction rule as extractFromString — never leave the
                // raw base64 in place once we've decided not to surface it.
                return { ...r, base64: TRUNCATED_PLACEHOLDER };
              }
              const id = crypto.randomUUID();
              ctx.out.push({
                imageId: id,
                base64: normalized.base64,
                mimeType: normalized.mimeType,
                size: approxByteSize(normalized.base64),
              });
              return { ...r, base64: placeholderFor(id) };
            }
            return walk(item, ctx);
          }
          return item;
        });
        continue;
      }
      next[key] = walk(val, ctx);
    }
    return next;
  }
  // Strings outside known image fields are NOT inspected — a plain string
  // tool result that happens to be base64 is the caller's business; we don't
  // want to misclassify text dumps.
  return node;
}

/**
 * Extract base64 images from a tool result.
 *
 * The input is whatever the EdgeOne tool handler returned — could be string,
 * object, array, anything. We only mutate where we find a recognized image
 * field. If `result` is itself a JSON-encoded string, we try to parse it
 * once — many tools wrap their structured output in a top-level string for
 * historical reasons.
 */
/**
 * Cheap pre-flight test: does this serialized payload even look like it
 * could contain an image field worth walking? Most tool results (commands
 * stdout, plain JSON, web_search hits) hit none of these markers, in which
 * case `extractImagesFromToolResult` can return immediately and skip the
 * JSON.parse + structural walk + JSON.stringify round-trip.
 *
 * Adding new image-bearing fields? Add their key here too.
 */
const HAS_IMAGE_MARKER_RE = /(?:base64Image|imageBase64|"screenshot"|"images"|"screenshots"|data:image\/)/;

export function extractImagesFromToolResult(result: unknown): ImageExtraction {
  const ctx: Ctx = { out: [], truncated: false };

  // If the handler already JSON-stringified its output, parse-walk-restringify
  // so image fields inside are still found. Failure → leave as-is.
  if (typeof result === 'string') {
    // Fast path: if the serialized payload doesn't even contain a marker
    // that could be an image field, skip the whole parse+walk dance. This
    // is the common case (commands stdout, plain text, web_search results).
    if (!HAS_IMAGE_MARKER_RE.test(result)) {
      return { images: [], redactedResult: result, truncated: false };
    }
    const trimmed = result.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const walked = walk(parsed, ctx);
        return {
          images: ctx.out,
          // Re-serialize so the caller can drop it straight back into a
          // `tool` message content slot.
          redactedResult: ctx.out.length > 0 ? JSON.stringify(walked) : result,
          truncated: ctx.truncated,
        };
      } catch {
        // not JSON — pass through
      }
    }
    return { images: [], redactedResult: result, truncated: false };
  }

  const walked = walk(result, ctx);
  // Symmetric to the string branch: if no images were extracted, the deep
  // clone produced by walk() is structurally identical to `result` — return
  // the original so the caller's JSON.stringify works on the same reference
  // and we don't pay for an unnecessary clone.
  return {
    images: ctx.out,
    redactedResult: ctx.out.length > 0 ? walked : result,
    truncated: ctx.truncated,
  };
}
