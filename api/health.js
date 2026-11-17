/**
 * GET /api/health
 */
import { ENGINE_INFO } from '../lib/engine/engine.js';
import { corsHeaders, handleOptions, json } from '../lib/engine/security.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'GET') {
    return json(res, 405, { ok: false, error: 'Method not allowed' }, corsHeaders(req));
  }

  const blobConfigured = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const apiKeyConfigured = Boolean(process.env.ENGINE_API_KEY && process.env.ENGINE_API_KEY.length >= 24);

  return json(
    res,
    200,
    {
      ok: true,
      service: '1DLERYU Cloud Engine',
      time: new Date().toISOString(),
      engine: ENGINE_INFO,
      config: {
        blob: blobConfigured,
        apiKey: apiKeyConfigured,
        ffmpegWorker: Boolean(process.env.FFMPEG_WORKER_URL),
        maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || String(80 * 1024 * 1024), 10),
      },
    },
    corsHeaders(req)
  );
}
