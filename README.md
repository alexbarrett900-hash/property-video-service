# Property Video Generation Service

External video pipeline for the Lovable property video app.
Lovable pushes project data here; this service generates the video and
pushes the result back through Lovable's secured public API.

## Architecture

Lovable Cloud does not expose database credentials to external services,
so this service never touches the database directly:

1. User clicks "Create Project" in the app
2. Lovable POSTs the full project payload to this service at `/generate-video`,
   signed with a shared secret
3. This service generates clips, stitches, overlays, mixes audio
4. It requests a signed upload URL from Lovable and uploads the finished video
5. It calls Lovable's status endpoint with `status: ready` and the video URLs
6. Lovable updates the project and sends the completion email

## Environment variables (set these in Render)

| Variable | Value |
|---|---|
| `RENDER_WEBHOOK_SECRET` | The same 64-char hex string given to Lovable |
| `LOVABLE_STATUS_CALLBACK_URL` | Lovable's `/api/public/project-status` URL |
| `LOVABLE_UPLOAD_URL_ENDPOINT` | Lovable's `/api/public/render-upload-url` URL |
| `VIDEO_PROVIDER` | `fal` or `wavespeed` |
| `FAL_API_KEY` | Your fal.ai API key |
| `PORT` | Render sets this automatically |

## Render settings

- Build Command: `npm install`
- Start Command: `node server.js`
- ffmpeg must be available. If Render's Node environment doesn't include it,
  switch the service to Docker and use a base image with ffmpeg installed.

## Testing it's alive

`GET https://your-service.onrender.com/health` should return `{"ok":true}`.

An unsigned POST to `/generate-video` should return 401 - that confirms
signature verification is working.

## Still to verify before real use

- The exact fal.ai / Wavespeed model endpoint and parameter names in
  `lib/videoGen.js` are written to the general shape of their APIs -
  confirm against their current docs.
- `stitchClips` assumes 4-second clips for crossfade timing. If clip
  lengths vary, probe each with ffprobe instead of the hardcoded value.
- The exact field names Lovable sends in its webhook payload (photos,
  orientation, templateStyle etc.) should be checked against what Lovable
  actually posts - adjust `runPipeline` in server.js to match.
- No retry logic yet; a flaky network call fails that one photo.
