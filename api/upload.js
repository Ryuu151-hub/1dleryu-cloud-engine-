/**
 * POST /api/upload
 *
 * Two modes:
 * 1) Client-direct: returns a write token / instructions for @vercel/blob client upload
 *    (recommended so large files never pass through the function body).
 * 2) Server upload: body is raw binary or multipart — only for small files within function limits.
 *
 * Auth: Bearer ENGINE_API_KEY required.
 */
import {
  assertAuthorized,
  assertOrigin,
  assertRateLimit,
  corsHeaders,
  getMaxUploadBytes,
  handleOptions,
  json,
  safeError,
  validateMime,
  isMp4Buffer,
} from '../lib/engine/security.js';
import { uploadBuffer } from '../lib/engine/storage.js';

export const config = {
  api: {
    bodyParser: false, // we need raw body for binary uploads
  },
};

async function readRawBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error(`Upload exceeds max size (${maxBytes} bytes)`);
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method not allowed' }, corsHeaders(req));
  }

  try {
    assertAuthorized(req);
    assertOrigin(req);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    assertRateLimit(`upload:${ip}`);

    const maxBytes = getMaxUploadBytes();
    const contentType = (req.headers['content-type'] || '').toLowerCase();

    // --- Client token flow (preferred) ---
    // Frontend can call with JSON { type: "client-token", filename, contentType }
    if (contentType.includes('application/json')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');

      if (body.type === 'client-token' || body.clientUpload === true) {
        // Use Vercel Blob client upload helper when available
        try {
          const { handleUpload } = await import('@vercel/blob/client');
          const jsonResponse = await handleUpload({
            body,
            request: req,
            onBeforeGenerateToken: async (pathname) => {
              if (!String(pathname).startsWith('1dleryu-engine/uploads/')) {
                throw new Error('Invalid upload path');
              }
              return {
                allowedContentTypes: ['video/mp4', 'application/mp4', 'video/quicktime'],
                maximumSizeInBytes: maxBytes,
                tokenPayload: JSON.stringify({ app: '1dleryu-cloud-engine' }),
              };
            },
            onUploadCompleted: async () => {},
          });
          return json(res, 200, { ok: true, ...jsonResponse }, corsHeaders(req));
        } catch (e) {
          return json(
            res,
            200,
            {
              ok: true,
              mode: 'server-proxy-recommended',
              message:
                'Client token helper unavailable or misconfigured. Use server upload for small files or configure Blob client upload.',
              maxBytes,
              detail: String(e?.message || e).slice(0, 200),
            },
            corsHeaders(req)
          );
        }
      }
    }

    // --- Server-side binary upload ---
    const raw = await readRawBody(req, maxBytes);
    if (!raw.length) {
      return json(res, 400, { ok: false, error: 'Empty body' }, corsHeaders(req));
    }

    const mime = contentType.split(';')[0].trim() || 'video/mp4';
    if (!validateMime(mime) && !isMp4Buffer(raw)) {
      return json(
        res,
        400,
        { ok: false, error: 'Only MP4 uploads are accepted' },
        corsHeaders(req)
      );
    }
    if (!isMp4Buffer(raw)) {
      return json(
        res,
        400,
        { ok: false, error: 'File is not a valid MP4 (ftyp not found)' },
        corsHeaders(req)
      );
    }

    const filename =
      (req.headers['x-filename'] && String(req.headers['x-filename']).slice(0, 120)) ||
      `upload-${Date.now()}.mp4`;

    const uploaded = await uploadBuffer(raw, {
      filename,
      contentType: 'video/mp4',
      folder: 'uploads',
    });

    return json(
      res,
      200,
      {
        ok: true,
        mode: 'server',
        file: uploaded,
      },
      corsHeaders(req)
    );
  } catch (err) {
    const { status, body } = safeError(err);
    return json(res, status, body, corsHeaders(req));
  }
}
