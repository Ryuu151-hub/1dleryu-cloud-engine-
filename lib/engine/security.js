/**
 * 1DLERYU Cloud Engine — security helpers
 * Never expose this module or its secrets to the browser.
 */

const DEFAULT_MAX_BYTES = 80 * 1024 * 1024; // 80 MB
const DEFAULT_ORIGINS = ['https://1dleryu.vercel.app'];

function parseOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  if (!raw.trim()) return DEFAULT_ORIGINS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function getApiKey() {
  const key = process.env.ENGINE_API_KEY;
  if (!key || key.length < 24) {
    throw new Error('ENGINE_API_KEY is missing or too short. Set a strong secret in Vercel env.');
  }
  return key;
}

export function assertAuthorized(req) {
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const expected = getApiKey();
  if (!key || key !== expected) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
}

export function assertOrigin(req) {
  const allowed = parseOrigins();
  const origin = req.headers.origin || req.headers.referer || '';
  const clientOrigin = req.headers['x-client-origin'] || '';
  const check = origin || clientOrigin;

  // Server-to-server or curl without Origin is allowed when API key is valid.
  // Browser requests must match allow-list.
  if (!check) return;

  const ok = allowed.some((a) => check === a || check.startsWith(a));
  if (!ok) {
    const err = new Error('Origin not allowed');
    err.status = 403;
    throw err;
  }
}

export function getMaxUploadBytes() {
  const n = parseInt(process.env.MAX_UPLOAD_BYTES || String(DEFAULT_MAX_BYTES), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/**
 * Very lightweight in-memory rate limiter.
 * Resets on cold starts — good enough for free-tier soft protection.
 * For production scale, move to Redis / Vercel KV / Upstash.
 */
const buckets = new Map();

export function assertRateLimit(identifier) {
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
  const max = parseInt(process.env.RATE_LIMIT_MAX || '30', 10);
  const now = Date.now();
  let b = buckets.get(identifier);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(identifier, b);
  }
  b.count += 1;
  if (b.count > max) {
    const err = new Error('Rate limit exceeded');
    err.status = 429;
    throw err;
  }
}

export function isMp4Buffer(buf) {
  if (!buf || buf.length < 12) return false;
  // ftyp box is almost always near the start
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // Look for 'ftyp' within first 32 bytes
  for (let i = 0; i < Math.min(32, view.length - 4); i++) {
    if (
      view[i] === 0x66 && // f
      view[i + 1] === 0x74 && // t
      view[i + 2] === 0x79 && // y
      view[i + 3] === 0x70 // p
    ) {
      return true;
    }
  }
  return false;
}

export function validateMime(mime) {
  if (!mime) return false;
  const m = mime.toLowerCase().split(';')[0].trim();
  return m === 'video/mp4' || m === 'application/mp4' || m === 'video/quicktime';
}

export function corsHeaders(req) {
  const allowed = parseOrigins();
  const origin = req.headers.origin || '';
  const allow = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-Id, X-Client-Origin',
    'Access-Control-Max-Age': '86400',
  };
}

export function json(res, status, body, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };
  res.statusCode = status;
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(body));
}

export function handleOptions(req, res) {
  const h = corsHeaders(req);
  res.statusCode = 204;
  Object.entries(h).forEach(([k, v]) => res.setHeader(k, v));
  res.end();
}

export function safeError(err) {
  const status = err.status || 500;
  const message =
    status >= 500
      ? 'Internal server error'
      : err.message || 'Request failed';
  return { status, body: { ok: false, error: message } };
}
