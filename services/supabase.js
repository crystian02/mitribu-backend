const { createClient } = require('@supabase/supabase-js');

// Cambiamos SUPABASE_KEY por SUPABASE_SERVICE_ROLE
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE // <--- Esta es la llave "maestra" para el backend
);

module.exports = supabase;