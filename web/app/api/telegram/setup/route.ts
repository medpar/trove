import { guarded, json } from '@/lib/auth';
import { setupBot } from '@/lib/bot';
import { tg, telegramConfig } from '@/lib/telegram';

export const maxDuration = 60;

/** GET: bot and webhook status. POST: point the webhook at this deployment and set commands. */
export const GET = guarded(async () => {
  if (!telegramConfig()) return json({ configured: false });
  const [me, info] = await Promise.all([tg('getMe'), tg('getWebhookInfo')]);
  return json({ configured: true, bot: me.username, link: `https://t.me/${me.username}`, inline: !!me.supports_inline_queries, guest: !!me.supports_guest_queries, webhook: info.url || null, pending: info.pending_update_count, lastError: info.last_error_message || null });
});

export const POST = guarded(async () => json(await setupBot()));
