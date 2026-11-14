import {
  Action,
  ActionPanel,
  Color,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { useCachedPromise, useCachedState } from "@raycast/utils";
import { useRef, useState } from "react";
import { getItem, search, troveLink, updateItem, type Item, type ItemPatch, type SearchResult } from "./api";
import { cleanNotionMarkdown, formatDate, itemIcon, itemTitle, markdownLink, showError } from "./utils";

type Mode = "smart" | "keyword";

const MAX_CONTENT = 30000;

export default function SearchTrove() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("smart");
  const [showingDetail, setShowingDetail] = useCachedState("show-detail", false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const abortable = useRef<AbortController | null>(null);

  const { data, isLoading, error, mutate, revalidate } = useCachedPromise(
    (q: string, m: Mode) => search(q, m, abortable.current?.signal),
    [query, mode],
    {
      keepPreviousData: true,
      abortable,
      onError: (e) => showError("Search failed", e),
    },
  );

  const content = useCachedPromise((id: string) => getItem(id).then((r) => r.markdown), [selectedId || ""], {
    execute: showingDetail && !!selectedId,
    onError: () => undefined,
  });

  const items = data?.items || [];

  async function patch(item: Item, change: ItemPatch, doing: string, done: string) {
    const toast = await showToast({ style: Toast.Style.Animated, title: doing });
    try {
      await mutate(updateItem(item.id, change), {
        optimisticUpdate: (d: SearchResult | undefined) =>
          d && { ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, ...change } : i)) },
        shouldRevalidateAfter: false,
      });
      toast.style = Toast.Style.Success;
      toast.title = done;
    } catch (e) {
      await showError("Could not update item", e, toast);
    }
  }

  const sectionTitle =
    data?.mode === "recent" ? "Recently Saved" : data?.mode === "hybrid" ? "Smart Results" : "Keyword Results";

  return (
    <List
      isLoading={isLoading}
      filtering={false}
      throttle
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Search Trove (#tag, type:video, site:x.com, is:fav…)"
      isShowingDetail={showingDetail && items.length > 0}
      onSelectionChange={setSelectedId}
      searchBarAccessory={
        <List.Dropdown tooltip="Search Mode" storeValue onChange={(v) => setMode(v as Mode)}>
          <List.Dropdown.Item title="Smart Search" value="smart" icon={Icon.Stars} />
          <List.Dropdown.Item title="Keyword Search" value="keyword" icon={Icon.MagnifyingGlass} />
        </List.Dropdown>
      }
    >
      {error && !items.length ? (
        <List.EmptyView
          icon={Icon.Warning}
          title="Could not search Trove"
          description={error.message}
          actions={
            <ActionPanel>
              <Action title="Retry" icon={Icon.ArrowClockwise} onAction={revalidate} />
              <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
            </ActionPanel>
          }
        />
      ) : (
        <List.EmptyView
          icon={Icon.MagnifyingGlass}
          title={query ? "No results" : "Nothing saved yet"}
          description={query ? "Try other words, or operators like #tag or type:article." : undefined}
        />
      )}
      <List.Section title={sectionTitle} subtitle={data?.note || (items.length ? String(items.length) : undefined)}>
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            showingDetail={showingDetail}
            markdown={item.id === selectedId ? content.data : undefined}
            contentLoading={item.id === selectedId && content.isLoading}
            onToggleDetail={() => setShowingDetail((s) => !s)}
            onPatch={patch}
            onRefresh={revalidate}
          />
        ))}
      </List.Section>
    </List>
  );
}

function ItemRow(props: {
  item: Item;
  showingDetail: boolean;
  markdown: string | null | undefined;
  contentLoading: boolean;
  onToggleDetail: () => void;
  onPatch: (item: Item, change: ItemPatch, doing: string, done: string) => Promise<void>;
  onRefresh: () => void;
}) {
  const { item, showingDetail } = props;
  const title = itemTitle(item);
  const inTrove = troveLink(item.id);
  const link = item.url || inTrove;
  const collectionLeaf = item.collection?.split("/").pop();

  const accessories: List.Item.Accessory[] = showingDetail
    ? item.favorite
      ? [{ icon: { source: Icon.Star, tintColor: Color.Yellow }, tooltip: "Favorite" }]
      : []
    : [
        ...(item.favorite ? [{ icon: { source: Icon.Star, tintColor: Color.Yellow }, tooltip: "Favorite" }] : []),
        ...item.tags.slice(0, 2).map((t) => ({ tag: `#${t}` })),
        ...(item.tags.length > 2 ? [{ text: `+${item.tags.length - 2}`, tooltip: item.tags.slice(2).join(", ") }] : []),
        ...(collectionLeaf ? [{ icon: Icon.Folder, text: collectionLeaf, tooltip: item.collection || undefined }] : []),
      ];

  return (
    <List.Item
      icon={itemIcon(item)}
      title={title}
      subtitle={showingDetail ? undefined : item.domain || item.type}
      keywords={item.tags}
      accessories={accessories}
      detail={<ItemDetail item={item} markdown={props.markdown} loading={props.contentLoading} />}
      actions={
        <ActionPanel title={title}>
          <ActionPanel.Section>
            {item.url ? <Action.OpenInBrowser title="Open Original" url={item.url} /> : null}
            <Action.OpenInBrowser
              title="Open in Trove"
              url={inTrove}
              icon={Icon.Bookmark}
              shortcut={{ modifiers: ["cmd"], key: "t" }}
            />
            <Action
              title={showingDetail ? "Hide Details" : "Show Details"}
              icon={Icon.Sidebar}
              shortcut={{ modifiers: ["cmd"], key: "d" }}
              onAction={props.onToggleDetail}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action.CopyToClipboard title="Copy Link" content={link} shortcut={Keyboard.Shortcut.Common.Copy} />
            <Action.CopyToClipboard
              title="Copy as Markdown Link"
              content={markdownLink(title, link)}
              shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title={item.favorite ? "Remove from Favorites" : "Add to Favorites"}
              icon={item.favorite ? Icon.StarDisabled : Icon.Star}
              shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
              onAction={() =>
                props.onPatch(
                  item,
                  { favorite: !item.favorite },
                  item.favorite ? "Removing from favorites…" : "Adding to favorites…",
                  item.favorite ? "Removed from favorites" : "Added to favorites",
                )
              }
            />
            <Action
              title={item.read ? "Mark as Unread" : "Mark as Read"}
              icon={item.read ? Icon.Circle : Icon.CheckCircle}
              shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
              onAction={() =>
                props.onPatch(
                  item,
                  { read: !item.read },
                  item.read ? "Marking as unread…" : "Marking as read…",
                  item.read ? "Marked as unread" : "Marked as read",
                )
              }
            />
            {item.notionUrl ? (
              <Action.OpenInBrowser
                title="Open in Notion"
                url={item.notionUrl}
                icon={Icon.Document}
                shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
              />
            ) : null}
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={props.onRefresh}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function ItemDetail({
  item,
  markdown,
  loading,
}: {
  item: Item;
  markdown: string | null | undefined;
  loading: boolean;
}) {
  const parts = [`# ${itemTitle(item).replace(/\n/g, " ")}`];
  if (item.cover && /image/i.test(item.type)) parts.push(`![](${item.cover})`);
  if (markdown) {
    const body = cleanNotionMarkdown(markdown);
    parts.push(body.length > MAX_CONTENT ? `${body.slice(0, MAX_CONTENT)}\n\n…` : body);
  } else {
    if (item.summary) parts.push(item.summary);
    else if (item.excerpt) parts.push(item.excerpt);
    if (item.note) parts.push(`**Note:** ${item.note}`);
    if (loading) parts.push("_Loading content…_");
  }

  return (
    <List.Item.Detail
      markdown={parts.join("\n\n")}
      metadata={
        <List.Item.Detail.Metadata>
          {item.url ? (
            <List.Item.Detail.Metadata.Link title="Link" text={item.domain || item.url} target={item.url} />
          ) : null}
          <List.Item.Detail.Metadata.Label title="Type" text={item.type || "Link"} />
          {item.collection ? (
            <List.Item.Detail.Metadata.Label title="Collection" text={item.collection} icon={Icon.Folder} />
          ) : null}
          {item.tags.length ? (
            <List.Item.Detail.Metadata.TagList title="Tags">
              {item.tags.map((t) => (
                <List.Item.Detail.Metadata.TagList.Item key={t} text={t} />
              ))}
            </List.Item.Detail.Metadata.TagList>
          ) : null}
          <List.Item.Detail.Metadata.Label
            title="Status"
            text={[item.favorite ? "Favorite" : null, item.read ? "Read" : "Unread"].filter(Boolean).join(" · ")}
          />
          {item.author ? <List.Item.Detail.Metadata.Label title="Author" text={item.author} /> : null}
          <List.Item.Detail.Metadata.Label title="Saved" text={formatDate(item.created)} />
          {item.source ? <List.Item.Detail.Metadata.Label title="Source" text={item.source} /> : null}
        </List.Item.Detail.Metadata>
      }
    />
  );
}
