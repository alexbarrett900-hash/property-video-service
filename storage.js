const fs = require('fs');
const { supabase } = require('./supabaseClient');

const BUCKET = 'project-videos'; // create this bucket in Supabase Storage first

async function uploadFinishedVideo(localPath, projectId, orientation) {
  const fileBuffer = fs.readFileSync(localPath);
  const storagePath = `${projectId}/final-${orientation}.mp4`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: 'video/mp4',
      upsert: true,
    });

  if (error) throw new Error(`Upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

async function updateProjectStatus(projectId, updates) {
  const { error } = await supabase
    .from('projects')
    .update(updates)
    .eq('id', projectId);
  if (error) throw new Error(`Failed to update project status: ${error.message}`);
}

async function fetchProject(projectId) {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (error) throw new Error(`Failed to fetch project: ${error.message}`);
  return data;
}

module.exports = { uploadFinishedVideo, updateProjectStatus, fetchProject };
