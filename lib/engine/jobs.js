/**
 * 1DLERYU Cloud Engine — job lifecycle
 * States: queued → processing → completed | failed
 * Persistence: Vercel Blob JSON (free-tier friendly).
 */

import { randomUUID } from 'crypto';
import { putJson, getJson, deleteBlob } from './storage.js';

const RETENTION_HOURS = () =>
  parseInt(process.env.JOB_RETENTION_HOURS || '24', 10) || 24;

export function createJobId() {
  return `job_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Create a new job record.
 * @param {object} input
 * @param {string} input.type - analyze | patch | compress
 * @param {string} [input.sourceUrl]
 * @param {object} [input.options]
 * @param {string} [input.clientId]
 */
export async function createJob(input) {
  const id = createJobId();
  const now = new Date().toISOString();
  const job = {
    id,
    type: input.type,
    status: 'queued',
    sourceUrl: input.sourceUrl || null,
    options: input.options || {},
    clientId: input.clientId || null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    progress: 0,
  };
  await putJson(id, job);
  return job;
}

export async function getJob(id) {
  if (!id || typeof id !== 'string' || !id.startsWith('job_')) return null;
  return getJson(id);
}

export async function updateJob(id, patch) {
  const current = await getJob(id);
  if (!current) {
    const err = new Error('Job not found');
    err.status = 404;
    throw err;
  }
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await putJson(id, next);
  return next;
}

export async function markProcessing(id) {
  return updateJob(id, {
    status: 'processing',
    startedAt: new Date().toISOString(),
    progress: 10,
  });
}

export async function markCompleted(id, result) {
  return updateJob(id, {
    status: 'completed',
    finishedAt: new Date().toISOString(),
    progress: 100,
    result,
    error: null,
  });
}

export async function markFailed(id, errorMessage) {
  return updateJob(id, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    progress: 100,
    error: String(errorMessage || 'Unknown error').slice(0, 500),
  });
}

/**
 * Soft cleanup helper — call from a scheduled cron later if desired.
 * For free tier we keep it simple: documents retention policy only.
 */
export function isExpired(job) {
  if (!job?.finishedAt) return false;
  const hours = RETENTION_HOURS();
  const finished = new Date(job.finishedAt).getTime();
  return Date.now() - finished > hours * 3600 * 1000;
}

export async function deleteJobRecord(id) {
  try {
    await deleteBlob(`1dleryu-engine/jobs/${id}.json`);
  } catch {
    /* ignore */
  }
}
