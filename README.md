# 1DLERYU Cloud Engine

Private server-side video engine for the [1DLERYU](https://1dleryu.vercel.app/) website.

- **Analyze** MP4 structure (pure JS)
- **Patch** using the existing V7 dual-audio container engine (server port)
- **Optimize** (container-level, no fake quality claims)
- **Job tracking** + **Vercel Blob** storage
- Optional external **FFmpeg worker** hook for real transcoding

All engine modules live under `lib/engine/` and are never shipped to the browser.

---

## Architecture (free-tier honest)

| Layer | Choice | Notes |
|-------|--------|--------|
| Frontend | Existing 1dleryu.vercel.app | Keep as-is; call these APIs |
| API | Vercel Serverless Functions | Node.js |
| Engine | Private JS modules | V7 patch port + inspector |
| Storage | Vercel Blob | Free tier limits apply |
| Heavy FFmpeg | **Not** inside Vercel Functions | Use optional external worker |

**Why FFmpeg is not inside Vercel Functions**

- Hobby/Pro timeouts and memory are too tight for real re-encodes of typical phone videos.
- Shipping a full FFmpeg binary blows package size and cold-start time.
- This project runs pure-JS analysis + V7-style patching **inside** Functions, and provides a clean hand-off (`FFMPEG_WORKER_URL`) for true transcoding later (Fly.io / Railway free tiers).

**What “patch” means here**

Same as your existing website/extension V7 engine: container rebuild with dual-audio track layout. **Pixel quality and bitrate are not changed.** Metadata-only changes are never marketed as quality upgrades.

---

## Folder structure

```
1dleryu-cloud-engine/
├── api/
│   ├── health.js
│   ├── upload.js
│   ├── jobs/
│   │   ├── index.js          # POST create + process
│   │   └── [id].js           # GET status
│   └── engine/
│       ├── analyze.js
│       ├── patch.js
│       └── compress.js
├── lib/engine/
│   ├── engine.js             # controller
│   ├── mp4-inspector.js
│   ├── mp4-patch.js          # V7 port
│   ├── compression.js
│   ├── storage.js
│   ├── security.js
│   └── jobs.js
├── docs/API.md
├── package.json
├── vercel.json
├── .env.example
├── .gitignore
└── README.md
```

---

## Environment variables

Copy `.env.example` → set in Vercel Project → Settings → Environment Variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `ENGINE_API_KEY` | Yes | Long random secret (Bearer token for all API calls) |
| `BLOB_READ_WRITE_TOKEN` | Yes (auto) | Created when you connect Vercel Blob |
| `ALLOWED_ORIGINS` | Recommended | `https://1dleryu.vercel.app,http://localhost:3000` |
| `MAX_UPLOAD_BYTES` | Optional | Default `83886080` (80 MB) |
| `RATE_LIMIT_*` | Optional | Soft in-memory limits |
| `FFMPEG_WORKER_URL` | Optional | External transcode worker |
| `FFMPEG_WORKER_SECRET` | Optional | Shared secret for that worker |

Generate a key on any machine:

```bash
openssl rand -hex 32
```

---

## Deployment (step by step)

### 1. Create GitHub repository

1. On GitHub → **New repository**
2. Name: `1dleryu-cloud-engine` (or keep your existing repo and add this as a folder / new branch)
3. Visibility: **Private** (engine source stays private)
4. Do **not** initialize with README if you will upload these files as the first commit

### 2. Upload project files (mobile or desktop)

**Desktop**

```bash
cd 1dleryu-cloud-engine
git init
git add .
git commit -m "Initial 1DLERYU Cloud Engine"
git branch -M main
git remote add origin https://github.com/<you>/1dleryu-cloud-engine.git
git push -u origin main
```

**Mobile (GitHub app / web)**

1. Create the empty private repo on GitHub.com
2. Use the web “Upload files” UI, or a mobile Git client (Working Copy, etc.)
3. Upload the entire folder contents (keep the structure)

### 3. Import into Vercel

1. [vercel.com](https://vercel.com) → Add New Project
2. Import the GitHub repo
3. Framework Preset: **Other**
4. Root Directory: leave default (or set if nested)
5. Build Command: leave empty
6. Output Directory: leave empty
7. Install Command: `npm install` (default)

### 4. Configure environment variables

In the Vercel project → Settings → Environment Variables, add at least:

- `ENGINE_API_KEY` = your long secret
- `ALLOWED_ORIGINS` = `https://1dleryu.vercel.app`

Apply to Production (and Preview if you want).

### 5. Connect Vercel Blob

1. Vercel project → Storage → Create → **Blob**
2. Connect it to this project
3. Vercel injects `BLOB_READ_WRITE_TOKEN` automatically

### 6. Deploy

Click **Deploy**. After success, open:

```
https://<your-project>.vercel.app/api/health
```

You should see `"ok": true` and config flags.

### 7. Test API endpoints

Replace `BASE` and `KEY`:

```bash
BASE=https://<your-project>.vercel.app
KEY=your_engine_api_key

# Health
curl -s "$BASE/api/health" | head

# Analyze (after you have a public MP4 URL from Blob or elsewhere)
curl -s -X POST "$BASE/api/engine/analyze" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"sourceUrl":"https://example.com/sample.mp4"}'
```

Upload test (small file):

```bash
curl -s -X POST "$BASE/api/upload" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: video/mp4" \
  -H "X-Filename: test.mp4" \
  --data-binary @./test.mp4
```

Then create a job with the returned `url` as `sourceUrl`.

### 8. Connect the existing 1DLERYU frontend

On https://1dleryu.vercel.app (or your local build):

1. Store `ENGINE_API_KEY` **only on the server** if the site has its own API routes, **or** use a short-lived session that proxies to this engine.
2. Prefer: frontend → your existing auth session → server-side proxy → Cloud Engine (so the raw `ENGINE_API_KEY` never appears in browser JS).
3. Minimal browser flow if you accept key in a secure admin-only tool:

```js
const BASE = 'https://<cloud-engine>.vercel.app';
const headers = {
  Authorization: `Bearer ${ENGINE_API_KEY}`, // only if this never ships to public users
  'Content-Type': 'application/json',
  'X-Client-Origin': 'https://1dleryu.vercel.app',
};

// 1) Upload (or client Blob upload)
// 2) const job = await fetch(`${BASE}/api/jobs`, { method:'POST', headers, body: JSON.stringify({
//      type: 'patch', sourceUrl: uploaded.url
//    })}).then(r => r.json());
// 3) Use job.result.output.downloadUrl
```

**Recommended production pattern:** keep the key on a small proxy route inside the existing 1dleryu project so public visitors never see it.

### 9. Verify server-side execution

1. Call `/api/engine/patch` with a known source URL.
2. Confirm the response `output.url` is a **Blob** URL (not a client-generated file).
3. Open Network tab: processing request goes to your Vercel API host, not a local Worker/Wasm on the phone.
4. `GET /api/health` → `engine.patch.version` should be `7`.

---

## Free-tier limits (read this)

| Resource | Practical limit |
|----------|------------------|
| Vercel Function duration | Hobby ~10s default; this project sets `maxDuration: 60` (Pro feature on some plans — lower if deploy fails) |
| Function memory | 1024 MB configured; large MP4s may OOM |
| Upload size | Cap with `MAX_UPLOAD_BYTES` (default 80 MB) |
| Vercel Blob | Free tier storage + bandwidth quotas — check current Vercel pricing page |
| Rate limit | In-memory only; resets on cold start |

If a deploy rejects `maxDuration: 60`, edit `vercel.json` to `10` or `30`.

For **real** compression (CRF, scale, fps), add a free FFmpeg worker (Fly.io / Railway) and set `FFMPEG_WORKER_URL`. The `compress` endpoint already supports `options.mode = "transcode"`.

---

## Local development

```bash
npm install
cp .env.example .env
# fill ENGINE_API_KEY and optionally BLOB_READ_WRITE_TOKEN
npx vercel dev
```

---

## Security checklist

- [x] Bearer API key required (not CORS-only)
- [x] Origin allow-list
- [x] Upload size + MP4 magic (`ftyp`) validation
- [x] MIME checks
- [x] Soft rate limiting
- [x] Engine source private (server-only modules)
- [x] No secrets in frontend bundles
- [x] Arbitrary remote fetch only for caller-supplied `sourceUrl` after auth

---

## Expanding later

- Swap in-memory rate limits for Upstash Redis free tier
- Add Vercel Cron to purge expired job JSON + Blob results
- Attach Fly.io FFmpeg worker for true transcode
- Wire 1dleryu website “Cloud Patch” button to `/api/jobs`

---

## License / visibility

Private project. Keep the GitHub repository **private** so `lib/engine` implementation stays closed.
