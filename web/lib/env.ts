// Server configuration from environment variables.
//   NOTION_TOKEN            Notion integration token with access to the Trove database
//   TROVE_LIBRARY_DS        data source id of the Trove database (X bookmarks included)
//   TROVE_PASSWORD          password for the web app
//   TROVE_SESSION_SECRET    random string used to sign session cookies
//   TROVE_API_KEYS          "name:key,name:key" (the name is recorded as "Via" on saves)
//   TROVE_PUBLIC_URL        public base URL (https://trove.mariomedpar.com)
//   CRON_SECRET             Vercel cron auth

export type ApiKey = { name: string; key: string };

let cached: ReturnType<typeof read> | null = null;

function need(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v.trim();
}

function read() {
  return {
    notionToken: need('NOTION_TOKEN'),
    libraryDs: need('TROVE_LIBRARY_DS'),
    libraryDb: process.env.TROVE_LIBRARY_DB?.trim() || '',
    password: process.env.TROVE_PASSWORD?.trim() || '',
    sessionSecret: need('TROVE_SESSION_SECRET'),
    // TROVE_EXTRA_API_KEYS adds keys without touching the main list (e.g. "Backup:key"), and each
    // TROVE_API_KEY_<NAME> variable adds one key named after it (TROVE_API_KEY_AI_WORKER → "AI worker"),
    // so a new key never means rewriting a list that Vercel won't show again.
    apiKeys: [process.env.TROVE_API_KEYS || '', process.env.TROVE_EXTRA_API_KEYS || '', ...namedKeys()].join(',')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.lastIndexOf(':');
        return i > 0 ? { name: s.slice(0, i), key: s.slice(i + 1) } : { name: 'API', key: s };
      }) as ApiKey[],
    publicUrl: (process.env.TROVE_PUBLIC_URL || 'https://trove.mariomedpar.com').replace(/\/$/, ''),
    cronSecret: process.env.CRON_SECRET?.trim() || '',
  };
}

export const env = () => (cached ||= read());

function namedKeys() {
  return Object.entries(process.env)
    .filter(([k, v]) => /^TROVE_API_KEY_[A-Z0-9_]+$/.test(k) && v?.trim() && !v.includes(','))
    .map(([k, v]) => {
      const words = k.slice('TROVE_API_KEY_'.length).toLowerCase().split('_').filter(Boolean);
      const name = words.map((w, i) => (w === 'ai' || w === 'mcp' || w === 'api' ? w.toUpperCase() : i ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
      return `${name}:${v!.trim()}`;
    });
}
