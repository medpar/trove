export type Item = {
  id: string;
  db: 'library';
  url: string;
  title: string;
  excerpt: string;
  domain: string;
  type: string;
  platform: string;
  collection: string | null;
  tags: string[];
  cover: string | null;
  icon: string | null;
  author: string;
  published: string | null;
  created: string;
  updated: string;
  favorite: boolean;
  read: boolean;
  note: string;
  status: string | null;
  highlights: number;
  readingTime: number | null;
  duration: number | null;
  remind: string | null;
  source: string | null;
  via: string;
  notionUrl: string;
  summary?: string;
  progress?: number | null;
  archive?: string | null;
  snapshot?: boolean;
  stats?: Record<string, number | null>;
};

export type Facet = { name: string; color: string; count: number };

export type Stats = {
  total: number;
  library: number;
  x: number;
  unsorted: number;
  favorites: number;
  unread: number;
  notes: number;
  highlights: number;
  broken: number;
  reminders: number;
  noTags: number;
  collections: Facet[];
  tags: Facet[];
  types: Facet[];
  platforms: Facet[];
};

export type View = 'cards' | 'list' | 'headlines' | 'mood';
export type Sort = 'newest' | 'oldest' | 'title' | 'title_desc' | 'site' | 'published';

export type ScopeKind = 'all' | 'unsorted' | 'favorites' | 'unread' | 'highlights' | 'notes' | 'reminders' | 'broken' | 'notag' | 'collection' | 'tag' | 'type' | 'source' | 'feeds';
export type Scope = { kind: ScopeKind; value?: string };
