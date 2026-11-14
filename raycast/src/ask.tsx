import { Action, ActionPanel, Detail, Form, Icon, Keyboard, LaunchProps, useNavigation } from "@raycast/api";
import { FormValidation, useForm, usePromise } from "@raycast/utils";
import { ask, errorMessage, troveLink, TroveError, type Item } from "./api";
import { itemTitle, markdownLink, showError } from "./utils";

export default function AskTrove(props: LaunchProps<{ arguments: Arguments.Ask }>) {
  const question = props.arguments.question?.trim();
  return question ? <Answer question={question} /> : <AskForm />;
}

function AskForm() {
  const { push } = useNavigation();
  const { handleSubmit, itemProps } = useForm<{ question: string }>({
    initialValues: { question: "" },
    validation: { question: FormValidation.Required },
    onSubmit: (v) => push(<Answer question={v.question.trim()} />),
  });
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Ask Trove" icon={Icon.Stars} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextArea
        title="Question"
        placeholder="What did I save about…?"
        info="Answers come only from what you saved in Trove, with sources."
        autoFocus
        {...itemProps.question}
      />
    </Form>
  );
}

const sourceUrl = (s: Item) => s.url || troveLink(s.id);

/** Turn [1] and [1, 2] citations into links to the matching sources. */
function linkCitations(answer: string, sources: Item[]): string {
  return answer.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?![(:])/g, (whole, nums: string) => {
    const refs = nums.split(",").map((n) => Number(n.trim()));
    if (!refs.every((n) => sources[n - 1])) return whole;
    return refs.map((n) => `[\\[${n}\\]](${sourceUrl(sources[n - 1])})`).join("");
  });
}

function sourcesMarkdown(sources: Item[]): string {
  return sources
    .map((s, i) => {
      const extra = [s.domain || s.type, s.url ? markdownLink("Open in Trove", troveLink(s.id)) : null].filter(Boolean);
      return `${i + 1}. ${markdownLink(itemTitle(s), sourceUrl(s))}${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
    })
    .join("\n");
}

function describeError(e: unknown): { title: string; message: string } {
  if (e instanceof TroveError && (e.status === 404 || e.status === 405))
    return {
      title: "Ask isn't available yet",
      message: "This Trove doesn't have /api/ask deployed yet. Try again after the next deploy.",
    };
  if (e instanceof TroveError && e.status === 503)
    return { title: "Ask is unavailable right now", message: errorMessage(e) };
  return { title: "Could not get an answer", message: errorMessage(e) };
}

function Answer({ question }: { question: string }) {
  const { data, isLoading, error, revalidate } = usePromise(ask, [question], {
    onError: (e) => showError(describeError(e).title, e),
  });

  const heading = `## ${question.replace(/\n+/g, " ")}`;
  let markdown: string;
  if (error) {
    const { title, message } = describeError(error);
    markdown = `${heading}\n\n**${title}.** ${message}`;
  } else if (!data) {
    markdown = `${heading}\n\n_Searching your library and writing an answer…_`;
  } else {
    markdown = `${heading}\n\n${linkCitations(data.answer || "_No answer._", data.sources)}`;
    if (data.sources.length) markdown += `\n\n---\n\n### Sources\n\n${sourcesMarkdown(data.sources)}`;
  }

  const plain = data
    ? `${data.answer}${data.sources.length ? `\n\nSources:\n${data.sources.map((s, i) => `[${i + 1}] ${itemTitle(s)} ${sourceUrl(s)}`).join("\n")}` : ""}`
    : "";

  return (
    <Detail
      navigationTitle="Ask Trove"
      isLoading={isLoading}
      markdown={markdown}
      actions={
        <ActionPanel>
          {data ? <Action.CopyToClipboard title="Copy Answer" content={plain} /> : null}
          {error ? <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={revalidate} /> : null}
          <Action.Push
            title="Ask Another Question"
            icon={Icon.Stars}
            target={<AskForm />}
            shortcut={Keyboard.Shortcut.Common.New}
          />
          {data?.sources.length ? (
            <ActionPanel.Section title="Sources">
              {data.sources.map((s, i) => (
                <Action.OpenInBrowser key={s.id} title={`${i + 1}. ${itemTitle(s)}`} url={sourceUrl(s)} />
              ))}
            </ActionPanel.Section>
          ) : null}
        </ActionPanel>
      }
    />
  );
}
