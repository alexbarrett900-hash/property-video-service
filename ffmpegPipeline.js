const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const execAsync = util.promisify(exec);

async function stitchClips(clipPaths, outputPath, options) {
  options = options || {};
  const transitionDuration = options.transitionDuration || 0.6;
  const width = options.width || 1920;
  const height = options.height || 1080;

  if (clipPaths.length === 1) {
    await execAsync('cp "' + clipPaths[0] + '" "' + outputPath + '"');
    return outputPath;
  }

  const inputs = clipPaths.map(function (p) { return '-i "' + p + '"'; }).join(' ');

  // Normalise every clip first: same size, same pixel aspect, same fps.
  // xfade refuses to run unless all inputs match exactly.
  let filterChain = '';
  for (let i = 0; i < clipPaths.length; i++) {
    filterChain +=
      '[' + i + ':v]scale=' + width + ':' + height +
      ':force_original_aspect_ratio=decrease,pad=' + width + ':' + height +
      ':(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[n' + i + '];';
  }

  let lastLabel = '[n0]';
  let cumulativeOffset = 0;

  for (let i = 1; i < clipPaths.length; i++) {
    const nextLabel = i === clipPaths.length - 1 ? '[outv]' : '[v' + i + ']';
    const clipDuration = 4;
    cumulativeOffset += clipDuration - transitionDuration;
    filterChain +=
      lastLabel + '[n' + i + ']xfade=transition=fade:duration=' +
      transitionDuration + ':offset=' + cumulativeOffset + nextLabel + ';';
    lastLabel = nextLabel;
  }
  filterChain = filterChain.replace(/;$/, '');

  const cmd = 'ffmpeg -y ' + inputs + ' -filter_complex "' + filterChain +
    '" -map "[outv]" -c:v libx264 -pix_fmt yuv420p "' + outputPath + '"';
  await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  return outputPath;
}

async function applyTemplateOverlay(inputPath, outputPath, templateData) {
  const style = templateData.style;
  const address = templateData.address;
  const price = templateData.price;
  const beds = templateData.beds;
  const baths = templateData.baths;
  const cars = templateData.cars;
  const sizeM2 = templateData.sizeM2;

  let drawtextFilters;
  switch (style) {
    case 'bold-banner':
      drawtextFilters = [
        'drawbox=x=0:y=ih-160:w=iw:h=160:color=black@0.55:t=fill',
        "drawtext=text='" + escapeText(templateData.title || 'JUST LISTED') + "':fontcolor=white:fontsize=48:x=40:y=h-140",
        "drawtext=text='" + escapeText(address) + "':fontcolor=white:fontsize=24:x=40:y=h-70",
        "drawtext=text='" + escapeText(statsLine(beds, baths, cars, sizeM2)) + "':fontcolor=white:fontsize=24:x=w-tw-40:y=h-70",
      ].join(',');
      break;
    case 'minimal-focus':
      drawtextFilters = [
        "drawtext=text='" + escapeText(templateData.title || 'LISTED FOR SALE') + "':fontcolor=white:fontsize=32:x=(w-tw)/2:y=(h/2)-40:box=1:boxcolor=black@0.5:boxborderw=10",
        "drawtext=text='" + escapeText(address) + "':fontcolor=white:fontsize=20:x=(w-tw)/2:y=(h/2)+20:box=1:boxcolor=black@0.4:boxborderw=8",
      ].join(',');
      break;
    case 'modern-luxe':
      drawtextFilters = [
        "drawtext=text='" + escapeText(templateData.title || 'Just Listed') + "':fontcolor=white:fontsize=56:x=(w-tw)/2:y=(h/2)-80",
        "drawtext=text='" + escapeText(address) + "':fontcolor=white:fontsize=22:x=(w-tw)/2:y=(h/2)-10",
        "drawtext=text='" + escapeText(statsLine(beds, baths, cars, sizeM2)) + '    ' + escapeText(price || '') + "':fontcolor=white:fontsize=22:x=(w-tw)/2:y=(h/2)+40",
      ].join(',');
      break;
    default:
      drawtextFilters = [
        "drawtext=text='" + escapeText(templateData.title || 'Just Listed') + "':fontcolor=white:fontsize=52:x=(w-tw)/2:y=(h/2)-60",
        "drawtext=text='" + escapeText(address) + "':fontcolor=white:fontsize=20:x=(w-tw)/2:y=(h/2)+10",
        "drawtext=text='" + escapeText(statsLine(beds, baths, cars, sizeM2)) + "':fontcolor=white:fontsize=18:x=(w-tw)/2:y=(h/2)+50:box=1:boxcolor=black@0.4:boxborderw=6",
      ].join(',');
  }

  const cmd = 'ffmpeg -y -i "' + inputPath + '" -vf "' + drawtextFilters + '" -codec:a copy "' + outputPath + '"';
  await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  return outputPath;
}

async function mixAudio(videoPath, voiceoverPath, musicPath, outputPath) {
  if (!voiceoverPath && !musicPath) {
    await execAsync('cp "' + videoPath + '" "' + outputPath + '"');
    return outputPath;
  }

  if (voiceoverPath && musicPath) {
    const cmd = 'ffmpeg -y -i "' + videoPath + '" -i "' + voiceoverPath + '" -i "' + musicPath +
      '" -filter_complex "[2:a]volume=0.2[music];[1:a][music]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -shortest "' + outputPath + '"';
    await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  } else {
    const audioPath = voiceoverPath || musicPath;
    const volume = voiceoverPath ? 1.0 : 0.5;
    const cmd = 'ffmpeg -y -i "' + videoPath + '" -i "' + audioPath +
      '" -filter_complex "[1:a]volume=' + volume + '[aout]" -map 0:v -map "[aout]" -c:v copy -shortest "' + outputPath + '"';
    await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  }
  return outputPath;
}

async function reframeOrientation(inputPath, outputPath, targetOrientation) {
  const filter =
    targetOrientation === 'portrait'
      ? 'crop=ih*9/16:ih,scale=1080:1920'
      : 'crop=iw:iw*9/16,scale=1920:1080';
  const cmd = 'ffmpeg -y -i "' + inputPath + '" -vf "' + filter + '" -c:a copy "' + outputPath + '"';
  await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  return outputPath;
}

function statsLine(beds, baths, cars, sizeM2) {
  const parts = [];
  if (beds != null) parts.push(beds + ' bed');
  if (baths != null) parts.push(baths + ' bath');
  if (cars != null) parts.push(cars + ' car');
  if (sizeM2 != null) parts.push(sizeM2 + 'm2');
  return parts.join(' - ');
}

function escapeText(str) {
  if (str == null) str = '';
  return String(str).replace(/'/g, "\\'").replace(/:/g, '\\:');
}

module.exports = {
  stitchClips,
  applyTemplateOverlay,
  mixAudio,
  reframeOrientation,
};
