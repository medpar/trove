import { Clipboard, closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { errorMessage, saveItem } from "./api";
import { isWebUrl } from "./browser";
import { hudFor } from "./utils";

export default async function SaveClipboard() {
  const text = (await Clipboard.readText())?.trim();
  if (!text) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Clipboard is empty",
      message: "Copy a URL or some text first.",
    });
    return;
  }
  await closeMainWindow({ clearRootSearch: true });
  try {
    // A URL is saved as a link; anything else becomes a note.
    const res = await saveItem(isWebUrl(text) ? { url: text } : { text });
    await showHUD(isWebUrl(text) ? hudFor(res) : res.created ? "Note saved to Trove" : "Already in Trove");
  } catch (e) {
    await showHUD(`Could not save to Trove: ${errorMessage(e)}`);
  }
}
