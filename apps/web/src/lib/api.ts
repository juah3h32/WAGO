function getApiUrl() {
  if (typeof window !== 'undefined' && (window as any).__API_URL__) {
    return (window as any).__API_URL__;
  }
  return "http://localhost:3001";
}
const API_URL = getApiUrl();

// Singleton Supabase client to avoid "Multiple GoTrueClient instances" warning
let _clientPromise: Promise<any> | null = null;
function getSupabaseClient() {
  if (!_clientPromise) {
    _clientPromise = import("./supabase-client").then((m) => m.createClient());
  }
  return _clientPromise;
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const supabase = await getSupabaseClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Not authenticated");
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...options.headers,
    },
  });

  if (res.status === 401) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData.session?.access_token) {
      throw new Error("Session expired");
    }
    const retry = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshData.session.access_token}`,
        ...options.headers,
      },
    });
    if (retry.ok) {
      const text = await retry.text();
      return text ? JSON.parse(text) : null;
    }
    throw new Error("Session expired");
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `API error ${res.status}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
