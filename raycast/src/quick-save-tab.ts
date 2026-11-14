import { closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { errorMessage, saveItem } from "./api";
import { getFrontTab } from "./browser";
import { hudFor } from "./utils";

export default async function QuickSaveTab() {
  const tab = await getFrontTab();
  if (!tab) {
    await showToast({
      style: Toast.Style.Failure,
      title: "No browser tab found",
      message: "Open a page in Safari, Arc, Chrome, Brave or Edge (or install the Raycast browser extension).",
    });
    return;
  }
  // Trove may take a few seconds to read the page; don't keep Raycast open meanwhile.
  await closeMainWindow({ clearRootSearch: true });
  try {
    const res = await saveItem({ url: tab.url, meta: tab.title ? { title: tab.title } : undefined });
    await showHUD(hudFor(res));
  } catch (e) {
    await showHUD(`Could not save to Trove: ${errorMessage(e)}`);
  }
}
