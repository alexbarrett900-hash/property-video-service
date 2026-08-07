const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Maps the Playground "shot type" selection to a motion prompt.
// Keys match the button values Lovable should save when the user picks
// a shot type on each photo (Photo 02/04 style screen).
// NOTE: motion is worded at a NATURAL pace that completes by second 4,
// then holds still — rushing the full motion into 3s previously caused
// the model to hallucinate new areas beyond the source photo to keep up.
// Giving it a clean stop point avoids that.
const SHOT_TYPE_PROMPTS = {
  'dolly-in': 'Camera gliding forward into the room on smooth rails, continuous push-in toward the far end of the space, motion completing by the fourth second and then holding completely still, weightless cinematic motion, no walking or handheld camera shake.',
  'truck-right': 'Camera gliding sideways to the right on rails, steady lateral tracking motion across the room, motion completing by the fourth second and then holding completely still, weightless cinematic motion, no walking or handheld camera shake.',
  'truck-left': 'Camera gliding sideways to the left on rails, steady lateral tracking motion across the room, motion completing by the fourth second and then holding completely still, weightless cinematic motion, no walking or handheld camera shake.',
  'crane-up': 'Camera rising upward on a crane, revealing the space from a higher elevated angle, motion completing by the fourth second and then holding completely still, weightless cinematic motion, no walking or handheld camera shake.',
  // Confirmed working wording (visual-description style, tested and
  // verified to produce the correct direction — the earlier "arcing
  // rightward/leftward" mechanical phrasing was unreliable on this model).
  'arc-right': 'Wide shot slowly rotating so that new parts of the room become visible on the right side of frame, smooth orbiting motion, motion completing by the fourth second and then holding completely still, weightless cinematic motion, no walking or handheld camera shake.',
  'arc-left': 'Wide shot slowly rotating so that new parts of the room become visible on the left side of frame, smooth orbiting motion, motion completing by the fourth second and then holding completely still, weightless cinematic motion, no walking or handheld camera shake.',
  default: 'Camera gliding smoothly on rails through the space, motion completing by the fourth second and then holding completely still, weightless cinematic motion, no walking or handheld camera shake.',
};

// Kling on fal/Wavespeed only accepts fixed durations — 5s is the
// cheapest tier. We request 5s, let the motion finish naturally by
// second 4 (per the prompt wording above), then trim off the leftover
// still-frame tail so clips land at 4s instead of paying for/keeping 5s.
const GENERATED_DURATION_SECONDS = 5;
const TARGET_DURATION_SECONDS = 4;

// Applied to every generation regardless of shot type — covers the
// recurring failure modes (furniture drifting, inconsistent pacing,
// warping) reported when testing real clips.
const NEGATIVE_PROMPT = 'Furniture moving, shifting, or floating; objects warping or morphing; inconsistent or jittery motion speed; sudden speed changes; walls or floors bending or warping; flickering or ghosting; blurring; camera shake; extra or duplicated objects; extra or distorted limbs or people; unnatural reflections; changing lighting or color shifts mid-clip; added text, watermarks, or logos; low quality, distorted, unrealistic.';

function buildPrompt(photoSettings) {
  const base = SHOT_TYPE_PROMPTS[photoSettings.shotType] || SHOT_TYPE_PROMPTS.default;
  const staging = photoSettings.virtualStaging
    ? ' Room is realistically furnished and staged.'
    : '';
  const actors = photoSettings.aiActors
    ? ' Include a natural, realistic person or family lightly present in the scene.'
    : '';
  return `Cinematic real estate walkthrough shot. ${base}.${staging}${actors}`;
}

/**
 * Submits one photo for video generation and returns the finished clip's
 * local file path once ready. Handles both fal.ai and Wavespeed depending
 * on VIDEO_PROVIDER — swap providers per-photo here if you want automatic
 * fallback (e.g. Wavespeed for bathroom/mirror shots that trip moderation
 * on other providers, per your own prior finding).
 *
 * Always generates Kling's cheapest 5s duration, then trims to 3s — see
 * TARGET_DURATION_SECONDS above.
 */
async function generateClip({ photoUrl, photoSettings, orientation, outputDir, index }) {
  const provider = process.env.VIDEO_PROVIDER || 'fal';
  const prompt = buildPrompt(photoSettings);
  const aspectRatio = orientation === 'portrait' ? '9:16' : '16:9';

  let resultVideoUrl;

  if (provider === 'fal') {
    resultVideoUrl = await generateWithFal({ photoUrl, prompt, negativePrompt: NEGATIVE_PROMPT, aspectRatio, duration: GENERATED_DURATION_SECONDS });
  } else if (provider === 'wavespeed') {
    resultVideoUrl = await generateWithWavespeed({ photoUrl, prompt, negativePrompt: NEGATIVE_PROMPT, aspectRatio, duration: GENERATED_DURATION_SECONDS });
  } else {
    throw new Error(`Unknown VIDEO_PROVIDER: ${provider}`);
  }

  const rawPath = path.join(outputDir, `clip-${index}-raw.mp4`);
  await downloadFile(resultVideoUrl, rawPath);

  const trimmedPath = path.join(outputDir, `clip-${index}.mp4`);
  await trimClip(rawPath, trimmedPath, TARGET_DURATION_SECONDS);

  return trimmedPath;
}

/** Cuts a clip down to targetSeconds from the start, keeping audio in sync. */
async function trimClip(inputPath, outputPath, targetSeconds) {
  const { exec } = require('child_process');
  const util = require('util');
  const execAsync = util.promisify(exec);
  // -c copy would be faster but can misalign on some codecs from these
  // providers; re-encoding here keeps the cut frame-accurate.
  const cmd = `ffmpeg -y -i "${inputPath}" -t ${targetSeconds} -c:v libx264 -pix_fmt yuv420p -c:a aac "${outputPath}"`;
  await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  return outputPath;
}

async function generateWithFal({ photoUrl, prompt, negativePrompt, aspectRatio, duration }) {
  // NOTE: adjust the model endpoint/payload shape to whichever fal.ai
  // Kling 2.6 endpoint you're using — check fal.ai's docs for the exact
  // model path and confirm the correct field name for negative prompt
  // (Kling typically uses "negative_prompt") before running live.
  const submitRes = await axios.post(
    'https://queue.fal.run/fal-ai/kling-video/v2.6/YOUR-CHOSEN-MODEL',
    {
      image_url: photoUrl,
      prompt,
      negative_prompt: negativePrompt,
      aspect_ratio: aspectRatio,
      duration, // 5 — Kling's cheapest tier; we trim to 4s after download
    },
    { headers: { Authorization: `Key ${process.env.FAL_API_KEY}` } }
  );

  const statusUrl = submitRes.data.status_url;
  const responseUrl = submitRes.data.response_url;

  // Poll until the job is done
  let done = false;
  while (!done) {
    await sleep(4000);
    const statusRes = await axios.get(statusUrl, {
      headers: { Authorization: `Key ${process.env.FAL_API_KEY}` },
    });
    if (statusRes.data.status === 'COMPLETED') done = true;
    if (statusRes.data.status === 'FAILED') {
      throw new Error('fal.ai generation failed for this photo');
    }
  }

  const finalRes = await axios.get(responseUrl, {
    headers: { Authorization: `Key ${process.env.FAL_API_KEY}` },
  });
  return finalRes.data.video.url;
}

async function generateWithWavespeed({ photoUrl, prompt, negativePrompt, aspectRatio, duration }) {
  // Same general pattern — adjust to Wavespeed's actual endpoint/payload
  // and confirm their negative-prompt field name for Kling 2.6.
  const submitRes = await axios.post(
    'https://api.wavespeed.ai/v1/video/generate',
    { image_url: photoUrl, prompt, negative_prompt: negativePrompt, aspect_ratio: aspectRatio, duration },
    { headers: { Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}` } }
  );

  const jobId = submitRes.data.id;
  let done = false;
  let videoUrl;
  while (!done) {
    await sleep(4000);
    const statusRes = await axios.get(
      `https://api.wavespeed.ai/v1/video/status/${jobId}`,
      { headers: { Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}` } }
    );
    if (statusRes.data.status === 'completed') {
      done = true;
      videoUrl = statusRes.data.video_url;
    }
    if (statusRes.data.status === 'failed') {
      throw new Error('Wavespeed generation failed for this photo');
    }
  }
  return videoUrl;
}

async function downloadFile(url, outputPath) {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios.get(url, { responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { generateClip };
