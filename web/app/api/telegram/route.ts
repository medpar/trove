import { after } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { handleUpdate } from '@/lib/bot';
import { telegramConfig } from '@/lib/telegram';

// Saves (fetching, archiving, AI filing) continue after the webhook has answered Telegram.
export const maxDuration = 300;

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Telegram webhook. Answers at once so Telegram never retries, then does the work. */
export async function POST(req: Request) {
  const cfg = telegramConfig();
  if (!cfg || !cfg.secret) return new Response('Telegram is not configured', { status: 404 });
  if (!same(req.headers.get('x-telegram-bot-api-secret-token') || '', cfg.secret)) return new Response('Forbidden', { status: 403 });
  const update = await req.json().catch(() => null);
  if (update) after(() => handleUpdate(update).catch((e) => console.error('telegram', e)));
  return Response.json({ ok: true });
}
