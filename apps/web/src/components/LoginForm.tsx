import { useState } from 'react';
import { createClient } from '../lib/supabase-client';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const sp = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const redirect = sp?.get('redirect');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    // Set cookies so the Astro middleware sees the authenticated session
    if (data.session) {
      const { access_token, refresh_token } = data.session;
      document.cookie = `sb-access-token=${access_token}; path=/; max-age=86400; SameSite=Lax`;
      document.cookie = `sb-refresh-token=${refresh_token}; path=/; max-age=86400; SameSite=Lax`;
    }

    window.location.href = redirect || '/dashboard/connections';
  }

  return (
    <div className="w-full max-w-md">
      <div className="mb-8 text-center">
        <a href="/" className="inline-flex items-center gap-2 text-2xl font-bold tracking-tight text-wa-green">
          <img src="/logo.svg" alt="" className="h-8 w-8" />
          WAGO
        </a>
        <p className="mt-2 text-sm text-text-tertiary">Sign in to your account</p>
      </div>

      <div className="rounded-2xl border border-border-primary bg-bg-secondary p-8">
        <form onSubmit={handleLogin} className="space-y-4">
          {error && (
            <div className="rounded-lg border border-status-error-border bg-status-error-bg p-3 text-sm text-status-error-text">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-text-secondary">
              Email address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="block w-full rounded-lg border border-border-secondary bg-bg-elevated px-3.5 py-2.5 text-text-primary transition-colors placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-text-secondary">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="block w-full rounded-lg border border-border-secondary bg-bg-elevated px-3.5 py-2.5 text-text-primary transition-colors placeholder:text-text-tertiary focus:border-wa-green focus:outline-none focus:ring-1 focus:ring-wa-green"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 w-full rounded-lg bg-wa-green px-4 py-2.5 text-sm font-semibold text-text-inverse transition-colors hover:bg-wa-green-dark disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>

      <p className="mt-6 text-center text-sm text-text-secondary">
        Don&apos;t have an account?{' '}
        <a href="/signup" className="font-semibold text-wa-green hover:underline">
          Sign up
        </a>
      </p>
    </div>
  );
}
