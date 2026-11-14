// Small JSON documents Trove keeps outside Notion (feed subscriptions, the search index cache),
// stored in the project's private Vercel Blob store. Everything here is a cache or rarely
// written settings, so last-writer-wins is fine.
import 'server-only';
import { get, put } from '@vercel/blob';
import { stagingReady } from './files';

export const stateReady = stagingReady;

export async function readState<T>(name: string): Promise<T | null> {
  if (!stateReady()) return null;
  try {
    const r = await get(`state/${name}`, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    const text = await new Response(r.stream).text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function writeState(name: string, data: unknown): Promise<void> {
  if (!stateReady()) throw new Error('Connect a Vercel Blob store (BLOB_READ_WRITE_TOKEN) to keep Trove settings');
  await put(`state/${name}`, JSON.stringify(data), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' });
}
