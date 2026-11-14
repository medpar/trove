import { caller, json, unauthorized } from '@/lib/auth';
import { aiStatus } from '@/lib/ai';
import { emailConfig } from '@/lib/email';
import { env } from '@/lib/env';
import { stateReady } from '@/lib/state';
import { telegramConfig } from '@/lib/telegram';

const notionUrl = (id: string) => (id ? `https://www.notion.so/${id.replace(/-/g, '')}` : '');

/** GET /api/me -> settings for the web app (session only: includes API keys for wiring up agents). */
export async function GET(req: Request) {
  const who = caller(req);
  if (!who) return unauthorized();
  const e = env();
  const tg = telegramConfig();
  const mail = emailConfig();
  return json({
    publicUrl: e.publicUrl,
    notion: { library: notionUrl(e.libraryDb) },
    apiKeys: who.kind === 'session' ? e.apiKeys : e.apiKeys.filter((k) => k.name === who.via).map((k) => ({ name: k.name, key: '' })),
    cron: !!e.cronSecret,
    telegram: tg ? { configured: true, bot: process.env.TELEGRAM_BOT_USERNAME || null } : { configured: false },
    email: mail ? { configured: true, address: mail.address || null } : { configured: false },
    ai: aiStatus(),
    storage: stateReady(),
    backup: process.env.TROVE_BACKUP_REPO || null,
  });
}
