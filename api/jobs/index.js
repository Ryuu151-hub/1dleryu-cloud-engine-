/**
 * POST /api/jobs
 * Create a processing job and run pure-JS work in the same invocation when possible.
 *
 * Body JSON:
 * {
 *   "type": "analyze" | "patch" | "compress",
 *   "sourceUrl": "https://....mp4",   // preferred
 *   "options": { ... },
 *   "clientId": "optional-user-ref",
 *   "filename": "out.mp4"
 * }
 */
import {
  assertAuthorized,
  assertOrigin,
  assertRateLimit,
  corsHeaders,
  handleOptions,
  json,
  safeError,
} from '../../lib/engine/security.js';
import { enqueueAndProcess } from '../../lib/engine/engine.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method not allowed' }, corsHeaders(req));
  }

  try {
    assertAuthorized(req);
    assertOrigin(req);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    assertRateLimit(`jobs:${ip}`);

    const body = typeof req.body === 'object' && req.body ? req.body : {};
    // Vercel may parse JSON automatically; if not, read raw
    let payload = body;
    if (!payload.type && typeof req.body === 'undefined') {
      // safety for some runtimes
      payload = {};
    }

    const type = payload.type;
    if (!['analyze', 'patch', 'compress'].includes(type)) {
      return json(
        res,
        400,
        { ok: false, error: 'type must be analyze | patch | compress' },
        corsHeaders(req)
      );
    }
    if (!payload.sourceUrl && !payload.bufferBase64) {
      return json(
        res,
        400,
        { ok: false, error: 'sourceUrl (or bufferBase64 for tiny files) is required' },
        corsHeaders(req)
      );
    }

    let buffer;
    if (payload.bufferBase64) {
      buffer = Buffer.from(payload.bufferBase64, 'base64');
      // hard cap base64 path
      if (buffer.length > 8 * 1024 * 1024) {
        return json(
          res,
          413,
          { ok: false, error: 'bufferBase64 path limited to 8MB; use sourceUrl upload' },
          corsHeaders(req)
        );
      }
    }

    const job = await enqueueAndProcess({
      type,
      sourceUrl: payload.sourceUrl,
      buffer,
      options: payload.options || {},
      clientId: payload.clientId,
      filename: payload.filename,
    });

    return json(res, 200, { ok: true, job }, corsHeaders(req));
  } catch (err) {
    const { status, body } = safeError(err);
    return json(res, status, body, corsHeaders(req));
  }
}
