import { Action, ActionPanel, Form, Icon, PopToRootType, showHUD, showToast, Toast } from "@raycast/api";
import { useCachedPromise, useForm } from "@raycast/utils";
import { useEffect, useRef, useState } from "react";
import { getStats, saveItem } from "./api";
import { clipboardUrl, getFrontTab, isWebUrl } from "./browser";
import { hudFor, mergeTags, showError } from "./utils";

type Values = {
  url: string;
  title: string;
  collection: string;
  newCollection: string;
  tags: string[];
  newTags: string;
  note: string;
};

const looksLikeUrl = (v: string) => isWebUrl(v) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v.trim());

export default function SaveToTrove() {
  const [prefilling, setPrefilling] = useState(true);
  const [tabTitle, setTabTitle] = useState<string>();
  const prefilledUrl = useRef<string | undefined>(undefined);

  const { data: stats, isLoading: statsLoading } = useCachedPromise(getStats, [], {
    keepPreviousData: true,
    onError: (e) => showError("Could not load collections and tags", e),
  });
  const collections = [...(stats?.collections || [])].sort((a, b) => a.name.localeCompare(b.name));
  const tags = stats?.tags || [];

  const { handleSubmit, itemProps, setValue, values } = useForm<Values>({
    initialValues: { url: "", title: "", collection: "", newCollection: "", tags: [], newTags: "", note: "" },
    validation: {
      url: (v) => (!v?.trim() ? "Required" : looksLikeUrl(v) ? undefined : "Enter a URL"),
    },
    async onSubmit(v) {
      const toast = await showToast({ style: Toast.Style.Animated, title: "Saving to Trove…" });
      const tagList = mergeTags(v.tags, v.newTags);
      const url = v.url.trim();
      try {
        const res = await saveItem({
          url,
          title: v.title.trim() || undefined,
          collection: v.newCollection.trim().replace(/^\/+|\/+$/g, "") || v.collection || undefined,
          tags: tagList.length ? tagList : undefined,
          note: v.note.trim() || undefined,
          meta: tabTitle && url === prefilledUrl.current ? { title: tabTitle } : undefined,
        });
        await toast.hide();
        await showHUD(hudFor(res), { clearRootSearch: true, popToRootType: PopToRootType.Immediate });
      } catch (e) {
        await showError("Could not save", e, toast);
      }
    },
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tab = await getFrontTab();
      const url = tab?.url || (await clipboardUrl().catch(() => null));
      if (cancelled) return;
      if (url) {
        prefilledUrl.current = url;
        setValue("url", url);
        if (tab?.url === url && tab.title) setTabTitle(tab.title);
      }
      setPrefilling(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Form
      isLoading={prefilling || statsLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save to Trove" icon={Icon.SaveDocument} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField title="URL" placeholder="https://…" autoFocus {...itemProps.url} />
      <Form.TextField
        title="Title"
        placeholder={tabTitle && values.url === prefilledUrl.current ? tabTitle : "Optional (Trove reads the page)"}
        info="Leave empty to use the page's own title."
        {...itemProps.title}
      />
      <Form.Separator />
      <Form.Dropdown title="Collection" {...itemProps.collection}>
        <Form.Dropdown.Item value="" title="No collection" icon={Icon.Tray} />
        <Form.Dropdown.Section title="Collections">
          {collections.map((c) => (
            <Form.Dropdown.Item key={c.name} value={c.name} title={c.name} icon={Icon.Folder} />
          ))}
        </Form.Dropdown.Section>
      </Form.Dropdown>
      <Form.TextField
        title="New Collection"
        placeholder="Optional, e.g. Reading/AI"
        info="Creates a collection (nest with /). Overrides the dropdown."
        {...itemProps.newCollection}
      />
      <Form.TagPicker title="Tags" placeholder="Existing tags" {...itemProps.tags}>
        {tags.map((t) => (
          <Form.TagPicker.Item key={t.name} value={t.name} title={t.name} icon={Icon.Tag} />
        ))}
      </Form.TagPicker>
      <Form.TextField title="New Tags" placeholder="Optional, comma-separated" {...itemProps.newTags} />
      <Form.TextArea title="Note" placeholder="Why it matters (optional)" enableMarkdown {...itemProps.note} />
    </Form>
  );
}
