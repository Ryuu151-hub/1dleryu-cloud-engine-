/**
 * GET /api/jobs/:id
 */
import {
  assertAuthorized,
  assertOrigin,
  corsHeaders,
  handleOptions,
  json,
  safeError,
} from '../../lib/engine/security.js';
import { getJob } from '../../lib/engine/engine.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'GET') {
    return json(res, 405, { ok: false, error: 'Method not allowed' }, corsHeaders(req));
  }

  try {
    assertAuthorized(req);
    assertOrigin(req);

    const id = req.query?.id || (req.url && req.url.split('/').pop());
    if (!id || !String(id).startsWith('job_')) {
      return json(res, 400, { ok: false, error: 'Invalid job id' }, corsHeaders(req));
    }

    const job = await getJob(String(id));
    if (!job) {
      return json(res, 404, { ok: false, error: 'Job not found' }, corsHeaders(req));
    }

    return json(res, 200, { ok: true, job }, corsHeaders(req));
  } catch (err) {
    const { status, body } = safeError(err);
    return json(res, status, body, corsHeaders(req));
  }
}
