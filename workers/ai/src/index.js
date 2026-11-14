// Trove AI relay: an OpenAI-compatible endpoint backed by Cloudflare Workers AI (free daily
// allowance, no keys: the AI binding authenticates). Trove calls it through AI_BASE_URL.
//   POST /v1/chat/completions  {model, messages, max_tokens, temperature}
//   POST /v1/embeddings        {model, input}
// PDFs sent as a "file" part are converted with Workers AI's free document-to-Markdown.
// Auth: Authorization: Bearer <TROVE_AI_SECRET>.

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const fail = (status, message, type = 'error') => json({ error: { message, type } }, status);

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Workers AI errors when the free daily allowance is used up: surface them as a quota error. */
function aiError(e) {
  const msg = String(e?.message || e);
  if (/neuron|allocation|quota|limit|3036|4006|exceeded/i.test(msg)) return fail(429, `Workers AI daily free allowance used up (resets 00:00 UTC): ${msg}`, 'quota_exceeded');
  return fail(502, `Workers AI: ${msg}`);
}

function dataUrlToBlob(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url || '');
  if (!m) return null;
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
}

/** Text of a completion, whatever shape the model returns. */
function textOf(out) {
  if (typeof out === 'string') return out;
  if (typeof out?.response === 'string') return out.response;
  if (out?.response && typeof out.response === 'object') return JSON.stringify(out.response);
  const msg = out?.choices?.[0]?.message || {};
  const c = msg.content;
  if (typeof c === 'string' && c.trim()) return c;
  if (Array.isArray(c)) return c.map((p) => p.text || '').join('');
  // Some models put the whole answer in the reasoning field when thinking is turned off.
  return typeof msg.reasoning_content === 'string' ? msg.reasoning_content : typeof msg.reasoning === 'string' ? msg.reasoning : '';
}

const stripThinking = (s) => s.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();

async function chat(body, env) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // A PDF: free conversion, no model call.
  for (const m of messages) {
    for (const p of Array.isArray(m.content) ? m.content : []) {
      if (p?.type === 'file' && /^data:application\/pdf/i.test(p.file?.file_data || '')) {
        const blob = dataUrlToBlob(p.file.file_data);
        const [doc] = await env.AI.toMarkdown([{ name: p.file.filename || 'document.pdf', blob }]);
        // Keep the document text: drop the file heading, the metadata list and the page markers.
        const md = String(doc?.data || '');
        const i = md.indexOf('## Contents');
        const text = (i >= 0 ? md.slice(i + '## Contents'.length) : md.replace(/^# .*\n+## Metadata[\s\S]*?(?=\n## |$)/, '')).replace(/^### Page \d+\s*$/gm, '').trim();
        return { content: text, model: 'toMarkdown' };
      }
    }
  }
  const model = body.model || env.DEFAULT_MODEL;
  // Short structured answers: skip the hidden reasoning these models do by default.
  const input = { messages, max_tokens: Math.min(Number(body.max_tokens) || 800, 8192), temperature: body.temperature ?? 0.2 };
  if (/qwen|glm|gpt-oss|deepseek|kimi/i.test(model)) Object.assign(input, { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' });
  const out = await env.AI.run(model, input);
  if (body.debug) return { content: JSON.stringify(out).slice(0, 3000), model, usage: out?.usage };
  return { content: stripThinking(textOf(out)), model, usage: out?.usage };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true });
    if (req.method !== 'POST') return fail(405, 'POST only');
    const auth = req.headers.get('authorization') || '';
    if (!env.TROVE_AI_SECRET || !same(auth.replace(/^Bearer\s+/i, ''), env.TROVE_AI_SECRET)) return fail(401, 'Unauthorized', 'authentication_error');
    let body;
    try {
      body = await req.json();
    } catch {
      return fail(400, 'Invalid JSON');
    }
    try {
      if (url.pathname.endsWith('/chat/completions')) {
        const r = await chat(body, env);
        return json({ object: 'chat.completion', model: r.model, choices: [{ index: 0, message: { role: 'assistant', content: r.content }, finish_reason: 'stop' }], usage: r.usage });
      }
      if (url.pathname.endsWith('/embeddings')) {
        const input = Array.isArray(body.input) ? body.input : [body.input];
        const model = body.model || env.EMBED_MODEL;
        const out = await env.AI.run(model, { text: input.map((t) => String(t || ' ').slice(0, 8000)) });
        return json({ object: 'list', model, data: (out.data || []).map((embedding, index) => ({ object: 'embedding', index, embedding })) });
      }
      return fail(404, 'Unknown endpoint');
    } catch (e) {
      return aiError(e);
    }
  },
};
