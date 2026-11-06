// Files that agents upload (images, videos, audio, documents): content types, Trove types,
// names, and the signed tokens that carry a large upload from "get an upload URL" to "save it".
// Pure helpers, no server-only imports, so the tests can load them.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Biggest file sent in the body of one request (Vercel caps request bodies at 4.5 MB). */
export const DIRECT_MAX = 4_000_000;
/** Biggest file accepted through an upload URL (relayed into Notion within one function run). */
export const STAGED_MAX = 1_000_000_000;

export type FileKind = 'Image' | 'Video' | 'Audio' | 'Document';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', ico: 'image/vnd.microsoft.icon',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', qt: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpeg: 'video/mpeg', mpg: 'video/mpeg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wma: 'audio/x-ms-wma', mid: 'audio/midi',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Preferred extension per content type (the first one listed above). */
const EXT: Record<string, string> = Object.fromEntries(
  Object.entries(MIME)
    .reverse()
    .map(([ext, type]) => [type, ext]),
);

/** Common non-standard names for the same types. */
const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png', 'video/mov': 'video/quicktime', 'video/x-quicktime': 'video/quicktime',
  'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4',
};

const extOf = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name.trim())?.[1]?.toLowerCase() || '';

/** Content type from a file name (".png" -> "image/png"). */
export function mimeOf(name: string): string | null {
  return MIME[extOf(name)] || null;
}

/** Recognize common formats from their first bytes, for uploads sent without a usable type. */
export function sniff(b: Uint8Array): string | null {
  const s = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length < 12) return null;
  if (b[0] === 0x89 && s(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (s(0, 4) === 'GIF8') return 'image/gif';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'audio/wav';
  if (s(0, 4) === 'RIFF' && s(8, 11) === 'AVI') return 'video/x-msvideo';
  if (s(0, 5) === '%PDF-') return 'application/pdf';
  if (s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return 'image/heic';
    if (/^avi[fs]$/.test(brand)) return 'image/avif';
    if (brand === 'qt  ') return 'video/quicktime';
    if (/^M4A/.test(brand)) return 'audio/mp4';
    return 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (s(0, 4) === 'OggS') return 'audio/ogg';
  if (s(0, 4) === 'fLaC') return 'audio/flac';
  return null;
}

/** The best content type we can tell from what the caller said, the name and the bytes. */
export function contentTypeFor(declared: string | null | undefined, name: string, bytes?: Uint8Array): string {
  let d = (declared || '').split(';')[0].trim().toLowerCase();
  d = ALIASES[d] || d;
  if (d && d !== 'application/octet-stream' && d !== 'binary/octet-stream' && d.includes('/')) return d;
  return (bytes && sniff(bytes)) || mimeOf(name) || 'application/octet-stream';
}

export function kindOf(contentType: string): FileKind {
  if (contentType.startsWith('image/')) return 'Image';
  if (contentType.startsWith('video/')) return 'Video';
  if (contentType.startsWith('audio/')) return 'Audio';
  return 'Document';
}

/** A safe file name that ends in an extension Notion accepts for its content type. */
export function fileNameFor(name: string | null | undefined, contentType: string): string {
  let n = (name || '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f"<>|*?:]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-120);
  if (!n || n.startsWith('.')) n = `${kindOf(contentType).toLowerCase()}${n}`;
  const want = EXT[contentType];
  if (want && mimeOf(n) !== contentType) n = `${mimeOf(n) ? n.replace(/\.[a-z0-9]{1,5}$/i, '') : n}.${want}`;
  return n;
}

/** "IMG_2024-05-01_holiday-pic.jpg" -> "IMG 2024-05-01 holiday pic". */
export function titleFromFileName(name: string): string {
  const t = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').replace(/(?<=[a-z])-(?=[a-z])/gi, ' ').replace(/\s+/g, ' ').trim();
  return t || name;
}

/** Decimal units, like the limits in the docs: 4000000 -> "4 MB". */
export function formatSize(n: number): string {
  const f = (x: number) => String(Number(x.toFixed(1)));
  if (n < 1e3) return `${n} B`;
  if (n < 1e6) return `${f(n / 1e3)} KB`;
  if (n < 1e9) return `${f(n / 1e6)} MB`;
  return `${f(n / 1e9)} GB`;
}

/** Accepts plain base64 or a data: URL. */
export function decodeBase64(data: string): Uint8Array {
  const m = /^data:([^;,]*)(;base64)?,/.exec(data);
  return new Uint8Array(Buffer.from(m ? data.slice(m[0].length) : data, 'base64'));
}

export const dataUrlType = (data: string) => /^data:([^;,]+)[;,]/.exec(data)?.[1] || null;

// ---------- upload tokens ----------

/** What the server needs to finish a large upload: blob pathname, name, type, size, hash, expiry. */
export type UploadToken = { p: string; n: string; t: string; s: number; h?: string; e: number };

const sign = (body: string, secret: string) => createHmac('sha256', `${secret}:upload`).update(body).digest('base64url');

export function signUpload(t: UploadToken, secret: string): string {
  const body = Buffer.from(JSON.stringify(t)).toString('base64url');
  return `up_${body}.${sign(body, secret)}`;
}

/** Returns the token's contents, or null when it was tampered with, malformed or is older than `graceMs` past expiry. */
export function readUpload(token: string, secret: string, now = Date.now(), graceMs = 24 * 3600e3): UploadToken | null {
  const m = /^up_([\w-]+)\.([\w-]+)$/.exec(token.trim());
  if (!m) return null;
  const want = Buffer.from(sign(m[1], secret));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(m[1], 'base64url').toString()) as UploadToken;
    if (typeof t.p !== 'string' || !t.p.startsWith('uploads/') || typeof t.s !== 'number' || t.e + graceMs < now) return null;
    return t;
  } catch {
    return null;
  }
}
