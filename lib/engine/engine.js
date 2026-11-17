/**
 * 1DLERYU Cloud Engine — main controller
 * Coordinates inspect, patch, compress, storage and jobs.
 * All private; never import this from frontend code.
 */

import { inspectMp4, isValidMp4Structure } from './mp4-inspector.js';
import { patch, PATCH_VERSION, PATCH_MODE, PATCH_NAME } from './mp4-patch.js';
import { runCompression } from './compression.js';
import { uploadBuffer, downloadToBuffer } from './storage.js';
import {
  createJob,
  getJob,
  markProcessing,
  markCompleted,
  markFailed,
} from './jobs.js';
import { getMaxUploadBytes, isMp4Buffer } from './security.js';

export const ENGINE_INFO = {
  name: '1DLERYU Cloud Engine',
  version: '1.0.0',
  patch: { version: PATCH_VERSION, mode: PATCH_MODE, name: PATCH_NAME },
  capabilities: {
    analyze: true,
    patch: true,
    optimizeLocal: true,
    transcodeExternal: Boolean(process.env.FFMPEG_WORKER_URL),
  },
};

/**
 * Analyze a buffer or a remote source URL.
 */
export async function analyze({ buffer, sourceUrl }) {
  let data = buffer;
  if (!data && sourceUrl) {
    data = await downloadToBuffer(sourceUrl, getMaxUploadBytes());
  }
  if (!data) {
    const err = new Error('buffer or sourceUrl required');
    err.status = 400;
    throw err;
  }
  if (!isMp4Buffer(data)) {
    const err = new Error('File does not look like a valid MP4 (ftyp missing)');
    err.status = 400;
    throw err;
  }
  const meta = inspectMp4(data);
  return {
    ok: true,
    engine: ENGINE_INFO,
    meta,
  };
}

/**
 * Patch a buffer or remote source, upload result, return URLs + meta.
 */
export async function runPatch({ buffer, sourceUrl, options = {}, filename }) {
  let data = buffer;
  if (!data && sourceUrl) {
    data = await downloadToBuffer(sourceUrl, getMaxUploadBytes());
  }
  if (!data) {
    const err = new Error('buffer or sourceUrl required');
    err.status = 400;
    throw err;
  }
  if (!isMp4Buffer(data) || !isValidMp4Structure(data)) {
    const err = new Error('Invalid MP4 structure');
    err.status = 400;
    throw err;
  }

  const outU8 = patch(data, options);
  const outBuf = Buffer.from(outU8);
  const uploaded = await uploadBuffer(outBuf, {
    filename: filename || `patched-${Date.now()}.mp4`,
    contentType: 'video/mp4',
    folder: 'results',
  });

  const meta = inspectMp4(outBuf);
  return {
    ok: true,
    engine: ENGINE_INFO,
    output: uploaded,
    meta,
    note: 'Container-level V7 dual-audio style patch. Pixel quality unchanged.',
  };
}

/**
 * Compression / optimize path.
 */
export async function runCompress({ buffer, sourceUrl, options = {}, filename }) {
  const mode = options.mode || 'optimize';

  if (mode === 'transcode') {
    // External worker returns its own URL
    const result = await runCompression(null, { ...options, mode, sourceUrl });
    return {
      ok: true,
      engine: ENGINE_INFO,
      output: { url: result.outputUrl, downloadUrl: result.outputUrl },
      method: result.method,
      note: result.note,
      meta: result.meta,
    };
  }

  let data = buffer;
  if (!data && sourceUrl) {
    data = await downloadToBuffer(sourceUrl, getMaxUploadBytes());
  }
  if (!data) {
    const err = new Error('buffer or sourceUrl required for optimize mode');
    err.status = 400;
    throw err;
  }

  const result = await runCompression(data, { ...options, mode: 'optimize' });
  const uploaded = await uploadBuffer(result.buffer, {
    filename: filename || `optimized-${Date.now()}.mp4`,
    contentType: 'video/mp4',
    folder: 'results',
  });

  return {
    ok: true,
    engine: ENGINE_INFO,
    output: uploaded,
    method: result.method,
    note: result.note,
    qualityClaim: result.qualityClaim,
    sourceMeta: result.sourceMeta,
  };
}

/**
 * Create a tracked job and optionally process it immediately (for small pure-JS ops).
 * Heavy work should stay async; pure-JS path can finish inside the same invocation.
 */
export async function enqueueAndProcess({ type, sourceUrl, buffer, options, clientId, filename }) {
  const job = await createJob({
    type,
    sourceUrl: sourceUrl || null,
    options: options || {},
    clientId,
  });

  try {
    await markProcessing(job.id);

    let result;
    if (type === 'analyze') {
      result = await analyze({ buffer, sourceUrl });
    } else if (type === 'patch') {
      result = await runPatch({ buffer, sourceUrl, options, filename });
    } else if (type === 'compress') {
      result = await runCompress({ buffer, sourceUrl, options, filename });
    } else {
      throw Object.assign(new Error(`Unknown job type: ${type}`), { status: 400 });
    }

    const completed = await markCompleted(job.id, result);
    return completed;
  } catch (err) {
    await markFailed(job.id, err.message || String(err));
    throw err;
  }
}

export { getJob };
