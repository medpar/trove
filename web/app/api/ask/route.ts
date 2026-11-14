import { guarded, json } from '@/lib/auth';
import { AIUnavailable } from '@/lib/ai';
import { readBody } from '@/lib/input';
import { ask } from '@/lib/semantic';

export const maxDuration = 120;

/** POST /api/ask {question}  ->  {answer (Markdown with [n] citations), sources: Item[]} */
export const POST = guarded(async (req) => {
  const { question, q } = await readBody(req);
  const text = String(question || q || '').trim();
  if (!text) return json({ error: 'Pass a question' }, { status: 400 });
  try {
    return json(await ask(text));
  } catch (e) {
    if (e instanceof AIUnavailable) return json({ error: `Ask needs AI: ${e.message}` }, { status: 503 });
    throw e;
  }
});
