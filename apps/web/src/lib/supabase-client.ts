import { createClient as createSupabaseClient } from '@supabase/supabase-js';

function getSupabaseConfig() {
  if (typeof window !== 'undefined') {
    return {
      url: (window as any).__SUPABASE_URL__ || '',
      key: (window as any).__SUPABASE_KEY__ || '',
    };
  }
  return { url: '', key: '' };
}

export function createClient() {
  const { url, key } = getSupabaseConfig();
  return createSupabaseClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}
