import { Icon, Image, openExtensionPreferences, showToast, Toast } from "@raycast/api";
import { errorMessage, TroveError, type Item, type SaveResult } from "./api";

/** Failure toast; offers the preferences when the key or URL is the problem. Reuses `toast` if given. */
export async function showError(title: string, e: unknown, toast?: Toast): Promise<void> {
  const fixable = e instanceof TroveError && (e.status === 401 || e.status === 0);
  const t = toast ?? (await showToast({ style: Toast.Style.Failure, title }));
  t.style = Toast.Style.Failure;
  t.title = title;
  t.message = errorMessage(e);
  if (fixable) t.primaryAction = { title: "Open Extension Preferences", onAction: () => openExtensionPreferences() };
}

/** "a, b ,c" + ["c", "d"] -> ["a", "b", "c", "d"] (case-insensitive dedupe, original casing kept). */
export function mergeTags(picked: string[] = [], typed = ""): string[] {
  const all = [...picked, ...typed.split(",")].map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
  const seen = new Set<string>();
  return all.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const hudFor = (r: SaveResult) => (r.created ? "Saved to Trove" : "Already in Trove");

const TYPE_ICONS: Record<string, Icon> = {
  note: Icon.Document,
  image: Icon.Image,
  video: Icon.Video,
  audio: Icon.Music,
  article: Icon.Paragraph,
  repo: Icon.Code,
  post: Icon.Bubble,
  "x bookmark": Icon.Bird,
  file: Icon.Document,
  document: Icon.Document,
};

export function typeIcon(item: Pick<Item, "type">): Icon {
  return TYPE_ICONS[(item.type || "").toLowerCase()] || Icon.Link;
}

export function itemIcon(item: Item): Image.ImageLike {
  if (!item.domain) return typeIcon(item);
  return {
    source: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(item.domain)}&sz=64`,
    fallback: typeIcon(item),
  };
}

export const itemTitle = (item: Item) => item.title?.trim() || item.domain || item.url || "Untitled";

const escapeMd = (s: string) => s.replace(/([[\]\\])/g, "\\$1");

export const markdownLink = (title: string, url: string) => `[${escapeMd(title)}](${url})`;

/** Notion's page markdown uses a few HTML-ish tags Raycast cannot render. */
export function cleanNotionMarkdown(md: string): string {
  return md
    .replace(
      /<(video|audio|embed|file|pdf|image)\s+src="([^"]+)"[^>]*>(?:\s*<\/\1>)?/gi,
      (_m, kind: string, src: string) => {
        const label = kind.toLowerCase() === "image" ? "Image" : kind[0].toUpperCase() + kind.slice(1).toLowerCase();
        return kind.toLowerCase() === "image" ? `![${label}](${src})` : `[${label}](${src})`;
      },
    )
    .replace(/<mention-(?:page|database)\s+url="([^"]+)"[^>]*>([^<]*)<\/mention-(?:page|database)>/gi, "[$2]($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/?(callout|details|summary|columns|column|empty-block|span|toggle|synced_block|table_of_contents|unknown|mention-[a-z]+)\b[^>]*>/gi,
      "",
    );
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
