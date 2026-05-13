export const prerender = false;

export async function GET({ url, redirect }: { url: URL; redirect: (path: string) => Response }) {
  const code = url.searchParams.get('code');
  if (code) {
    return redirect(`/auth/callback?code=${code}`);
  }
  return redirect('/dashboard/connections');
}
