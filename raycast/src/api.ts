import { getPreferenceValues } from "@raycast/api";

export const DEFAULT_URL = "https://trove.mariomedpar.com";
const SOURCE = "Raycast";

export type Item = {
  id: string;
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
  source: string | null;
  via: string;
  notionUrl: string;
  summary?: string;
};

export type SearchResult = { items: Item[]; mode: "hybrid" | "keyword" | "recent"; note?: string };

export type Facet = { name: string; count: number; color?: string };
export type Stats = { total: number; collections: Facet[]; tags: Facet[] };

export type SaveInput = {
  url?: string;
  text?: string;
  title?: string;
  note?: string;
  tags?: string[];
  collection?: string;
  highlight?: string;
  favorite?: boolean;
  read?: boolean;
  /** Hints Trove only uses when it cannot read the page itself (e.g. the tab title). */
  meta?: { title?: string };
};

export type SaveResult = { item: Item; created: boolean };
export type ItemPatch = Partial<Pick<Item, "favorite" | "read" | "tags" | "note" | "title">> & {
  collection?: string | null;
};
export type AskResult = { answer: string; sources: Item[] };

export class TroveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TroveError";
  }
}

export function baseUrl(): string {
  const { troveUrl } = getPreferenceValues<Preferences>();
  const url = (troveUrl || "").trim().replace(/\/+$/, "");
  if (!url) return DEFAULT_URL;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export const troveLink = (id: string) => `${baseUrl()}/?item=${encodeURIComponent(id)}`;

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { apiKey } = getPreferenceValues<Preferences>();
  const root = baseUrl();
  let res: Response;
  try {
    res = await fetch(`${root}${path}`, {
      method: init.method || "GET",
      signal: init.signal,
      headers: {
        Authorization: `Bearer ${(apiKey || "").trim()}`,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new TroveError(`Could not reach Trove at ${root}`, 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = null;
  }
  if (!res.ok) {
    const fromServer =
      data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : "";
    const message =
      res.status === 401
        ? "Invalid API key. Check the extension preferences."
        : fromServer || `Trove responded with HTTP ${res.status}`;
    throw new TroveError(message, res.status);
  }
  if (data === null) throw new TroveError("Trove sent a response that is not JSON. Check the Trove URL.", res.status);
  return data as T;
}

export function saveItem(input: SaveInput): Promise<SaveResult> {
  return request<SaveResult>("/api/items", { method: "POST", body: { ...input, source: SOURCE } });
}

export async function listItems(q: string, limit = 20, signal?: AbortSignal): Promise<Item[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (q.trim()) params.set("q", q.trim());
  const res = await request<{ items: Item[] }>(`/api/items?${params}`, { signal });
  return res.items || [];
}

/** Semantic/hybrid search. Throws if the endpoint is missing or failing. */
export async function smartSearch(q: string, limit = 20, signal?: AbortSignal): Promise<SearchResult> {
  const params = new URLSearchParams({ q: q.trim(), mode: "smart", limit: String(limit) });
  const res = await request<{ items?: Item[]; mode?: string; note?: string }>(`/api/search?${params}`, { signal });
  return { items: res.items || [], mode: res.mode === "keyword" ? "keyword" : "hybrid", note: res.note };
}

// Set once /api/search answers 404 so later keystrokes go straight to keyword search.
let smartMissing = false;

/**
 * Empty query: newest items. "smart": /api/search, falling back to keyword search
 * (GET /api/items?q=) if that endpoint is missing or failing. "keyword": keyword search only.
 */
export async function search(q: string, mode: "smart" | "keyword", signal?: AbortSignal): Promise<SearchResult> {
  if (!q.trim()) return { items: await listItems("", 20, signal), mode: "recent" };
  let note: string | undefined;
  if (mode === "smart" && !smartMissing) {
    try {
      return await smartSearch(q, 20, signal);
    } catch (e) {
      if ((e as Error)?.name === "AbortError" || (e instanceof TroveError && e.status === 401)) throw e;
      if (e instanceof TroveError && (e.status === 404 || e.status === 405)) smartMissing = true;
      else note = `Smart search failed (${errorMessage(e)}); showing keyword results.`;
    }
  }
  return { items: await listItems(q, 20, signal), mode: "keyword", note };
}

export function getItem(id: string): Promise<{ item: Item; markdown: string | null }> {
  return request(`/api/items/${encodeURIComponent(id)}?content=1`);
}

export async function updateItem(id: string, patch: ItemPatch): Promise<Item> {
  const res = await request<{ item: Item }>(`/api/items/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  return res.item;
}

export function getStats(): Promise<Stats> {
  return request<Stats>("/api/stats");
}

export async function ask(question: string): Promise<AskResult> {
  const res = await request<Partial<AskResult>>("/api/ask", { method: "POST", body: { question } });
  return { answer: res.answer || "", sources: Array.isArray(res.sources) ? res.sources : [] };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
