// File uploads: content types, names, upload tokens, and how files are split into Notion parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentTypeFor, decodeBase64, fileNameFor, kindOf, mimeOf, readUpload, signUpload, sniff, titleFromFileName } from '../web/lib/media.ts';
import { Notion } from '../extension/lib/notion.js';

const bytes = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

test('content types come from what was declared, then the bytes, then the name', () => {
  assert.equal(mimeOf('Photo.JPG'), 'image/jpeg');
  assert.equal(mimeOf('clip.mov'), 'video/quicktime');
  assert.equal(mimeOf('notes'), null);
  assert.equal(sniff(bytes([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 0])), 'image/png');
  assert.equal(sniff(bytes([0xff, 0xd8, 0xff, 0xe0], [0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniff(bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 0, 0])), 'video/mp4');
  assert.equal(sniff(bytes([0, 0, 0, 0x18], 'ftypqt  ', [0, 0, 0, 0])), 'video/quicktime');
  assert.equal(sniff(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0])), 'image/heic');
  assert.equal(sniff(bytes('%PDF-1.7\n', [0, 0, 0])), 'application/pdf');
  assert.equal(sniff(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'image/webp');
  assert.equal(contentTypeFor('image/jpg', 'x'), 'image/jpeg');
  assert.equal(contentTypeFor('application/octet-stream', 'a.png'), 'image/png');
  assert.equal(contentTypeFor('', 'blob', bytes('%PDF-1.4', [0, 0, 0, 0])), 'application/pdf');
  assert.equal(contentTypeFor('video/mp4; codecs=avc1', 'x.bin'), 'video/mp4');
  assert.equal(contentTypeFor(undefined, 'mystery'), 'application/octet-stream');
});

test('kinds and file names', () => {
  assert.equal(kindOf('image/png'), 'Image');
  assert.equal(kindOf('video/webm'), 'Video');
  assert.equal(kindOf('audio/mpeg'), 'Audio');
  assert.equal(kindOf('application/pdf'), 'Document');
  assert.equal(fileNameFor('shot.png', 'image/png'), 'shot.png');
  assert.equal(fileNameFor('photo.jpeg', 'image/jpeg'), 'photo.jpeg');
  assert.equal(fileNameFor('shot.png', 'image/jpeg'), 'shot.jpg');
  assert.equal(fileNameFor('report v1.5', 'application/pdf'), 'report v1.5.pdf');
  assert.equal(fileNameFor('', 'video/mp4'), 'video.mp4');
  assert.equal(fileNameFor('../../etc/x:y?.png', 'image/png'), 'x y .png');
  assert.equal(fileNameFor('archive.zip', 'application/zip'), 'archive.zip');
  assert.equal(titleFromFileName('IMG_2024-05-01_holiday-pic.jpg'), 'IMG 2024-05-01 holiday pic');
  assert.deepEqual([...decodeBase64('data:image/png;base64,AQID')], [1, 2, 3]);
  assert.deepEqual([...decodeBase64('AQID')], [1, 2, 3]);
});

test('upload tokens are signed and expire', () => {
  const t = { p: 'uploads/abc/clip.mp4', n: 'clip.mp4', t: 'video/mp4', s: 123, e: Date.now() + 3600e3 };
  const token = signUpload(t, 'secret');
  assert.deepEqual(readUpload(token, 'secret'), t);
  assert.equal(readUpload(token, 'other secret'), null);
  assert.equal(readUpload(token.replace(/\.(.)/, (_m, c) => `.${c === 'A' ? 'B' : 'A'}`), 'secret'), null);
  assert.equal(readUpload('up_garbage', 'secret'), null);
  assert.equal(readUpload(token, 'secret', t.e + 25 * 3600e3), null, 'expired past the grace period');
  const outside = signUpload({ ...t, p: 'other/place' }, 'secret');
  assert.equal(readUpload(outside, 'secret'), null, 'only staged uploads');
});

function fakeNotion() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.notion.com/v1', '');
    if (init.body instanceof FormData) {
      const file = init.body.get('file');
      calls.push({ path, part: Number(init.body.get('part_number')) || null, size: file.size, name: file.name });
      return Response.json({ status: 'pending' });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    if (path === '/file_uploads') return Response.json({ id: 'fu1', status: 'pending' });
    return Response.json({ id: 'fu1', status: 'uploaded' });
  };
  return { notion: new Notion('t', { rps: 1000, fetchImpl }), calls };
}

const streamOf = (size, chunk) =>
  new ReadableStream({
    start(c) {
      for (let off = 0; off < size; off += chunk) c.enqueue(new Uint8Array(Math.min(chunk, size - off)));
      c.close();
    },
  });

test('small streams are sent in one request', async () => {
  const { notion, calls } = fakeNotion();
  const id = await notion.uploadStream(streamOf(3_000_000, 65536), 3_000_000, 'a.png', 'image/png');
  assert.equal(id, 'fu1');
  assert.deepEqual(calls[0].body, { mode: 'single_part', filename: 'a.png', content_type: 'image/png' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].size, 3_000_000);
  assert.equal(calls[1].part, null);
});

test('big streams go in 10 MB parts and are completed', async () => {
  const MB = 1024 * 1024;
  const size = 24 * MB + 12345;
  const { notion, calls } = fakeNotion();
  await notion.uploadStream(streamOf(size, 3 * MB + 7), size, 'v.mp4', 'video/mp4');
  assert.deepEqual(calls[0].body, { mode: 'multi_part', number_of_parts: 3, filename: 'v.mp4', content_type: 'video/mp4' });
  const parts = calls.filter((c) => c.part);
  assert.deepEqual(parts.map((p) => p.part), [1, 2, 3]);
  assert.deepEqual(parts.map((p) => p.size), [10 * MB, 10 * MB, 4 * MB + 12345]);
  assert.equal(calls.at(-1).path, '/file_uploads/fu1/complete');
});

test('a stream shorter than announced fails instead of saving a broken file', async () => {
  const { notion } = fakeNotion();
  await assert.rejects(notion.uploadStream(streamOf(1000, 100), 2000, 'a.png', 'image/png'), /Expected 2000 bytes/);
  await assert.rejects(notion.uploadStream(streamOf(21 * 1024 * 1024, 1 << 20), 31 * 1024 * 1024, 'v.mp4', 'video/mp4'), /Expected 4 parts/);
});

test('sizes in messages match the documented limits', async () => {
  const { formatSize, DIRECT_MAX, STAGED_MAX } = await import('../web/lib/media.ts');
  assert.equal(formatSize(DIRECT_MAX), '4 MB');
  assert.equal(formatSize(STAGED_MAX), '1 GB');
  assert.equal(formatSize(24_466_865), '24.5 MB');
});
