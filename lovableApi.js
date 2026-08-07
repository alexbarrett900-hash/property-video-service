const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

/**
 * Talks to Lovable's secured public API endpoints instead of reaching
 * into the database directly (Lovable Cloud doesn't expose DB credentials
 * to external services — this is the supported path).
 *
 * Every request is signed with a shared secret so Lovable can verify it
 * genuinely came from this service.
 */

function signPayload(bodyString) {
  return crypto
    .createHmac('sha256', process.env.RENDER_WEBHOOK_SECRET)
    .update(bodyString)
    .digest('hex');
}

async function postSigned(url, payload) {
  const bodyString = JSON.stringify(payload);
  const signature = signPayload(bodyString);

  const response = await axios.post(url, bodyString, {
    headers: {
      'Content-Type': 'application/json',
      'x-signature': signature,
    },
  });
  return response.data;
}

/** Tells Lovable the project's status changed (processing / ready / failed). */
async function updateProjectStatus(projectId, updates) {
  return postSigned(process.env.LOVABLE_STATUS_CALLBACK_URL, {
    projectId,
    ...updates,
  });
}

/** Asks Lovable for a signed URL we can upload a finished video file to. */
async function getUploadUrl(projectId, orientation) {
  const result = await postSigned(process.env.LOVABLE_UPLOAD_URL_ENDPOINT, {
    projectId,
    filename: `final-${orientation}.mp4`,
    contentType: 'video/mp4',
  });
  // Lovable returns the signed URL to PUT the file to, plus the eventual
  // public URL of the stored file.
  return result;
}

/** Uploads a finished video file to the signed URL Lovable issued. */
async function uploadFinishedVideo(localPath, projectId, orientation) {
  const { uploadUrl, publicUrl } = await getUploadUrl(projectId, orientation);

  const fileBuffer = fs.readFileSync(localPath);
  await axios.put(uploadUrl, fileBuffer, {
    headers: { 'Content-Type': 'video/mp4' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return publicUrl;
}

module.exports = { updateProjectStatus, uploadFinishedVideo };
