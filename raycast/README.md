# Trove for Raycast

Save tabs, links, clipboard and notes to Trove, search your library and ask it questions without leaving Raycast.

## Install

```sh
cd raycast
npm install
npm run dev     # imports the extension into Raycast and watches for changes; Ctrl+C when done
```

The extension stays in Raycast after you stop `npm run dev`. `npm run build` type-checks and builds it.

## Preferences

- **Trove URL**: where the web app runs (default `https://trove.mariomedpar.com`).
- **API Key**: one of the keys in `TROVE_API_KEYS` (the part after `Name:`).

## Commands

| Command | What it does |
| --- | --- |
| Save to Trove | Form prefilled with the front browser tab (or a URL on the clipboard): title, collection (pick or create), tags (pick or type new ones) and a note. |
| Quick Save Tab | Saves the front browser tab right away and shows a HUD. |
| Save Clipboard | Saves the clipboard: a URL becomes a link, anything else a note. |
| Search Trove | Smart (semantic) search with keyword fallback; supports `#tag`, `type:video`, `site:x.com`, `collection:"A/B"`, `is:fav`. ⌘D toggles a detail pane with the saved content. Actions: open original, open in Trove (⌘T), copy link, copy as Markdown link (⇧⌘M), favorite (⇧⌘F), read/unread (⇧⌘R), open in Notion (⇧⌘N). |
| Quick Note | Write a note (with optional tags) and save it. |
| Ask Trove | Ask a question (inline argument or form); shows the answer with linked citations and its sources. |

The front tab comes from Safari, Arc, Google Chrome, Brave or Microsoft Edge via AppleScript (macOS asks once to let Raycast control the browser), or from the Raycast browser extension for other browsers. Everything is saved with source "Raycast".
