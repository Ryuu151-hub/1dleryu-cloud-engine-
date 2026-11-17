/**
 * POST /api/engine/analyze
 * Body: { sourceUrl } or { bufferBase64 } (tiny only)
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
import { analyze } from '../../lib/engine/engine.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method not allowed' }, corsHeaders(req));
  }

  try {
    assertAuthorized(req);
    assertOrigin(req);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    assertRateLimit(`analyze:${ip}`);

    const body = req.body || {};
    let buffer;
    if (body.bufferBase64) {
      buffer = Buffer.from(body.bufferBase64, 'base64');
      if (buffer.length > 8 * 1024 * 1024) {
        return json(
          res,
          413,
          { ok: false, error: 'bufferBase64 limited to 8MB; upload first and pass sourceUrl' },
          corsHeaders(req)
        );
      }
    }

    if (!body.sourceUrl && !buffer) {
      return json(res, 400, { ok: false, error: 'sourceUrl or bufferBase64 required' }, corsHeaders(req));
    }

    const result = await analyze({ buffer, sourceUrl: body.sourceUrl });
    return json(res, 200, result, corsHeaders(req));
  } catch (err) {
    const { status, body } = safeError(err);
    return json(res, status, body, corsHeaders(req));
  }
}
