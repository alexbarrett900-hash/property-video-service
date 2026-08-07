# Property Video Generation Service

This is the one piece of your product Lovable/Supabase can't build on its own —
the actual video pipeline: generate clips → stitch → overlay template → mix
audio → upload finished video. It runs as its own small server, separate
from your Lovable site.

## What you need before this works

1. **A Supabase Storage bucket** called `project-videos` (create it in your
   Supabase dashboard → Storage → New bucket → make it public, or set up
   signed URLs if you'd rather keep videos private).
2. **A `projects` table in Supabase** with (at minimum) these columns:
   `id, photos (jsonb), orientation, template_style, template_title, address,
   price, bedrooms, bathrooms, car_spaces, land_size, agent_name,
   voiceover_audio_url_local, music_track_url_local, status, error_message,
   final_video_urls (jsonb), skipped_photos (jsonb)`.
   Your Step 1–8 wizard should already be writing most of this — this
   service just reads it.
3. **API keys** — fal.ai or Wavespeed (video generation), and your
   Supabase service role key (Settings → API in Supabase, NOT the anon key).
4. **Icon assets** for bed/bath/car icons if you want them as real icons
   rather than text — grab simple ones from Lucide (already MIT-licensed,
   free to use) and reference their file paths in `ffmpegPipeline.js`.

## Local setup

```bash
npm install
cp .env.example .env
# fill in .env with your real keys
npm start
```

You'll also need `ffmpeg` installed on whatever machine/server runs this —
it's not an npm package, it's a system tool. Render and Railway both support
installing it via a build step (see deployment below).

## Deploying (Render example)

1. Push this folder to its own GitHub repo (separate from your Lovable
   project — this is backend infrastructure, not part of the website code).
2. In Render: New → Web Service → connect the repo.
3. Environment: Node.
4. Build command: `apt-get update && apt-get install -y ffmpeg && npm install`
5. Start command: `npm start`
6. Add all the variables from `.env.example` as Render environment variables
   (never commit your real `.env` file to the repo).
7. Once deployed, Render gives you a URL like `https://your-service.onrender.com`
   — that's what Supabase will call.

Railway works almost identically — same build/start commands, same env vars.

## Wiring it to Supabase (the part that connects everything)

In Supabase, create an **Edge Function** called `trigger-video-generation`:

```js
// supabase/functions/trigger-video-generation/index.ts
Deno.serve(async (req) => {
  const { projectId } = await req.json();

  const response = await fetch('https://your-service.onrender.com/generate-video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-service-token': Deno.env.get('SERVICE_AUTH_TOKEN'),
    },
    body: JSON.stringify({ projectId }),
  });

  return new Response(await response.text(), { status: response.status });
});
```

Set `SERVICE_AUTH_TOKEN` as a secret in Supabase (Edge Functions → Secrets)
matching the same value you put in this service's `.env` — this stops
random people from hitting your video-generation endpoint and running up
your API bill.

**In Lovable:** the "Create Project" button's click handler should call
this Edge Function (Lovable's Supabase integration lets you invoke Edge
Functions directly from the frontend) right after saving the project record,
passing the new project's ID.

## Triggering the "your video is ready" email

Set up a **Postgres trigger** (or a Supabase Realtime subscription in the
frontend) that fires when a project's `status` column changes to `'ready'`.
The cleanest way: a database trigger that calls another small Edge Function
to send the email via Resend, Postmark, or whatever email provider Lovable
set up for you already.

## Known limitations / things to revisit

- The `stitchClips` function assumes ~5-second clips for transition timing —
  if your clips vary in length, probe each one's real duration with
  `ffprobe` first rather than hardcoding `clipDuration = 5`.
- The fal.ai/Wavespeed request payloads in `videoGen.js` are written to the
  *general shape* of their APIs — check their current docs for the exact
  model endpoint and parameter names before running this for real, since
  those details change and I couldn't verify them live against your account.
- No retry logic yet — a flaky network call currently just fails that photo.
  Worth adding 1–2 retries before giving up on a clip.
- No cost/credit-limit guard in this service itself — make sure the credit
  check happens in Supabase *before* this service is called, not after.
