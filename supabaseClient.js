const { createClient } = require('@supabase/supabase-js');

// Service-role client: can read/write ANY row and storage bucket.
// This file is only ever used server-side (never sent to the browser).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = { supabase };
