// OpenAPI description of the Trove REST API (served at /openapi.json) for agents and tools.
export function openapi(base: string) {
  const item = {
    type: 'object',
    properties: {
      id: { type: 'string' }, db: { type: 'string', enum: ['library', 'x'] }, url: { type: 'string' }, title: { type: 'string' },
      excerpt: { type: 'string' }, type: { type: 'string' }, platform: { type: 'string' }, collection: { type: 'string', nullable: true },
      tags: { type: 'array', items: { type: 'string' } }, note: { type: 'string' }, favorite: { type: 'boolean' }, read: { type: 'boolean' },
      created: { type: 'string', format: 'date-time' }, notionUrl: { type: 'string' },
    },
  };
  const saveBody = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Link to save (optional when saving text).' },
      text: { type: 'string', description: 'Plain text or a message; saved as a note, or as a link if it contains one URL.' },
      title: { type: 'string' }, note: { type: 'string' },
      tags: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', description: 'comma separated' }] },
      collection: { type: 'string', description: 'Nested collections use "/" e.g. "Dev/AI"' },
      highlight: { type: 'string', description: 'Quote to keep as a highlight' },
      favorite: { type: 'boolean' }, read: { type: 'boolean' }, remind: { type: 'string', format: 'date' },
      via: { type: 'string', description: 'Name of the agent/app saving (shown as "Via")' },
      archive: { type: 'boolean', description: 'false = metadata only (faster bulk imports)' },
    },
  };
  const fileFields = {
    title: { type: 'string' }, description: { type: 'string', description: 'What the file shows or contains (searchable)' }, note: { type: 'string' },
    tags: { type: 'string', description: 'comma separated (or an array in JSON)' }, collection: { type: 'string' },
    url: { type: 'string', description: 'Original link the file came from' }, favorite: { type: 'boolean' }, duration: { type: 'number', description: 'Seconds (videos, audio)' },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Trove API',
      version: '2.4.0',
      description:
        'Personal library: save links/content (articles, videos, social posts, repos, PDFs, notes) and files (images, videos, audio, documents) into Notion with full-text archive, then search, tag and organize. Auth: Authorization: Bearer <API key>. MCP endpoint: ' +
        `${base}/api/mcp`,
    },
    servers: [{ url: base }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: { Item: item, SaveInput: saveBody } },
    security: [{ bearer: [] }],
    paths: {
      '/api/items': {
        get: {
          operationId: 'searchItems',
          summary: 'Search / list items (newest first)',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search syntax: words, "phrase", -word, #tag, type:video, site:domain, collection:"Name", is:fav, is:unread, created:>2025-01' },
            { name: 'collection', in: 'query', schema: { type: 'string' } },
            { name: 'tag', in: 'query', schema: { type: 'string' } },
            { name: 'type', in: 'query', schema: { type: 'string' } },
            { name: 'source', in: 'query', schema: { type: 'string', enum: ['all', 'library', 'x'] } },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['newest', 'oldest', 'title', 'title_desc', 'site', 'published'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Items', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Item' } }, cursor: { type: 'string', nullable: true } } } } } } },
        },
        post: {
          operationId: 'saveItem',
          summary: 'Save a link or note (deduplicated). Body may also be {items:[...]} with up to 25 entries.',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/SaveInput' } } } },
          responses: { 201: { description: 'Created' }, 200: { description: 'Already saved (merged)' } },
        },
      },
      '/api/items/{id}': {
        get: { operationId: 'getItem', summary: 'Get an item; content=1 adds the archived Markdown', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'content', in: 'query', schema: { type: 'boolean' } }], responses: { 200: { description: 'Item' } } },
        patch: { operationId: 'updateItem', summary: 'Update title, tags, collection, note, favorite, read, remind', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'Item' } } },
        delete: { operationId: 'deleteItem', summary: 'Move to trash', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deleted' } } },
      },
      '/api/items/{id}/highlights': {
        post: { operationId: 'addHighlight', summary: 'Add a highlight', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { text: { type: 'string' }, note: { type: 'string' } }, required: ['text'] } } } }, responses: { 200: { description: 'Item' } } },
      },
      '/api/items/bulk': { post: { operationId: 'bulkUpdate', summary: 'Bulk move/tag/untag/favorite/read/delete', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, action: { type: 'string' }, value: {} } } } } }, responses: { 200: { description: 'Result' } } } },
      '/api/files': {
        post: {
          operationId: 'saveFile',
          summary: 'Save an image, video, audio file or document (deduplicated by content). Up to 4 MB per request; bigger files: POST /api/files/uploads first.',
          parameters: [{ name: 'filename', in: 'query', schema: { type: 'string' }, description: 'With a raw body: the file name (fields like tags and collection can be query params too)' }],
          requestBody: {
            content: {
              'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, ...fileFields, poster: { type: 'string', format: 'binary', description: 'Cover image for a video' } } } },
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'string', description: 'File contents as base64 or a data: URL' },
                    file_url: { type: 'string', description: 'Public direct link Notion can download' },
                    upload: { type: 'string', description: 'Token from POST /api/files/uploads, after PUTting the bytes' },
                    filename: { type: 'string' }, content_type: { type: 'string' },
                    ...fileFields,
                  },
                },
              },
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: { 201: { description: 'Created {item, created}' }, 200: { description: 'Same file saved before: merged {item, created: false}' } },
        },
      },
      '/api/files/uploads': {
        post: {
          operationId: 'createUpload',
          summary: 'Upload URL for a file over 4 MB (up to 1 GB). PUT the bytes to put.url with put.headers, then POST /api/files {upload}.',
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['filename', 'size'], properties: { filename: { type: 'string' }, size: { type: 'integer' }, content_type: { type: 'string' }, sha256: { type: 'string', description: 'Skip the upload when this file was saved before' }, ...fileFields } } } } },
          responses: {
            200: {
              description: '{upload, put: {method, url, headers}, expires} or, for a file saved before, {duplicate: true, created: false, item}',
            },
          },
        },
      },
      '/api/lookup': { get: { operationId: 'lookup', summary: 'Which URLs are already saved', parameters: [{ name: 'url', in: 'query', schema: { type: 'array', items: { type: 'string' } }, style: 'form', explode: true }], responses: { 200: { description: 'Map url -> item|null' } } } },
      '/api/stats': { get: { operationId: 'stats', summary: 'Counts: collections, tags, types, filters', responses: { 200: { description: 'Stats' } } } },
      '/api/facets': { patch: { operationId: 'renameFacet', summary: 'Rename/merge/remove a tag or collection', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { kind: { type: 'string', enum: ['tag', 'collection'] }, from: { type: 'string' }, to: { type: 'string' } } } } } }, responses: { 200: { description: 'Changed count' } } } },
      '/api/export': { get: { operationId: 'export', summary: 'Export as json, csv, html (Netscape) or txt', parameters: [{ name: 'format', in: 'query', schema: { type: 'string' } }, { name: 'q', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'File' } } } },
    },
  };
}
