import { Action, ActionPanel, Form, Icon, PopToRootType, showHUD, showToast, Toast } from "@raycast/api";
import { FormValidation, useForm } from "@raycast/utils";
import { saveItem } from "./api";
import { mergeTags, showError } from "./utils";

type Values = { text: string; tags: string };

export default function QuickNote() {
  const { handleSubmit, itemProps } = useForm<Values>({
    initialValues: { text: "", tags: "" },
    validation: { text: FormValidation.Required },
    async onSubmit(v) {
      const toast = await showToast({ style: Toast.Style.Animated, title: "Saving note…" });
      const tags = mergeTags([], v.tags);
      try {
        await saveItem({ text: v.text.trim(), tags: tags.length ? tags : undefined });
        await toast.hide();
        await showHUD("Note saved to Trove", { clearRootSearch: true, popToRootType: PopToRootType.Immediate });
      } catch (e) {
        await showError("Could not save note", e, toast);
      }
    },
  });

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Note" icon={Icon.SaveDocument} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextArea title="Note" placeholder="Write anything…" enableMarkdown autoFocus {...itemProps.text} />
      <Form.TextField title="Tags" placeholder="Optional, comma-separated" {...itemProps.tags} />
    </Form>
  );
}
