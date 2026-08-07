require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { generateClip } = require('./lib/videoGen');
const { stitchClips, applyTemplateOverlay, mixAudio, reframeOrientation } = require('./lib/ffmpegPipeline');
const { uploadFinishedVideo, updateProjectStatus, fetchProject } = require('./lib/storage');

const app = express();
app.use(express.json());

// Simple shared-secret auth so only your Supabase Edge Function can call this.
app.use((req, res, next) => {
  const token = req.headers['x-service-token'];
  if (token !== process.env.SERVICE_AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Kick off generation. Call this from your Supabase Edge Function right
// after "Create Project" is clicked, passing just the project ID —
// this service reads everything else it needs from Supabase directly.
app.post('/generate-video', async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });

  // Respond immediately — generation takes minutes, don't hold the HTTP request open.
  res.json({ status: 'started', projectId });

  runPipeline(projectId).catch((err) => {
    console.error(`Pipeline failed for project ${projectId}:`, err);
    updateProjectStatus(projectId, { status: 'failed', error_message: err.message }).catch(() => {});
  });
});

async function runPipeline(projectId) {
  await updateProjectStatus(projectId, { status: 'processing' });

  const project = await fetchProject(projectId);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `proj-${projectId}-`));
  const clipsDir = path.join(workDir, 'clips');
  fs.mkdirSync(clipsDir);

  const clipPaths = [];
  const skippedPhotos = [];

  // 1. Generate one clip per photo, in order. Skip failures instead of
  // aborting the whole project (matches your known bathroom/mirror
  // moderation issue — one bad photo shouldn't kill the video).
  for (let i = 0; i < project.photos.length; i++) {
    const photo = project.photos[i];
    try {
      const clipPath = await generateClip({
        photoUrl: photo.url,
        photoSettings: photo.playgroundSettings || {},
        orientation: project.orientation === 'portrait' ? 'portrait' : 'landscape',
        outputDir: clipsDir,
        index: i,
      });
      clipPaths.push(clipPath);
    } catch (err) {
      console.warn(`Photo ${i} failed generation, skipping:`, err.message);
      skippedPhotos.push({ index: i, reason: err.message });
    }
  }

  if (clipPaths.length === 0) {
    throw new Error('All photos failed generation — nothing to stitch.');
  }

  // 2. Stitch clips with crossfade transitions.
  const stitchedPath = path.join(workDir, 'stitched.mp4');
  await stitchClips(clipPaths, stitchedPath);

  // 3. Overlay the selected template (dynamic text/icons, not baked images).
  const overlaidPath = path.join(workDir, 'overlaid.mp4');
  await applyTemplateOverlay(stitchedPath, overlaidPath, {
    style: project.template_style,
    title: project.template_title,
    address: project.address,
    price: project.price,
    beds: project.bedrooms,
    baths: project.bathrooms,
    cars: project.car_spaces,
    sizeM2: project.land_size,
    agentName: project.agent_name,
  });

  // 4. Mix voiceover + background music.
  const mixedPath = path.join(workDir, 'mixed.mp4');
  await mixAudio(overlaidPath, project.voiceover_audio_url_local, project.music_track_url_local, mixedPath);

  // 5. Export in the orientation(s) the user chose, upload each, save URLs.
  const finalUrls = {};
  const wantsLandscape = project.orientation === 'landscape' || project.orientation === 'both';
  const wantsPortrait = project.orientation === 'portrait' || project.orientation === 'both';

  if (wantsLandscape) {
    const landscapePath = path.join(workDir, 'final-landscape.mp4');
    await reframeOrientation(mixedPath, landscapePath, 'landscape');
    finalUrls.landscape = await uploadFinishedVideo(landscapePath, projectId, 'landscape');
  }
  if (wantsPortrait) {
    const portraitPath = path.join(workDir, 'final-portrait.mp4');
    await reframeOrientation(mixedPath, portraitPath, 'portrait');
    finalUrls.portrait = await uploadFinishedVideo(portraitPath, projectId, 'portrait');
  }

  // 6. Mark complete. A Supabase DB trigger/webhook on this status change
  // is what should fire the "your video is ready" email — see README.
  await updateProjectStatus(projectId, {
    status: 'ready',
    final_video_urls: finalUrls,
    skipped_photos: skippedPhotos,
  });

  // Clean up temp files.
  fs.rmSync(workDir, { recursive: true, force: true });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Video service listening on port ${PORT}`));
