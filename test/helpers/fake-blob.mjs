// In-memory stand-in for @vercel/blob in tests (Trove's state and secrets live there).
const store = (globalThis.__fakeBlob ||= new Map());
export async function put(path, body) {
  store.set(path, typeof body === 'string' ? body : Buffer.from(await new Response(body).arrayBuffer()).toString());
  return { pathname: path, url: `https://blob.test/${path}` };
}
export async function get(path) {
  return store.has(path) ? { statusCode: 200, stream: new Response(store.get(path)).body } : null;
}
export async function del(paths) {
  for (const p of [].concat(paths)) store.delete(p);
}
export async function list() {
  return { blobs: [...store.keys()].map((pathname) => ({ pathname })), hasMore: false };
}
export async function presignUrl() {
  throw new Error('presignUrl is not available in tests');
}
export async function issueSignedToken() {
  throw new Error('issueSignedToken is not available in tests');
}
