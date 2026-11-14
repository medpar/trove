import { BrowserExtension, Clipboard, environment, getFrontmostApplication } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";

export type Tab = { url: string; title?: string };

type Browser = { name: string; bundleId: string; kind: "safari" | "chromium" };

const BROWSERS: Browser[] = [
  { name: "Safari", bundleId: "com.apple.Safari", kind: "safari" },
  { name: "Arc", bundleId: "company.thebrowser.Browser", kind: "chromium" },
  { name: "Google Chrome", bundleId: "com.google.Chrome", kind: "chromium" },
  { name: "Brave Browser", bundleId: "com.brave.Browser", kind: "chromium" },
  { name: "Microsoft Edge", bundleId: "com.microsoft.edgemac", kind: "chromium" },
];

const isWebUrl = (s: string | null | undefined): boolean => !!s && /^https?:\/\/\S+$/i.test(s.trim());

/** Front tab of one browser via AppleScript. Never launches the browser. */
async function appleScriptTab(b: Browser): Promise<Tab | null> {
  const tab = b.kind === "safari" ? "current tab of front window" : "active tab of front window";
  const title = b.kind === "safari" ? "name" : "title";
  const script = `
    if application id "${b.bundleId}" is not running then return ""
    tell application id "${b.bundleId}"
      if (count of windows) is 0 then return ""
      set t to ${tab}
      return (URL of t) & linefeed & (${title} of t)
    end tell`;
  const out = await runAppleScript(script, { timeout: 4000 });
  const [url, ...rest] = out.split("\n");
  return url && isWebUrl(url) ? { url: url.trim(), title: rest.join("\n").trim() || undefined } : null;
}

/** Active tab reported by the Raycast browser extension, if it is installed. */
async function extensionTab(): Promise<Tab | null> {
  if (!environment.canAccess(BrowserExtension)) return null;
  const tabs = await BrowserExtension.getTabs();
  const active = tabs.find((t) => t.active && isWebUrl(t.url));
  return active ? { url: active.url, title: active.title } : null;
}

const attempt = async (fn: () => Promise<Tab | null>) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

/**
 * The tab the user is looking at:
 * 1. if the frontmost app is a known browser, its front tab (AppleScript; exact),
 * 2. the Raycast browser extension's active tab (works for any browser it supports),
 * 3. the front tab of the first running known browser.
 */
export async function getFrontTab(): Promise<Tab | null> {
  const front = await attempt(async () => {
    const app = await getFrontmostApplication();
    const browser = BROWSERS.find((b) => b.bundleId === app.bundleId || b.name === app.name);
    return browser ? appleScriptTab(browser) : null;
  });
  if (front) return front;

  const fromExtension = await attempt(extensionTab);
  if (fromExtension) return fromExtension;

  for (const b of BROWSERS) {
    const tab = await attempt(() => appleScriptTab(b));
    if (tab) return tab;
  }
  return null;
}

/** The clipboard's URL, if it holds exactly one. */
export async function clipboardUrl(): Promise<string | null> {
  const text = (await Clipboard.readText())?.trim();
  return text && isWebUrl(text) ? text : null;
}

export { isWebUrl };
