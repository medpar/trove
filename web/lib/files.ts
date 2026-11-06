// Saving files (images, videos, audio, documents) that agents and scripts upload.
//
// Three ways in, all ending as a Notion file upload attached to a new Trove item:
//   1. bytes in the request (multipart form, raw body or base64 JSON), up to 4 MB (Vercel's request limit);
//   2. an upload URL for anything bigger: the client PUTs the file straight to a private Vercel Blob
//      store, then the server streams it into Notion in 10 MB parts and deletes the blob;
//   3. a public file URL that Notion downloads itself.
import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { del, get, issueSignedToken, list, presignUrl } from '@vercel/blob';
import { env } from './env';
import { DIRECT_MAX, STAGED_MAX, contentTypeFor, dataUrlType, decodeBase64, fileNameFor, formatSize, kindOf, readUpload, signUpload, sniff } from './media';
import { createFileItem, mergeFile, notion, type SaveInput, type SaveResult } from './store';
import { isUrl, urlKey } from './url';

export type FileSource =
  | { kind: 'bytes'; bytes: Uint8Array; filename?: string; contentType?: string }
  | { kind: 'upload'; token: string }
  | { kind: 'url'; url: string; filename?: string; contentType?: string };

export type FileOptions = { description?: string; duration?: number | null; poster?: Uint8Array | null };

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Large uploads go through a Vercel Blob store connected to the project. */
export const stagingReady = () => !!(process.env.BLOB_READ_WRITE_TOKEN || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN));

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const BLOB_API_VERSION = '13';

async function posterId(bytes?: Uint8Array | null): Promise<string | null> {
  if (!bytes?.length || bytes.length > DIRECT_MAX) return null;
  const type = sniff(bytes);
  if (!type?.startsWith('image/')) return null;
  return notion()
    .uploadBytes(bytes, fileNameFor('poster', type), type)
    .catch(() => null);
}

/** Save a file as a Trove item. Saving the same bytes again merges tags, collection and note instead. */
export async function saveFile(src: FileSource, input: SaveInput, o: FileOptions = {}): Promise<SaveResult> {
  const details = { description: o.description, duration: o.duration ?? null };
  // Unnamed bytes (base64 from a chat, stdin): a description makes a better title than "image".
  if (!input.title && src.kind === 'bytes' && !src.filename && o.description) input = { ...input, title: o.description.split('\n')[0].slice(0, 100) };

  if (src.kind === 'bytes') {
    const size = src.bytes.length;
    if (!size) throw new HttpError(400, 'The file is empty');
    if (size > 20 * 1024 * 1024) throw new HttpError(413, 'Send files over 4 MB through an upload URL: POST /api/files/uploads');
    const contentType = contentTypeFor(src.contentType, src.filename || '', src.bytes);
    const filename = fileNameFor(src.filename, contentType);
    const key = `file:${sha256(src.bytes)}`;
    const dup = await mergeFile(key, input);
    if (dup) return dup;
    const id = await notion().uploadBytes(src.bytes, filename, contentType);
    return createFileItem({ id, filename, contentType, size, kind: kindOf(contentType) }, { ...details, key, poster: await posterId(o.poster) }, input);
  }

  if (src.kind === 'upload') {
    const t = readUpload(src.token, env().sessionSecret);
    if (!t) throw new HttpError(400, 'Unknown or expired upload. Get a new upload URL with POST /api/files/uploads.');
    // Without a hash, the blob path keeps a retried request from saving the same upload twice.
    const key = t.h ? `file:${t.h}` : `file:${t.p}`;
    const dup = await mergeFile(key, input);
    if (dup) {
      await del(t.p).catch(() => {});
      return dup;
    }
    const blob = await get(t.p, { access: 'private', useCache: false });
    if (!blob || blob.statusCode !== 200 || !blob.stream) throw new HttpError(409, 'Nothing was uploaded yet: PUT the file to the upload URL first, then save it.');
    const size = blob.blob.size;
    if (size > STAGED_MAX) throw new HttpError(413, `Files up to ${formatSize(STAGED_MAX)} can be uploaded`);
    const contentType = contentTypeFor(t.t || blob.blob.contentType, t.n);
    const filename = fileNameFor(t.n, contentType);
    const id = await notion().uploadStream(blob.stream, size, filename, contentType);
    const res = await createFileItem({ id, filename, contentType, size, kind: kindOf(contentType) }, { ...details, key, poster: await posterId(o.poster) }, input);
    await del(t.p).catch(() => {});
    return res;
  }

  if (!isUrl(src.url)) throw new HttpError(400, 'file_url must be an http(s) URL');
  const name = src.filename || decodeURIComponent(new URL(src.url).pathname.split('/').pop() || '');
  const key = `file:url:${urlKey(src.url)}`;
  const dup = await mergeFile(key, input);
  if (dup) return dup;
  let contentType = contentTypeFor(src.contentType, name);
  const id = await notion()
    .importUrl(src.url, fileNameFor(name, contentType))
    .catch((e) => {
      throw new HttpError(400, `Notion could not fetch file_url (${e.message.replace(/^Notion \d+ \w+: /, '')}). Use a public, direct link to the file, or upload the bytes instead.`);
    });
  const ok = (await notion().waitUploads([id], 240000)).get(id);
  if (!ok) throw new HttpError(502, 'Notion could not download that file. file_url must be a public, direct link to the file; otherwise upload the bytes.');
  const fu = await notion().req('GET', `/file_uploads/${id}`);
  contentType = contentTypeFor(fu.content_type || contentType, name);
  return createFileItem(
    { id, filename: fu.filename || fileNameFor(name, contentType), contentType, size: fu.content_length || 0, kind: kindOf(contentType) },
    { ...details, key, poster: await posterId(o.poster) },
    { ...input, url: input.url || src.url },
  );
}

/**
 * Start a large upload: returns a presigned PUT URL (plus the headers to send with it) and an
 * `upload` token to pass to POST /api/files afterwards. When the same file (by SHA-256) was saved
 * before, nothing needs uploading: the existing item is returned, merged with the new tags and note.
 */
export async function createUpload(r: { filename?: string; contentType?: string; size?: unknown; sha256?: string }, input: SaveInput) {
  const size = Number(r.size);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'Pass the file size in bytes as "size"');
  if (size > STAGED_MAX) throw new HttpError(413, `Files up to ${formatSize(STAGED_MAX)} can be uploaded`);
  const sha = /^[a-f0-9]{64}$/i.test(r.sha256 || '') ? r.sha256!.toLowerCase() : undefined;
  if (sha) {
    const dup = await mergeFile(`file:${sha}`, input);
    if (dup) return { ...dup, duplicate: true };
  }
  if (!stagingReady())
    throw new HttpError(501, `Uploads over ${formatSize(DIRECT_MAX)} need a Vercel Blob store connected to the project (BLOB_READ_WRITE_TOKEN). Smaller files can be sent straight to POST /api/files.`);
  const contentType = contentTypeFor(r.contentType, r.filename || '');
  const filename = fileNameFor(r.filename, contentType);
  const pathname = `uploads/${randomUUID()}/${filename.replace(/[^\w.-]+/g, '-').slice(-80)}`;
  const validUntil = Date.now() + 3600e3;
  // A little slack, so an approximate size still works. The real size is read back from storage.
  const max = Math.min(STAGED_MAX, Math.ceil(size * 1.05) + 64 * 1024);
  const tok = await issueSignedToken({ pathname, operations: ['put'], validUntil, allowedContentTypes: [contentType], maximumSizeInBytes: max });
  const { presignedUrl } = await presignUrl(tok, { operation: 'put', pathname, access: 'private', allowedContentTypes: [contentType], maximumSizeInBytes: max });
  const upload = signUpload({ p: pathname, n: filename, t: contentType, s: size, h: sha, e: validUntil }, env().sessionSecret);
  const headers = { 'x-api-version': BLOB_API_VERSION, 'x-vercel-blob-access': 'private', 'x-content-type': contentType };
  return {
    upload,
    put: { method: 'PUT' as const, url: presignedUrl, headers },
    expires: new Date(validUntil).toISOString(),
    filename,
    contentType,
    next: 'PUT the file bytes to put.url with put.headers, then POST /api/files with {"upload": "<upload>"} and the title, tags, collection and note.',
  };
}

/** Delete staged blobs that were never saved (called by the daily cron). */
export async function cleanupUploads(olderThanMs = 24 * 3600e3) {
  if (!stagingReady()) return { deleted: 0 };
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await list({ prefix: 'uploads/', limit: 1000, cursor });
    const old = page.blobs.filter((b) => Date.now() - new Date(b.uploadedAt).getTime() > olderThanMs).map((b) => b.pathname);
    if (old.length) await del(old);
    deleted += old.length;
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return { deleted };
}

// ---------- reading requests ----------

type Fields = Record<string, unknown>;
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const str = (v: unknown) => {
  const x = first(v);
  return typeof x === 'string' && x.trim() ? x.trim() : undefined;
};
const num = (v: unknown) => {
  const n = Number(first(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Pull the file and its fields out of a multipart form, a raw body (fields in the query) or JSON. */
export async function readFileRequest(req: Request): Promise<{ fields: Fields; source: FileSource; options: FileOptions }> {
  const type = req.headers.get('content-type') || '';
  let fields: Fields = Object.fromEntries(new URL(req.url).searchParams.entries());
  let source: FileSource | null = null;
  let poster: Uint8Array | null = null;

  if (type.includes('multipart/form-data')) {
    const form = await req.formData();
    for (const k of new Set(form.keys())) {
      const vals = form.getAll(k).filter((v): v is string => typeof v === 'string');
      if (vals.length) fields[k] = vals.length > 1 ? vals : vals[0];
    }
    const f = form.get('file');
    if (f && typeof f !== 'string') source = { kind: 'bytes', bytes: new Uint8Array(await f.arrayBuffer()), filename: str(fields.filename) || f.name, contentType: str(fields.content_type) || f.type };
    const p = form.get('poster');
    if (p && typeof p !== 'string') poster = new Uint8Array(await p.arrayBuffer());
  } else if (type.includes('application/json')) {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid JSON body');
    fields = { ...fields, ...(body as Fields) };
  } else {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length) {
      const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(req.headers.get('content-disposition') || '')?.[1];
      const filename = str(fields.filename) || req.headers.get('x-filename') || (disposition ? decodeURIComponent(disposition) : undefined);
      source = { kind: 'bytes', bytes, filename, contentType: type };
    }
  }

  if (!source) {
    const upload = str(fields.upload) || str(fields.upload_id);
    const data = str(fields.data) || str(fields.base64);
    const fileUrl = str(fields.file_url) || str(fields.fileUrl);
    const filename = str(fields.filename);
    const contentType = str(fields.content_type) || str(fields.contentType);
    if (upload) source = { kind: 'upload', token: upload };
    else if (data) source = { kind: 'bytes', bytes: decodeBase64(data), filename, contentType: contentType || dataUrlType(data) || undefined };
    else if (fileUrl) source = { kind: 'url', url: fileUrl, filename, contentType };
    else
      throw new HttpError(
        400,
        `No file. Send a multipart form with a "file" field, the raw bytes with ?filename=, JSON {"data": "<base64>", "filename"}, {"file_url"} or {"upload"} from POST /api/files/uploads (files over ${formatSize(DIRECT_MAX)}).`,
      );
  }
  const posterData = str(fields.poster);
  if (!poster && posterData) poster = decodeBase64(posterData);
  const description = str(fields.description) || str(fields.caption) || str(fields.text);
  // `text` describes the file here; it is not a note to save on its own.
  delete fields.text;
  return { fields, source, options: { description, duration: num(fields.duration), poster } };
}
