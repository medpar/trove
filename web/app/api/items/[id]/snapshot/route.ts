import { caller, unauthorized } from '@/lib/auth';
import { L, notion } from '@/lib/store';

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/items/:id/snapshot  The archived copy of the page, served sandboxed: no scripts, no
 * same-origin access, so a saved page can never touch Trove.
 */
export async function GET(req: Request, { params }: Ctx) {
  if (!caller(req)) return unauthorized();
  const { id } = await params;
  const page = await notion().req('GET', `/pages/${id}`);
  const f = page.properties?.[L.snapshot]?.files?.[0];
  const url = f?.file?.url || f?.external?.url;
  if (!url) return new Response('No archived copy for this item yet.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const res = await fetch(url);
  if (!res.ok || !res.body) return new Response('Could not load the archived copy.', { status: 502 });
  return new Response(res.body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline' https: http:; font-src data: https: http:; media-src data: https: http:",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
      'referrer-policy': 'no-referrer',
    },
  });
}
