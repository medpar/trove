import { guarded, json } from '@/lib/auth';
import { createUpload } from '@/lib/files';
import { readBody, toSaveInput } from '@/lib/input';
import { invalidateStats } from '@/lib/store';

/**
 * POST /api/files/uploads  {filename, content_type?, size, sha256?, ...title/tags/collection/note}
 * For files over 4 MB: returns {upload, put: {method, url, headers}}. PUT the bytes to put.url with
 * put.headers, then POST /api/files {"upload": "<upload>", ...}. When sha256 matches a file saved
 * before, returns that item instead ({created: false, duplicate: true, item}) with the new tags merged.
 */
export const POST = guarded(async (req, who) => {
  const b = await readBody(req);
  const r = await createUpload({ filename: b.filename || b.name, contentType: b.content_type || b.contentType, size: b.size, sha256: b.sha256 }, toSaveInput(b, who));
  if ('item' in r) invalidateStats();
  return json(r);
});
