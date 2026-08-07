const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const execAsync = util.promisify(exec);

/**
 * Stitches an ordered array of clip file paths into one video with
 * crossfade transitions between each. Uses ffmpeg's xfade filter,
 * matching the workflow you already use manually.
 */
async function stitchClips(clipPaths, outputPath, { transitionDuration = 0.6 } = {}) {
  if (clipPaths.length === 1) {
    await execAsync(`cp "${clipPaths[0]}" "${outputPath}"`);
    return outputPath;
  }

  // Build an xfade filter chain: clip0 -> xfade -> clip1 -> xfade -> clip2 ...
  const inputs = clipPaths.map((p) => `-i "${p}"`).join(' ');
  let filterChain = '';
  let lastLabel = '[0:v]';
  let cumulativeOffset = 0;

  for (let i = 1; i < clipPaths.length; i++) {
    const nextLabel = i === clipPaths.length - 1 ? '[outv]' : `[v${i}]`;
    // NOTE: offset should be the duration of the previous clip minus the
    // transition overlap. Clips are trimmed to 4s each (see videoGen.js
    // TARGET_DURATION_SECONDS) — update this if you change that value.
    const clipDuration = 4;
    cumulativeOffset += clipDuration - transitionDuration;
    filterChain += `${lastLabel}[${i}:v]xfade=transition=fade:duration=${transitionDuration}:offset=${cumulativeOffset}${nextLabel};`;
    lastLabel = nextLabel;
  }
  filterChain = filterChain.replace(/;$/, '');

  const cmd = `ffmpeg -y ${inputs} -filter_complex "${filterChain}" -map "[outv]" -c:v libx264 -pix_fmt yuv420p "${outputPath}"`;
  await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  return outputPath;
}

/**
 * Overlays the selected template's text/icons on top of the stitched
 * video — the "dynamic overlay" approach from the Lovable spec, so no
 * pre-made template images are needed. Icons must exist as small PNG
 * files on disk (bed/bath/car icons) — ship these as static assets
 * alongside this service, they're generic icons, not scraped content.
 */
async function applyTemplateOverlay(inputPath, outputPath, templateData) {
  const { style, address, price, beds, baths, cars, sizeM2, agentName } = templateData;

  // Each style just changes font size/position/color — same underlying
  // drawtext approach for all four. Add more `case`s as you add templates.
  let drawtextFilters;
  switch (style) {
    case 'bold-banner':
      drawtextFilters = [
        `drawbox=x=0:y=ih-160:w=iw:h=160:color=black@0.55:t=fill`,
        `drawtext=text='${escapeText(templateData.title || 'JUST LISTED')}':fontcolor=white:fontsize=48:x=40:y=h-140:font=sans-serif-bold`,
        `drawtext=text='${escapeText(address)}':fontcolor=white:fontsize=24:x=40:y=h-70`,
        `drawtext=text='${escapeText(statsLine(beds, baths, cars, sizeM2))}':fontcolor=white:fontsize=24:x=w-tw-40:y=h-70`,
      ].join(',');
      break;
    case 'minimal-focus':
      drawtextFilters = [
        `drawtext=text='${escapeText(templateData.title || 'LISTED FOR SALE')}':fontcolor=white:fontsize=32:x=(w-tw)/2:y=(h/2)-40:box=1:boxcolor=black@0.5:boxborderw=10`,
        `drawtext=text='${escapeText(address)}':fontcolor=white:fontsize=20:x=(w-tw)/2:y=(h/2)+20:box=1:boxcolor=black@0.4:boxborderw=8`,
      ].join(',');
      break;
    case 'modern-luxe':
      drawtextFilters = [
        `drawtext=text='${escapeText(templateData.title || 'Just Listed')}':fontcolor=white:fontsize=56:x=(w-tw)/2:y=(h/2)-80:font=sans-serif`,
        `drawtext=text='${escapeText(address)}':fontcolor=white:fontsize=22:x=(w-tw)/2:y=(h/2)-10`,
        `drawtext=text='${escapeText(statsLine(beds, baths, cars, sizeM2))}    ${escapeText(price || '')}':fontcolor=white:fontsize=22:x=(w-tw)/2:y=(h/2)+40`,
      ].join(',');
      break;
    default: // 'elegant-classic'
      drawtextFilters = [
        `drawtext=text='${escapeText(templateData.title || 'Just Listed')}':fontcolor=white:fontsize=52:x=(w-tw)/2:y=(h/2)-60:font=serif`,
        `drawtext=text='${escapeText(address)}':fontcolor=white:fontsize=20:x=(w-tw)/2:y=(h/2)+10`,
        `drawtext=text='${escapeText(statsLine(beds, baths, cars, sizeM2))}':fontcolor=white:fontsize=18:x=(w-tw)/2:y=(h/2)+50:box=1:boxcolor=black@0.4:boxborderw=6`,
      ].join(',');
  }

  const cmd = `ffmpeg -y -i "${inputPath}" -vf "${drawtextFilters}" -codec:a copy "${outputPath}"`;
  await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  return outputPath;
}

/**
 * Mixes voiceover (foreground) with background music (ducked lower)
 * onto the final video.
 */
async function mixAudio(videoPath, voiceoverPath, musicPath, outputPath) {
  if (!voiceoverPath && !musicPath) {
    await execAsync(`cp "${videoPath}" "${outputPath}"`);
    return outputPath;
  }

  if (voiceoverPath && musicPath) {
    // Music ducked to ~20% volume under the voiceover
    const cmd = `ffmpeg -y -i "${videoPath}" -i "${voiceoverPath}" -i "${musicPath}" -filter_complex "[2:a]volume=0.2[music];[1:a][music]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -shortest "${outputPath}"`;
    await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  } else {
    const audioPath = voiceoverPath || musicPath;
    const volume = voiceoverPath ? 1.0 : 0.5;
    const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -filter_complex "[1:a]volume=${volume}[aout]" -map 0:v -map "[aout]" -c:v copy -shortest "${outputPath}"`;
    await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  }
  return outputPath;
}

/** Re-exports the same video in the other orientation via center-crop. */
async function reframeOrientation(inputPath, outputPath, targetOrientation) {
  const filter =
    targetOrientation === 'portrait'
      ? `crop=ih*9/16:ih,scale=1080:1920`
      : `crop=iw:iw*9/16,scale=1920:1080`;
  const cmd = `ffmpeg -y -i "${inputPath}" -vf "${filter}" -c:a copy "${outputPath}"`;
  await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  return outputPath;
}

function statsLine(beds, baths, cars, sizeM2) {
  const parts = [];
  if (beds != null) parts.push(`${beds} bed`);
  if (baths != null) parts.push(`${baths} bath`);
  if (cars != null) parts.push(`${cars} car`);
  if (sizeM2 != null) parts.push(`${sizeM2}m²`);
  return parts.join(' · ');
}

function escapeText(str = '') {
  return String(str).replace(/'/g, "\\'").replace(/:/g, '\\:');
}

module.exports = {
  stitchClips,
  applyTemplateOverlay,
  mixAudio,
  reframeOrientation,
};
