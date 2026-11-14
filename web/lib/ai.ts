// AI through any OpenAI-compatible endpoint. Trove's own deployment uses the free Cloudflare
// Workers AI relay in workers/ai (AI_BASE_URL + AI_API_KEY + the @cf/ models below). Without
// AI_BASE_URL it uses Vercel AI Gateway, which authenticates with the project's OIDC token.
//   AI_MODEL           text model for filing, summaries and answers (default anthropic/claude-haiku-5.5)
//   AI_VISION_MODEL    OCR of images and PDFs (default google/gemini-3.6-flash)
//   AI_EMBED_MODEL     embeddings for semantic search (default openai/text-embedding-3-small, 512 dims)
//   AI_BASE_URL        any OpenAI-compatible endpoint instead of the gateway (with AI_API_KEY)
//   TROVE_AI=off       turn every AI feature off
import 'server-only';
import { getVercelOidcToken } from '@vercel/oidc';

const BASE = (process.env.AI_BASE_URL || 'https://ai-gateway.vercel.sh/v1').replace(/\/$/, '');

export const MODELS = {
  text: process.env.AI_MODEL || 'anthropic/claude-haiku-5.5',
  vision: process.env.AI_VISION_MODEL || 'google/gemini-3.6-flash',
  embed: process.env.AI_EMBED_MODEL || 'openai/text-embedding-3-small',
};
export const EMBED_DIM = 512;

/** AI can't be used right now (turned off, no credentials, or the gateway refuses the account). */
export class AIUnavailable extends Error {}

// When the gateway refuses the account (no card on file, no credits), stop asking for a while so
// saves don't wait on requests that are bound to fail.
let pausedUntil = 0;
let pauseReason = '';

async function credentials(): Promise<string | null> {
  const key = process.env.AI_API_KEY || process.env.AI_GATEWAY_API_KEY;
  if (key?.trim()) return key.trim();
  try {
    return await getVercelOidcToken();
  } catch {
    return process.env.VERCEL_OIDC_TOKEN || null;
  }
}

export function aiEnabled() {
  return process.env.TROVE_AI !== 'off';
}

export function aiStatus() {
  return { enabled: aiEnabled(), paused: Date.now() < pausedUntil ? pauseReason : null, models: MODELS };
}

async function call(path: string, body: unknown, timeoutMs = 60000): Promise<any> {
  if (!aiEnabled()) throw new AIUnavailable('AI is turned off (TROVE_AI=off)');
  if (Date.now() < pausedUntil) throw new AIUnavailable(pauseReason);
  const token = await credentials();
  if (!token) throw new AIUnavailable('No AI credentials: deploy on Vercel (OIDC) or set AI_GATEWAY_API_KEY');
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    throw new Error(`AI request failed: ${e?.message || e}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    const type = data?.error?.type || '';
    if ([401, 402, 403].includes(res.status) || /verification|credit|billing|quota/i.test(type + msg)) {
      // A used-up daily allowance (Workers AI free tier) comes back at 00:00 UTC; anything else is retried in 10 minutes.
      const midnight = new Date();
      midnight.setUTCHours(24, 0, 0, 0);
      pausedUntil = type === 'quota_exceeded' ? midnight.getTime() : Date.now() + 10 * 60e3;
      pauseReason = msg;
      throw new AIUnavailable(msg);
    }
    throw new Error(`AI ${res.status}: ${msg}`);
  }
  return data;
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export type CompleteOptions = { model?: string; system?: string; prompt?: string; parts?: Part[]; maxTokens?: number; temperature?: number; timeoutMs?: number };

/** One chat completion; returns the text. */
export async function complete(o: CompleteOptions): Promise<string> {
  const content = o.parts ? [...(o.prompt ? [{ type: 'text', text: o.prompt }] : []), ...o.parts] : o.prompt || '';
  const messages = [...(o.system ? [{ role: 'system', content: o.system }] : []), { role: 'user', content }];
  const data = await call('/chat/completions', { model: o.model || MODELS.text, messages, max_tokens: o.maxTokens || 800, temperature: o.temperature ?? 0.2 }, o.timeoutMs);
  const msg = data.choices?.[0]?.message?.content;
  return typeof msg === 'string' ? msg : Array.isArray(msg) ? msg.map((p: any) => p.text || '').join('') : '';
}

/** A completion that must answer with one JSON object. */
export async function completeJson<T = any>(o: CompleteOptions): Promise<T> {
  const raw = await complete({ ...o, system: `${o.system || ''}\nReply with a single JSON object and nothing else.`.trim() });
  return parseJson<T>(raw);
}

export function parseJson<T>(raw: string): T {
  const s = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('The model did not return JSON');
    return JSON.parse(m[0]);
  }
}

// ---------- embeddings ----------

/** Embed texts (unit-length vectors, EMBED_DIM dims). */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const data = await call('/embeddings', { model: MODELS.embed, input: texts.map((t) => t.slice(0, 24000) || ' '), dimensions: EMBED_DIM });
  return (data.data as any[]).sort((a, b) => a.index - b.index).map((d) => unit(Float32Array.from(d.embedding)));
}

function unit(v: Float32Array) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

export { dot, packVector, unpackVector } from './vector';
