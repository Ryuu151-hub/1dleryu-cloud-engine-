/**
 * 1DLERYU Cloud Engine — compression orchestration
 *
 * IMPORTANT (free-tier honesty):
 * - True re-encode (resolution / fps / CRF changes) requires FFmpeg.
 * - Vercel Serverless Functions are not suitable for heavy FFmpeg jobs
 *   (timeout, memory, binary size, CPU).
 * - This module implements:
 *   1. Lightweight "optimize" path: validate + re-wrap via patch engine (no quality claim).
 *   2. Optional hand-off to an external FFmpeg worker if FFMPEG_WORKER_URL is configured.
 * - Never claim metadata-only changes improve visual quality.
 */

import { patch, PATCH_VERSION } from './mp4-patch.js';
import { inspectMp4 } from './mp4-inspector.js';

/**
 * Local lightweight optimize: runs the same container patch as a clean re-mux style pass.
 * Does not change pixel quality or bitrate.
 */
export async function optimizeLocal(buffer, options = {}) {
  const info = inspectMp4(buffer);
  if (!info.ok || !info.hasMoov) {
    const err = new Error('Cannot optimize: invalid MP4 structure');
    err.status = 400;
    throw err;
  }

  const out = patch(buffer, options.patchOptions || {});
  return {
    buffer: Buffer.from(out),
    method: 'local-v7-container',
    qualityClaim: false,
    note:
      'Container-level rebuild only. No pixel re-encode. Visual quality is unchanged.',
    sourceMeta: {
      size: info.size,
      durationMs: info.durationMs,
      video: info.video,
      audioTracks: info.audio.length,
    },
    patchVersion: PATCH_VERSION,
  };
}

/**
 * Attempt external FFmpeg worker if configured.
 * Worker contract (expected):
 *   POST { sourceUrl, options } with header X-Worker-Secret
 *   → { ok, outputUrl, meta }
 */
export async function compressViaWorker(sourceUrl, options = {}) {
  const workerUrl = process.env.FFMPEG_WORKER_URL;
  const secret = process.env.FFMPEG_WORKER_SECRET || '';
  if (!workerUrl) {
    const err = new Error(
      'True compression requires an external FFmpeg worker. Set FFMPEG_WORKER_URL or use optimizeLocal.'
    );
    err.status = 501;
    throw err;
  }

  const res = await fetch(`${workerUrl.replace(/\/$/, '')}/compress`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Secret': secret,
    },
    body: JSON.stringify({
      sourceUrl,
      options: {
        // Example options the worker may support
        crf: options.crf ?? 23,
        preset: options.preset ?? 'veryfast',
        scale: options.scale || null, // e.g. "720:-2"
        fps: options.fps || null,
        audioBitrate: options.audioBitrate || '96k',
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`FFmpeg worker failed: ${res.status} ${text.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  if (!data.ok || !data.outputUrl) {
    const err = new Error(data.error || 'Worker returned invalid response');
    err.status = 502;
    throw err;
  }

  return {
    outputUrl: data.outputUrl,
    method: 'external-ffmpeg-worker',
    qualityClaim: true,
    note: 'Re-encoded by external worker. Quality/bitrate changes depend on worker settings.',
    meta: data.meta || null,
  };
}

/**
 * Orchestrator used by the engine.
 * mode: "optimize" (default, local) | "transcode" (requires worker)
 */
export async function runCompression(input, options = {}) {
  const mode = options.mode || 'optimize';

  if (mode === 'transcode') {
    if (!options.sourceUrl) {
      const err = new Error('transcode mode requires sourceUrl for worker hand-off');
      err.status = 400;
      throw err;
    }
    return compressViaWorker(options.sourceUrl, options);
  }

  // local optimize
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return optimizeLocal(buffer, options);
}
