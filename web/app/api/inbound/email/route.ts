import { after } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { json } from '@/lib/auth';
import { emailConfig, finishEmail, handleEmail } from '@/lib/email';

export const maxDuration = 300;

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** POST raw MIME (from the Cloudflare Email Routing worker). Header X-Trove-Email-Secret; optional X-Envelope-From. */
export async function POST(req: Request) {
  const cfg = emailConfig();
  if (!cfg) return json({ error: 'Email is not configured' }, { status: 404 });
  if (!same(req.headers.get('x-trove-email-secret') || '', cfg.secret)) return json({ error: 'Forbidden' }, { status: 403 });
  try {
    const r = await handleEmail(await req.arrayBuffer(), req.headers.get('x-envelope-from') || undefined);
    after(() => finishEmail(r).catch((e) => console.error('email', e)));
    return json({ kind: r.kind, saved: r.saved.map((s) => ({ id: s.item.id, title: s.item.title, created: s.created })), errors: r.errors });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, { status: e?.status || 500 });
  }
}
