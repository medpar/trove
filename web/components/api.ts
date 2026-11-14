'use client';
import useSWR, { mutate as globalMutate } from 'swr';
import useSWRInfinite from 'swr/infinite';
import type { Item, Scope, Sort, Stats } from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers || {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: 'same-origin',
  });
  if (res.status === 401 && typeof window !== 'undefined' && !path.includes('/auth/')) {
    window.location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
  return data as T;
}

const fetcher = (url: string) => api(url);

export function scopeParams(scope: Scope): Record<string, string> {
  switch (scope.kind) {
    case 'unsorted':
      return { collection: 'unsorted', source: 'all' };
    case 'favorites':
      return { favorite: '1' };
    case 'unread':
      return { unread: '1' };
    case 'highlights':
      return { highlights: '1' };
    case 'notes':
      return { notes: '1' };
    case 'reminders':
      return { reminders: '1' };
    case 'broken':
      return { broken: '1' };
    case 'notag':
      return { notag: '1' };
    case 'collection':
      return { collection: scope.value || '' };
    case 'tag':
      return { tag: scope.value || '' };
    case 'type':
      return { type: scope.value || '' };
    case 'source':
      return { source: scope.value || 'all' };
    default:
      return {};
  }
}

export function listKey(scope: Scope, q: string, sort: Sort) {
  const p = new URLSearchParams({ ...scopeParams(scope), q, sort, limit: '40' });
  return `/api/items?${p}`;
}

export function useItems(scope: Scope, q: string, sort: Sort, enabled = true) {
  const base = listKey(scope, q, sort);
  const swr = useSWRInfinite<{ items: Item[]; cursor: string | null }>(
    (index, prev) => {
      if (!enabled || (prev && !prev.cursor)) return null;
      return index === 0 ? base : `${base}&cursor=${encodeURIComponent(prev!.cursor!)}`;
    },
    fetcher,
    { revalidateFirstPage: true, revalidateOnFocus: false, keepPreviousData: true, dedupingInterval: 4000 },
  );
  const pages = swr.data || [];
  const items = pages.flatMap((p) => p.items);
  const done = pages.length > 0 && !pages[pages.length - 1].cursor;
  return { ...swr, items, done, base };
}

const OPERATORS = /(^|\s)(-?#|-\w|\w+:|")/;
/** Plain-language queries in All items use hybrid (keyword + meaning) search. */
export const isSmartQuery = (q: string) => q.trim().length > 2 && !OPERATORS.test(q) && !/^https?:\/\//.test(q.trim());

export function useSmartSearch(q: string, enabled: boolean) {
  return useSWR<{ items: Item[]; mode: 'hybrid' | 'keyword'; note?: string }>(enabled && q ? `/api/search?q=${encodeURIComponent(q)}&limit=48` : null, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
    dedupingInterval: 30000,
  });
}

export function useStats() {
  return useSWR<Stats>('/api/stats', fetcher, { revalidateOnFocus: false, dedupingInterval: 15000, keepPreviousData: true });
}

export function useItem(id: string | null) {
  return useSWR<{ item: Item; markdown: string | null }>(id ? `/api/items/${id}?content=1` : null, fetcher, { revalidateOnFocus: false });
}

/** Patch an item locally in every cached list page, then on the server. */
export async function patchItem(id: string, patch: Partial<Item>, server: Record<string, unknown> = patch) {
  const apply = (data: any) => {
    if (!Array.isArray(data)) return data;
    return data.map((page: any) => ({ ...page, items: page.items.map((it: Item) => (it.id === id ? { ...it, ...patch } : it)) }));
  };
  globalMutate((k) => typeof k === 'string' && k.startsWith('$inf$/api/items'), apply, { revalidate: false });
  globalMutate(`/api/items/${id}?content=1`, (d: any) => (d ? { ...d, item: { ...d.item, ...patch } } : d), { revalidate: false });
  const r = await api<{ item: Item }>(`/api/items/${id}`, { method: 'PATCH', json: server });
  globalMutate('/api/stats');
  return r.item;
}

export function removeLocal(ids: string[]) {
  const set = new Set(ids);
  globalMutate(
    (k) => typeof k === 'string' && k.startsWith('$inf$/api/items'),
    (data: any) => (Array.isArray(data) ? data.map((page: any) => ({ ...page, items: page.items.filter((it: Item) => !set.has(it.id)) })) : data),
    { revalidate: false },
  );
}

export function refreshAll() {
  globalMutate((k) => typeof k === 'string' && (k.startsWith('$inf$/api/items') || k.startsWith('/api/stats')));
}

export const favicon = (domain: string, size = 64) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain || 'example.com')}&sz=${size}`;

export function timeAgo(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function fmtDate(iso: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDuration(s: number | null) {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
