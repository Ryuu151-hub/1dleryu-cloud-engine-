# 1DLERYU Cloud Engine — API Reference

Base URL (after deploy): `https://<your-project>.vercel.app`

All endpoints (except `GET /api/health`) require:

```
Authorization: Bearer <ENGINE_API_KEY>
```

Optional browser header:

```
X-Client-Origin: https://1dleryu.vercel.app
```

---

## GET /api/health

No auth required.

**Response 200**

```json
{
  "ok": true,
  "service": "1DLERYU Cloud Engine",
  "time": "2026-11-17T12:00:00.000Z",
  "engine": {
    "name": "1DLERYU Cloud Engine",
    "version": "1.0.0",
    "patch": { "version": 7, "mode": "v7-dual-audio", "name": "V7Patch" },
    "capabilities": {
      "analyze": true,
      "patch": true,
      "optimizeLocal": true,
      "transcodeExternal": false
    }
  },
  "config": {
    "blob": true,
    "apiKey": true,
    "ffmpegWorker": false,
    "maxUploadBytes": 83886080
  }
}
```

---

## POST /api/upload

Upload an MP4 to Vercel Blob (server path) or request client-upload token.

### Server binary upload

```http
POST /api/upload
Authorization: Bearer <ENGINE_API_KEY>
Content-Type: video/mp4
X-Filename: my-video.mp4

<raw mp4 bytes>
```

**Response 200**

```json
{
  "ok": true,
  "mode": "server",
  "file": {
    "url": "https://....vercel-storage.com/1dleryu-engine/uploads/....mp4",
    "pathname": "1dleryu-engine/uploads/....mp4",
    "downloadUrl": "https://....",
    "size": 1234567,
    "contentType": "video/mp4"
  }
}
```

### Client token (JSON)

```json
{
  "type": "client-token",
  "clientUpload": true
}
```

Returns Vercel Blob client-upload payload when `@vercel/blob/client` flow is configured.

---

## POST /api/jobs

Create and process a job (pure-JS path completes inside the same request).

```json
{
  "type": "patch",
  "sourceUrl": "https://....vercel-storage.com/.../video.mp4",
  "options": {},
  "filename": "patched.mp4",
  "clientId": "optional"
}
```

**Response 200**

```json
{
  "ok": true,
  "job": {
    "id": "job_abc123...",
    "type": "patch",
    "status": "completed",
    "sourceUrl": "https://...",
    "createdAt": "...",
    "finishedAt": "...",
    "progress": 100,
    "result": {
      "ok": true,
      "output": { "url": "...", "downloadUrl": "...", "size": 123 },
      "meta": { "durationMs": 15000, "video": { "width": 1080, "height": 1920 } },
      "note": "Container-level V7 dual-audio style patch. Pixel quality unchanged."
    },
    "error": null
  }
}
```

Job lifecycle: `queued → processing → completed | failed`

---

## GET /api/jobs/:id

```http
GET /api/jobs/job_abc123...
Authorization: Bearer <ENGINE_API_KEY>
```

**Response 200**

```json
{
  "ok": true,
  "job": { "...same shape as above..." }
}
```

---

## POST /api/engine/analyze

```json
{
  "sourceUrl": "https://....mp4"
}
```

**Response 200**

```json
{
  "ok": true,
  "engine": { "..." },
  "meta": {
    "ok": true,
    "size": 1234567,
    "hasFtyp": true,
    "hasMoov": true,
    "hasMdat": true,
    "brands": ["isom", "iso2", "avc1", "mp41"],
    "durationMs": 15200,
    "timescale": 1000,
    "video": {
      "codec": "avc1",
      "width": 1080,
      "height": 1920,
      "durationMs": 15200,
      "sampleCount": 456
    },
    "audio": [
      {
        "codec": "mp4a",
        "sampleRate": 48000,
        "channels": 2,
        "durationMs": 15200
      }
    ],
    "warnings": []
  }
}
```

---

## POST /api/engine/patch

```json
{
  "sourceUrl": "https://....mp4",
  "filename": "out.mp4",
  "options": {}
}
```

**Response 200** — same shape as job result for type `patch`.

Note: This is the server-side port of the existing V7 dual-audio container patch. It does **not** re-encode video pixels.

---

## POST /api/engine/compress

```json
{
  "sourceUrl": "https://....mp4",
  "options": {
    "mode": "optimize"
  },
  "filename": "optimized.mp4"
}
```

- `mode: "optimize"` (default) — local pure-JS container path. **No quality claim.**
- `mode: "transcode"` — requires `FFMPEG_WORKER_URL` external worker. Returns worker output URL.

**Honest limits**

True resolution / FPS / CRF changes need FFmpeg. Vercel Functions cannot host heavy FFmpeg reliably on free tier. Configure an external worker (Fly.io / Railway free tier) and set `FFMPEG_WORKER_URL` + `FFMPEG_WORKER_SECRET`.

---

## Error shape

```json
{
  "ok": false,
  "error": "Unauthorized"
}
```

Common status codes: `400` validation, `401` auth, `403` origin, `413` too large, `429` rate limit, `501` feature needs worker, `502` worker failure, `503` Blob not configured.
