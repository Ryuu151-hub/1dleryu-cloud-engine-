/**
 * POST /api/engine/compress
 *
 * options.mode:
 *   - "optimize" (default): local pure-JS container pass — no quality claim
 *   - "transcode": requires FFMPEG_WORKER_URL external worker
 *
 * Body: { sourceUrl, options?: { mode, crf, scale, fps, ... }, filename? }
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
import { runCompress } from '../../lib/engine/engine.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method not allowed' }, corsHeaders(req));
  }

  try {
    assertAuthorized(req);
    assertOrigin(req);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    assertRateLimit(`compress:${ip}`);

    const body = req.body || {};
    if (!body.sourceUrl && !body.bufferBase64) {
      return json(res, 400, { ok: false, error: 'sourceUrl required' }, corsHeaders(req));
    }

    let buffer;
    if (body.bufferBase64) {
      buffer = Buffer.from(body.bufferBase64, 'base64');
      if (buffer.length > 8 * 1024 * 1024) {
        return json(
          res,
          413,
          { ok: false, error: 'bufferBase64 limited to 8MB' },
          corsHeaders(req)
        );
      }
    }

    const result = await runCompress({
      buffer,
      sourceUrl: body.sourceUrl,
      options: body.options || { mode: 'optimize' },
      filename: body.filename,
    });
    return json(res, 200, result, corsHeaders(req));
  } catch (err) {
    const { status, body } = safeError(err);
    return json(res, status, body, corsHeaders(req));
  }
}
