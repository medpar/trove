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
    // TROVE_EXTRA_API_KEYS adds keys without touching the main list (e.g. "Backup:key").
    apiKeys: [process.env.TROVE_API_KEYS || '', process.env.TROVE_EXTRA_API_KEYS || ''].join(',')
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
