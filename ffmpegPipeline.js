const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const execAsync = util.promisify(exec);

const FONT_BOLD = path.join(__dirname, 'PlusJakartaSans-Bold.ttf');
const FONT_REG = path.join(__dirname, 'PlusJakartaSans-Regular.ttf');

async function getDuration(filePath) {
  const cmd = 'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + filePath + '"';
  const res = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });
  const seconds = parseFloat(String(res.stdout).trim());
  if (!seconds || isNaN(seconds)) return 20;
  return seconds;
}

function fadeAlpha(start, end, fade) {
  const a = start.toFixed(2);
  const b = (start + fade).toFixed(2);
  const c = (end - fade).toFixed(2);
  const d = end.toFixed(2);
  const f = fade.toFixed(2);
  return "if(lt(t," + a + "),0,if(lt(t," + b + "),(t-" + a + ")/" + f +
    ",if(lt(t," + c + "),1,if(lt(t," + d + "),(" + d + "-t)/" + f + ",0))))";
}

function textLayer(fontFile, text, size, yExpr, alphaExpr) {
  if (!text) return null;
  return "drawtext=fontfile='" + fontFile + "':text='" + escapeText(text) +
    "':fontcolor=white:fontsize=" + size + ":x=(w-tw)/2:y=" + yExpr +
    ":shadowcolor=black@0.6:shadowx=2:shadowy=2:alpha='" + alphaExpr + "'";
}

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
  const d = templateData || {};
  const total = await getDuration(inputPath);
  const slot = total / 5;
  const fade = Math.min(0.6, slot * 0.25);
  const pad = slot * 0.08;

  const street = d.address || d.streetAddress || '';
  const cityLine = [d.suburb || d.city, d.state].filter(Boolean).join(', ');
  const sizeText = d.landSize ? String(d.landSize) + ' ' + (d.landSizeUnit || 'm2') : '';
  const locationSecond = [cityLine, sizeText].filter(Boolean).join('  -  ');
  const stats = statsLine(d.beds, d.baths, d.cars);
  const agentName = d.agentName || '';
  const agency = d.agency || '';
  const price = d.price ? String(d.price) : '';

  const layers = [];

  function slotRange(i) {
    return { s: i * slot + pad, e: (i + 1) * slot - pad };
  }

  // 1 - headline
  let r = slotRange(0);
  let a = fadeAlpha(r.s, r.e, fade);
  layers.push(textLayer(FONT_BOLD, (d.title || 'JUST LISTED').toUpperCase(), 'h/16', 'h*0.44', a));
  layers.push("drawbox=x=iw*0.28:y=ih*0.44+ih/16*1.5:w=iw*0.44:h=2:color=white@0.85:t=fill:enable='between(t," +
    r.s.toFixed(2) + "," + r.e.toFixed(2) + ")'");

  // 2 - location
  r = slotRange(1);
  a = fadeAlpha(r.s, r.e, fade);
  layers.push(textLayer(FONT_BOLD, street, 'h/26', 'h*0.45', a));
  layers.push(textLayer(FONT_REG, locationSecond, 'h/38', 'h*0.52', a));

  // 3 - stats
  r = slotRange(2);
  a = fadeAlpha(r.s, r.e, fade);
  layers.push(textLayer(FONT_REG, stats, 'h/28', 'h*0.47', a));

  // 4 - agent
  r = slotRange(3);
  a = fadeAlpha(r.s, r.e, fade);
  layers.push(textLayer(FONT_BOLD, agentName, 'h/28', 'h*0.45', a));
  layers.push(textLayer(FONT_REG, agency, 'h/38', 'h*0.52', a));

  // 5 - price
  r = slotRange(4);
  a = fadeAlpha(r.s, r.e, fade);
  layers.push(textLayer(FONT_BOLD, price, 'h/18', 'h*0.46', a));

  const filters = layers.filter(Boolean).join(',');

  if (!filters) {
    await execAsync('cp "' + inputPath + '" "' + outputPath + '"');
    return outputPath;
  }

  const cmd = 'ffmpeg -y -i "' + inputPath + '" -vf "' + filters +
    '" -c:v libx264 -pix_fmt yuv420p -c:a copy "' + outputPath + '"';
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

function statsLine(beds, baths, cars) {
  const parts = [];
  if (beds != null) parts.push(beds + ' bed');
  if (baths != null) parts.push(baths + ' bath');
  if (cars != null) parts.push(cars + ' car');
  return parts.join('   -   ');
}

function escapeText(str) {
  if (str == null) str = '';
  return String(str).replace(/\\/g, '').replace(/'/g, '').replace(/:/g, '\\:').replace(/%/g, '');
}

module.exports = {
  stitchClips,
  applyTemplateOverlay,
  mixAudio,
  reframeOrientation,
};
