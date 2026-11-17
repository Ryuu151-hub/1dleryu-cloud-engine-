/**
 * 1DLERYU Cloud Engine — Vercel Blob storage layer
 * Requires BLOB_READ_WRITE_TOKEN (auto-set when Blob is connected in Vercel).
 */

import { put, del, list, head } from '@vercel/blob';
import { randomUUID } from 'crypto';

const PREFIX = '1dleryu-engine';

function requireToken() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    const err = new Error(
      'BLOB_READ_WRITE_TOKEN missing. Connect Vercel Blob storage in the project dashboard.'
    );
    err.status = 503;
    throw err;
  }
}

/**
 * Upload a buffer as a private (or public) blob.
 * Returns { url, pathname, downloadUrl, size, contentType }
 */
export async function uploadBuffer(buffer, options = {}) {
  requireToken();
  const {
    filename = `file-${randomUUID()}.mp4`,
    contentType = 'video/mp4',
    access = 'public', // Vercel Blob free tier commonly uses public; restrict via short-lived URLs in app layer
    folder = 'uploads',
  } = options;

  const pathname = `${PREFIX}/${folder}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  const blob = await put(pathname, buffer, {
    access,
    contentType,
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });

  return {
    url: blob.url,
    pathname: blob.pathname,
    downloadUrl: blob.downloadUrl || blob.url,
    size: buffer.length || buffer.byteLength,
    contentType,
  };
}

/**
 * Store JSON job metadata as a blob (simple free-tier persistence).
 */
export async function putJson(key, data) {
  requireToken();
  const pathname = `${PREFIX}/jobs/${key}.json`;
  const body = JSON.stringify(data);
  const blob = await put(pathname, body, {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    allowOverwrite: true,
  });
  return { url: blob.url, pathname: blob.pathname };
}

export async function getJson(key) {
  requireToken();
  const pathname = `${PREFIX}/jobs/${key}.json`;
  // Prefer direct fetch of the public URL pattern; list as fallback
  try {
    const listResult = await list({
      prefix: `${PREFIX}/jobs/${key}`,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      limit: 5,
    });
    const match = (listResult.blobs || []).find(
      (b) => b.pathname === pathname || b.pathname.endsWith(`/${key}.json`)
    );
    if (!match) return null;
    const res = await fetch(match.url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function deleteBlob(pathnameOrUrl) {
  requireToken();
  try {
    await del(pathnameOrUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
    return true;
  } catch {
    return false;
  }
}

export async function headBlob(url) {
  requireToken();
  try {
    return await head(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch {
    return null;
  }
}

/**
 * Download remote blob into a Buffer (with size guard).
 */
export async function downloadToBuffer(url, maxBytes) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`Failed to download source: ${res.status}`);
    err.status = 400;
    throw err;
  }
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  if (maxBytes && len && len > maxBytes) {
    const err = new Error(`Source exceeds max size (${maxBytes} bytes)`);
    err.status = 413;
    throw err;
  }
  const ab = await res.arrayBuffer();
  if (maxBytes && ab.byteLength > maxBytes) {
    const err = new Error(`Source exceeds max size (${maxBytes} bytes)`);
    err.status = 413;
    throw err;
  }
  return Buffer.from(ab);
}
