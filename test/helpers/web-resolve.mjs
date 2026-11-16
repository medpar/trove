// Lets Node tests import the web app's server modules: resolves extensionless TypeScript imports
// ("./env" -> "./env.ts") and the "@/" alias, the "server-only" marker (a Next.js build-time check) to nothing, and
// @vercel/blob to an in-memory store.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
  // State and secrets go to an in-memory Blob store.
  if (specifier === '@vercel/blob') return { url: new URL('./fake-blob.mjs', import.meta.url).href, shortCircuit: true };
  // The web app's "@/…" alias (tsconfig paths) points at web/.
  if (specifier.startsWith('@/')) {
    const base = new URL(`../../web/${specifier.slice(2)}`, import.meta.url).href;
    for (const ext of ['.ts', '.tsx', '/index.ts', '']) {
      const url = new URL(base + ext);
      if (existsSync(fileURLToPath(url)) && (ext || /\.[cm]?[jt]sx?$|\.json$/.test(specifier))) return { url: url.href, shortCircuit: true };
    }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier) && context.parentURL?.startsWith('file:')) {
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier + ext, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
