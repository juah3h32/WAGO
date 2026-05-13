import { createClient as createSupabaseClient, SupabaseClient } from '@supabase/supabase-js';

function getSupabaseConfig() {
  if (typeof window !== 'undefined') {
    return {
      url: (window as any).__SUPABASE_URL__ || '',
      key: (window as any).__SUPABASE_KEY__ || '',
    };
  }
  return { url: '', key: '' };
}

let supabaseInstance: SupabaseClient | null = null;

export function createClient() {
  if (supabaseInstance) return supabaseInstance;

  const { url, key } = getSupabaseConfig();
  
  if (!url || !key) {
    // If we're on the server or config is missing, return a dummy client or throw
    // In this app, we rely on the window.__SUPABASE_* injected in BaseLayout
    return createSupabaseClient(url || 'https://placeholder.supabase.co', key || 'placeholder');
  }

  supabaseInstance = createSupabaseClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  
  return supabaseInstance;
}

