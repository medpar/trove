// Trove database schema: one Notion database for everything you save. X bookmarks live in it
// as their own content type ("X bookmark") with extra X columns. Shared by the extension, the
// web app and the scripts. Also: create the database, add missing properties (self-healing),
// and set up handy views.

export const X_TYPE = 'X bookmark';

export const L = {
  title: 'Title', url: 'URL', key: 'URL key', domain: 'Domain', type: 'Type', platform: 'Platform', collection: 'Collection',
  tags: 'Tags', description: 'Description', text: 'Text', note: 'Note', author: 'Author', site: 'Site', published: 'Published',
  saved: 'Saved', updated: 'Updated', favorite: 'Favorite', read: 'Read', cover: 'Cover', highlights: 'Highlights', words: 'Words',
  readingTime: 'Reading time', duration: 'Duration', lang: 'Language', source: 'Source', via: 'Via', status: 'Status', checked: 'Checked',
  remind: 'Remind', media: 'Media',
  // AI, archive and reading (Trove 3)
  summary: 'Summary', fulltext: 'Full text', embedding: 'Embedding', progress: 'Progress', snapshot: 'Snapshot', archive: 'Archive',
  enriched: 'Enriched',
  // X bookmarks
  handle: 'Handle', postId: 'Post ID', postKind: 'Post kind', bookmarked: 'Bookmarked', unroll: 'Unroll thread', threadLen: 'Thread length',
  likes: 'Likes', reposts: 'Reposts', replies: 'Replies', quotes: 'Quotes', bookmarks: 'Bookmarks', views: 'Views', links: 'Links',
  link: 'Link', hashtags: 'Hashtags', mentions: 'Mentions', verified: 'Verified', followers: 'Followers', quoted: 'Quoted post',
  replyTo: 'Reply to', client: 'Client',
};

/** Property names used by the X sync. */
export const P = {
  title: L.title,
  author: L.author,
  handle: L.handle,
  url: L.url,
  id: L.postId,
  text: L.text,
  posted: L.published,
  bookmarked: L.bookmarked,
  saved: L.saved,
  type: L.postKind,
  kind: L.type,
  platform: L.platform,
  domain: L.domain,
  site: L.site,
  key: L.key,
  tags: L.tags,
  read: L.read,
  unroll: L.unroll,
  threadLen: L.threadLen,
  likes: L.likes,
  reposts: L.reposts,
  replies: L.replies,
  quotes: L.quotes,
  bookmarks: L.bookmarks,
  views: L.views,
  media: L.media,
  links: L.links,
  link: L.link,
  hashtags: L.hashtags,
  mentions: L.mentions,
  lang: L.lang,
  verified: L.verified,
  followers: L.followers,
  quoted: L.quoted,
  replyTo: L.replyTo,
  source: L.source,
  client: L.client,
  favorite: L.favorite,
  collection: L.collection,
  note: L.note,
};

const opt = (name, color) => ({ name, color });

export const TYPES = ['Article', 'Video', 'Post', X_TYPE, 'Link', 'Image', 'Document', 'Audio', 'Repo', 'Note', 'Product', 'Paper'];
const TYPE_COLORS = ['brown', 'red', 'blue', 'default', 'gray', 'pink', 'gray', 'purple', 'green', 'yellow', 'orange', 'brown'];

/** What an X post contains (multi-select "Post kind"). */
export const TYPE_OPTIONS = [
  opt('Text', 'default'), opt('Photo', 'blue'), opt('Video', 'red'), opt('GIF', 'pink'), opt('Link', 'green'),
  opt('Quote', 'purple'), opt('Reply', 'gray'), opt('Thread', 'orange'), opt('Article', 'brown'), opt('Poll', 'yellow'),
  opt('Long post', 'default'),
];

export const SOURCES = ['Web app', 'Extension', 'Agent', 'API', 'Browser bookmarks', 'Import', 'Share', 'Bookmarklet', 'Shortcut', 'Bookmark', 'Manual', 'Pinterest', 'Telegram', 'Email', 'Feed', 'Raycast'];
const SOURCE_COLORS = ['blue', 'purple', 'orange', 'gray', 'yellow', 'brown', 'green', 'pink', 'red', 'blue', 'green', 'red', 'blue', 'yellow', 'orange', 'pink'];

/** Collections Trove files things into by itself. Agents never use these for anything else. */
export const X_COLLECTION = 'X bookmarks';
export const BROWSER_COLLECTION = 'Browser bookmarks';
export const PINTEREST_COLLECTION = 'Pinterest';

/** Dedupe key for an X post (matches the web app's urlKey()). */
export const xKey = (id) => `x.com/status/${id}`;

export function librarySchema() {
  const num = { number: { format: 'number' } };
  return {
    [L.title]: { title: {} },
    [L.url]: { url: {} },
    [L.key]: { rich_text: {} },
    [L.domain]: { rich_text: {} },
    [L.type]: { select: { options: TYPES.map((t, i) => opt(t, TYPE_COLORS[i])) } },
    [L.platform]: { select: { options: [] } },
    [L.collection]: { select: { options: [] } },
    [L.tags]: { multi_select: { options: [] } },
    [L.description]: { rich_text: {} },
    [L.text]: { rich_text: {} },
    [L.note]: { rich_text: {} },
    [L.author]: { rich_text: {} },
    [L.site]: { rich_text: {} },
    [L.published]: { date: {} },
    [L.saved]: { created_time: {} },
    [L.updated]: { last_edited_time: {} },
    [L.favorite]: { checkbox: {} },
    [L.read]: { checkbox: {} },
    [L.cover]: { url: {} },
    [L.highlights]: num,
    [L.words]: num,
    [L.readingTime]: num,
    [L.duration]: num,
    [L.lang]: { select: { options: [] } },
    [L.source]: { select: { options: SOURCES.map((n, i) => opt(n, SOURCE_COLORS[i])) } },
    [L.via]: { rich_text: {} },
    [L.status]: { select: { options: [opt('OK', 'green'), opt('Broken', 'red'), opt('Redirect', 'yellow')] } },
    [L.checked]: { date: {} },
    [L.remind]: { date: {} },
    [L.media]: { files: {} },
    [L.summary]: { rich_text: {} },
    [L.fulltext]: { rich_text: {} },
    [L.embedding]: { rich_text: {} },
    [L.progress]: num,
    [L.snapshot]: { files: {} },
    [L.archive]: { url: {} },
    [L.enriched]: { date: {} },
    // X bookmarks
    [L.handle]: { rich_text: {} },
    [L.postId]: { rich_text: {} },
    [L.postKind]: { multi_select: { options: TYPE_OPTIONS } },
    [L.bookmarked]: { date: {} },
    [L.unroll]: { checkbox: {} },
    [L.threadLen]: num,
    [L.likes]: num,
    [L.reposts]: num,
    [L.replies]: num,
    [L.quotes]: num,
    [L.bookmarks]: num,
    [L.views]: num,
    [L.links]: { rich_text: {} },
    [L.link]: { url: {} },
    [L.hashtags]: { rich_text: {} },
    [L.mentions]: { rich_text: {} },
    [L.verified]: { checkbox: {} },
    [L.followers]: num,
    [L.quoted]: { url: {} },
    [L.replyTo]: { url: {} },
    [L.client]: { select: { options: [] } },
  };
}

/** Kept for older callers: the whole schema. */
export const schemaProperties = librarySchema;

/** Create the Trove database. parent: { pageId } or { workspace: true }. */
export async function createDatabase(notion, parent, title = 'Trove') {
  const db = await notion.req('POST', '/databases', {
    parent: parent.pageId ? { type: 'page_id', page_id: parent.pageId } : { type: 'workspace', workspace: true },
    title: [{ type: 'text', text: { content: title } }],
    icon: { type: 'emoji', emoji: '🗂️' },
    description: [{ type: 'text', text: { content: 'Everything saved with Trove: links, articles, videos, posts, your X bookmarks, repos, PDFs and notes, with an archived copy of the content.' } }],
    initial_data_source: { properties: librarySchema() },
  });
  const dataSourceId = db.data_sources?.[0]?.id;
  return { databaseId: db.id, dataSourceId, url: db.url };
}

/** Resolve the data source of a database (or accept a data source id directly). */
export async function resolveDataSource(notion, id) {
  try {
    const db = await notion.getDatabase(id);
    return { databaseId: db.id, dataSourceId: db.data_sources?.[0]?.id, url: db.url, title: plain(db.title) };
  } catch (e) {
    const ds = await notion.getDataSource(id);
    return { databaseId: ds.parent?.database_id, dataSourceId: ds.id, url: ds.url, title: plain(ds.title) };
  }
}

const plain = (rt) => (rt || []).map((t) => t.plain_text).join('');

/**
 * Add any properties and select options that are missing (after an upgrade or a manual delete).
 * Never renames or removes anything. Returns the property id map.
 */
export async function ensureSchema(notion, dataSourceId) {
  const ds = await notion.getDataSource(dataSourceId);
  const want = librarySchema();
  const have = ds.properties || {};
  const patch = {};
  for (const [name, def] of Object.entries(want)) {
    if (name === L.title) continue;
    const cur = have[name];
    if (!cur) {
      patch[name] = def;
      continue;
    }
    // Make sure the options Trove filters on exist (filters on unknown options fail).
    const kind = Object.keys(def)[0];
    if ((kind === 'select' || kind === 'multi_select') && cur.type === kind && def[kind].options.length && cur[kind]?.options) {
      const names = new Set(cur[kind].options.map((o) => o.name));
      const add = def[kind].options.filter((o) => !names.has(o.name));
      if (add.length) patch[name] = { [kind]: { options: [...cur[kind].options.map(({ id, name: n, color }) => ({ id, name: n, color })), ...add] } };
    }
  }
  // The title property may have a different name (e.g. "Name") in a user-picked database.
  const titleName = Object.entries(have).find(([, v]) => v.type === 'title')?.[0];
  if (titleName && titleName !== L.title && !have[L.title]) patch[titleName] = { name: L.title };
  if (Object.keys(patch).length) {
    const updated = await notion.updateDataSource(dataSourceId, { properties: patch });
    return idMap(updated.properties);
  }
  return idMap(have);
}

const idMap = (props) => Object.fromEntries(Object.entries(props || {}).map(([k, v]) => [k, v.id]));

/** Best-effort views for X bookmarks inside the Trove database. */
export async function createViews(notion, { databaseId, dataSourceId }) {
  const isX = { property: L.type, select: { equals: X_TYPE } };
  const sortNewest = [{ property: L.bookmarked, direction: 'descending' }, { timestamp: 'created_time', direction: 'descending' }];
  const views = [
    { name: 'X bookmarks', type: 'table', filter: isX },
    { name: 'X threads', type: 'table', filter: { and: [isX, { property: L.postKind, multi_select: { contains: 'Thread' } }] } },
    { name: 'X media', type: 'gallery', filter: { and: [isX, { or: [{ property: L.postKind, multi_select: { contains: 'Photo' } }, { property: L.postKind, multi_select: { contains: 'Video' } }] }] }, configuration: { type: 'gallery', cover: { type: 'page_content' }, cover_size: 'large', cover_aspect: 'cover' } },
  ];
  const created = [];
  for (const v of views) {
    try {
      await notion.req('POST', '/views', { database_id: databaseId, data_source_id: dataSourceId, sorts: sortNewest, ...v });
      created.push(v.name);
    } catch {
      // Sorting by a timestamp may be unsupported in view sorts; retry with the property sort only.
      try {
        await notion.req('POST', '/views', { database_id: databaseId, data_source_id: dataSourceId, sorts: [sortNewest[0]], ...v });
        created.push(v.name);
      } catch { /* views are optional */ }
    }
  }
  return created;
}
