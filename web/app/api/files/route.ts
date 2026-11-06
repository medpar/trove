import { guarded, json } from '@/lib/auth';
import { readFileRequest, saveFile } from '@/lib/files';
import { toSaveInput } from '@/lib/input';
import { invalidateStats } from '@/lib/store';

// Large files are streamed from storage into Notion within this request.
export const maxDuration = 300;

/**
 * POST /api/files  Save an image, video, audio file or document.
 *   multipart/form-data  file=@photo.jpg  [title, description, note, tags, collection, url, favorite, read, via, duration, poster=@frame.jpg]
 *   raw bytes            ?filename=photo.jpg&tags=a,b  (Content-Type: image/jpeg)
 *   application/json     {data: "<base64 or data: URL>", filename} | {file_url} | {upload} from POST /api/files/uploads
 * Up to 4 MB in the request itself; bigger files go through an upload URL. Same bytes again = merged, never duplicated.
 */
export const POST = guarded(async (req, who) => {
  const { fields, source, options } = await readFileRequest(req);
  const r = await saveFile(source, toSaveInput(fields, who), options);
  invalidateStats();
  return json(r, { status: r.created ? 201 : 200 });
});
