import { guarded, json } from '@/lib/auth';
import { readBody } from '@/lib/input';
import { forget } from '@/lib/semantic';
import { getItem, invalidateStats, remove, update } from '@/lib/store';

export const maxDuration = 60;

/** POST /api/items/bulk {ids:[...], action:'move'|'tag'|'untag'|'favorite'|'unfavorite'|'read'|'unread'|'delete', value?} */
export const POST = guarded(async (req) => {
  const { ids = [], action, value } = await readBody(req);
  if (!Array.isArray(ids) || !ids.length) return json({ error: 'ids required' }, { status: 400 });
  let done = 0;
  const errors: string[] = [];
  let next = 0;
  const work = ids.slice(0, 200);
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < work.length) {
        const id = work[next++];
        try {
          switch (action) {
            case 'move':
              await update(id, { collection: value || null });
              break;
            case 'tag':
            case 'untag': {
              const { item } = await getItem(id);
              const tags = action === 'tag' ? [...item.tags, ...[].concat(value)] : item.tags.filter((t) => ![].concat(value).includes(t as never));
              await update(id, { tags });
              break;
            }
            case 'favorite':
            case 'unfavorite':
              await update(id, { favorite: action === 'favorite' });
              break;
            case 'read':
            case 'unread':
              await update(id, { read: action === 'read' });
              break;
            case 'delete':
              await remove(id);
              forget(id);
              break;
            default:
              throw new Error(`Unknown action ${action}`);
          }
          done++;
        } catch (e: any) {
          errors.push(`${id}: ${e?.message || e}`);
        }
      }
    }),
  );
  invalidateStats();
  return json({ done, errors });
});
