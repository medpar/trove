// Secrets Trove keeps for you (your Spotify and YouTube sign-ins for the server sync), encrypted
// with a key derived from TROVE_SESSION_SECRET (AES-256-GCM) before they go into the private Blob store.
import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env';
import { readState, writeState } from './state';

type Box = { v: 1; iv: string; tag: string; data: string };

const key = () => createHash('sha256').update(`${env().sessionSecret}:trove-vault`).digest();

export function seal(value: unknown): Box {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function open<T>(box: Box | null): T | null {
  if (!box?.data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

export async function readSecret<T>(name: string): Promise<T | null> {
  return open<T>(await readState<Box>(`vault/${name}.json`));
}

export async function writeSecret(name: string, value: unknown | null) {
  await writeState(`vault/${name}.json`, value === null ? {} : seal(value));
}
