// Trove email relay (Cloudflare Email Routing worker). Every message sent to the routed address is
// passed, as raw MIME, to Trove's /api/inbound/email on Vercel, which checks the sender and saves it.
export default {
  async email(message, env) {
    if (message.rawSize > 4_300_000) {
      message.setReject('Too large for Trove (4 MB max per email). Send big files from the Share sheet or Telegram.');
      return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await fetch(`${env.TROVE_URL}/api/inbound/email`, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822', 'x-trove-email-secret': env.TROVE_EMAIL_SECRET, 'x-envelope-from': message.from || '' },
      body: raw,
    });
    if (res.status === 403) message.setReject('This address only accepts mail from its owner.');
    else if (!res.ok) message.setReject(`Trove could not save this message (${res.status}). Try again later.`);
  },
};
