require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { generateClip } = require('./videoGen');
const { stitchClips, applyTemplateOverlay, mixAudio, reframeOrientation } = require('./ffmpegPipeline');
const { updateProjectStatus, uploadFinishedVideo } = require('./lovableApi');

const app = express();

// Capture the raw body so we can verify Lovable's signature against the
// exact bytes they signed (parsed-then-restringified JSON won't match).
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * Lovable POSTs here when a user clicks "Create Project".
 * The payload carries everything needed — we never query the DB ourselves.
 */
app.post('/generate-video', (req, res) => {
  // Verify the request genuinely came from Lovable.
  const expected = crypto
    .createHmac('sha256', process.env.RENDER_WEBHOOK_SECRET)
    .update(req.rawBody || '')
    .digest('hex');
  const rawSig = req.headers['x-reelty-signature']  req.headers['x-signature']  '';
  const received = rawSig.startsWith('sha256=') ? rawSig.slice(7) : rawSig;

  if (!received || received !== expected) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const project = req.body;
  if (!project || !project.projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  // Respond immediately — generation takes minutes, don't hold the request open.
  res.json({ status: 'started', projectId: project.projectId });

  runPipeline(project).catch((err) => {
    console.error(`Pipeline failed for project ${project.projectId}:`, err);
    updateProjectStatus(project.projectId, {
      status: 'failed',
      errorMessage: err.message,
    }).catch((e) => console.error('Could not report failure to Lovable:', e.message));
  });
});

async function runPipeline(project) {
  const projectId = project.projectId;
  await updateProjectStatus(projectId, { status: 'processing' });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `proj-${projectId}-`));
  const clipsDir = path.join(workDir, 'clips');
  fs.mkdirSync(clipsDir);

  const clipPaths = [];
  const skippedPhotos = [];

  // 1. Generate one clip per photo, in order. Skip failures rather than
  // aborting the whole project (a single moderation rejection on one
  // photo shouldn't kill the video).
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
    throw new Error('All photos failed generation - nothing to stitch.');
  }

  // 2. Stitch clips together with crossfade transitions.
  const stitchedPath = path.join(workDir, 'stitched.mp4');
  await stitchClips(clipPaths, stitchedPath);

  // 3. Overlay the selected template (dynamic text, not baked images).
  const overlaidPath = path.join(workDir, 'overlaid.mp4');
  await applyTemplateOverlay(stitchedPath, overlaidPath, {
    style: project.templateStyle,
    title: project.templateTitle,
    address: project.address,
    price: project.price,
    beds: project.bedrooms,
    baths: project.bathrooms,
    cars: project.carSpaces,
    sizeM2: project.landSize,
    agentName: project.agentName,
  });

  // 4. Download the voiceover + music, then mix them in.
  const voiceoverPath = project.voiceoverUrl
    ? await downloadToTemp(project.voiceoverUrl, path.join(workDir, 'voiceover.mp3'))
    : null;
  const musicPath = project.musicUrl
    ? await downloadToTemp(project.musicUrl, path.join(workDir, 'music.mp3'))
    : null;

  const mixedPath = path.join(workDir, 'mixed.mp4');
  await mixAudio(overlaidPath, voiceoverPath, musicPath, mixedPath);

  // 5. Export in the orientation(s) chosen, upload each via Lovable's
  // signed upload endpoint.
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

  // 6. Tell Lovable it's done - Lovable sends the completion email.
  await updateProjectStatus(projectId, {
    status: 'ready',
    videoUrls: finalUrls,
    skippedPhotos,
  });

  fs.rmSync(workDir, { recursive: true, force: true });
}

async function downloadToTemp(url, outputPath) {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios.get(url, { responseType: 'stream' });
  response.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  return outputPath;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Video service listening on port ${PORT}`));
