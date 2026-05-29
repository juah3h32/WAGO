function getApiUrl() {
  let url = "";
  if (typeof window !== 'undefined' && (window as any).__API_URL__) {
    url = (window as any).__API_URL__;
  } else {
    const envUrl = import.meta.env.PUBLIC_API_URL;
    if (envUrl && envUrl !== "undefined" && envUrl !== "") {
      url = envUrl;
    } else if (typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      if (hostname.includes('recursomusical.com.mx')) {
        url = "https://api.recursomusical.com.mx";
      } else if (hostname.includes('localhost') || hostname.includes('127.0.0.1')) {
        url = "http://localhost:3001";
      }
    }
  }
  
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    console.log("[API] Using API URL:", url || "(empty, using relative paths)");
  }
  return url;
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
    let message = body || `API error ${res.status}`;
    try {
      const json = JSON.parse(body);
      if (json.message) {
        message = Array.isArray(json.message) ? json.message[0] : json.message;
      }
    } catch {
      // Not JSON, keep original body/message
    }
    throw new Error(message);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
