import { guarded, json } from '@/lib/auth';
import { deleteEpisode, getEpisode, patchEpisode, toCard } from '@/lib/episodes';
import { readBody } from '@/lib/input';

type Ctx = { params: Promise<{ id: string }> };

export const GET = guarded<Ctx>(async (_req, _who, { params }) => {
  const { id } = await params;
  const { page, rec } = await getEpisode(id);
  return json({ card: toCard(page, rec) });
});

/**
 * PATCH /api/media/episodes/:id {status: "finished"|"unfinished", series, show, title,
 *   link: "<YouTube or Spotify link of the same episode>", unlink: "yt"|"sp", position: {p, pos}}
 */
export const PATCH = guarded<Ctx>(async (req, _who, { params }) => {
  const { id } = await params;
  const b = await readBody(req);
  const position = b.position && (b.position.p === 'yt' || b.position.p === 'sp') && Number.isFinite(Number(b.position.pos)) ? { p: b.position.p, pos: Math.max(0, Number(b.position.pos)) } : undefined;
  return json(
    await patchEpisode(id, {
      status: b.status === 'finished' || b.status === 'unfinished' ? b.status : undefined,
      title: typeof b.title === 'string' ? b.title : undefined,
      show: b.show === null || typeof b.show === 'string' ? b.show : undefined,
      series: b.series === null || typeof b.series === 'string' ? b.series : undefined,
      link: typeof b.link === 'string' ? b.link : undefined,
      unlink: b.unlink === 'yt' || b.unlink === 'sp' ? b.unlink : undefined,
      position,
    }),
  );
});

/** DELETE /api/media/episodes/:id  -> moves the page to Notion's trash */
export const DELETE = guarded<Ctx>(async (_req, _who, { params }) => {
  const { id } = await params;
  await deleteEpisode(id);
  return json({ ok: true });
});
