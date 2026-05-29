// Polyfill for next/navigation and next/link in Astro context.
// All window accesses are guarded for SSR safety.

const isBrowser = typeof window !== 'undefined';

export function useRouter() {
  if (!isBrowser) return { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} };
  return {
    push: (url: string) => { window.location.href = url; },
    replace: (url: string) => { window.location.replace(url); },
    refresh: () => { window.location.reload(); },
    back: () => { window.history.back(); },
  };
}

export function useParams<T = Record<string, string>>(): T {
  if (!isBrowser) return {} as T;
  const path = window.location.pathname;
  const segments = path.split('/').filter(Boolean);
  const result: Record<string, string> = {};
  // /dashboard/connections/[id] → find 'connections' and take the next segment
  const connIdx = segments.indexOf('connections');
  if (connIdx !== -1 && segments[connIdx + 1]) {
    result.id = segments[connIdx + 1];
  }
  return result as T;
}

export function usePathname(): string {
  if (!isBrowser) return '';
  return window.location.pathname;
}

export function useSearchParams() {
  if (!isBrowser) return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export function Link({ href, children, className, ...props }: {
  href: string;
  children: React.ReactNode;
  className?: string;
  [key: string]: any;
}) {
  return <a href={href} className={className} {...props}>{children}</a>;
}
