# Trove for iPhone and iPad

A native SwiftUI client for Trove: browse your library, search (operators or plain language), read archived articles in a native reader, highlight, listen, edit, save links, notes, photos and files, ask your library, follow feeds, and pick up podcasts and videos where you left off on Spotify or YouTube (Shows).

- iOS / iPadOS 17 or later; uses the Liquid Glass design on iOS 26+.
- No dependencies. About 1.3 MB.
- Sign in with your Trove password or an API key from Settings in the web app (one field; keys are tried first, then the password).

## Install (LiveContainer, SideStore, AltStore)

```bash
ios/scripts/build-ipa.sh            # -> ios/build/Trove.ipa (unsigned; the installer signs it)
```

Open the IPA in LiveContainer (or SideStore/AltStore) and sign in. The server defaults to `https://trove.mariomedpar.com`; tap "Connect to…" on the sign-in screen to use another one.

LiveContainer can't register app extensions, so saving from the Share sheet still goes through the Trove Shortcuts or Telegram.

## How it's built

| Folder | What's inside |
|---|---|
| `Trove/Core` | API client (Bearer key or session cookie), Keychain storage with a file fallback, library state with optimistic edits, paged lists, image pipeline (downsampling, memory + disk cache), uploads |
| `Trove/Reader` | Notion-flavored Markdown → TextKit rendering in one `UITextView` (real text selection, highlights, lazy images, reading progress), Listen with AVSpeechSynthesizer |
| `Trove/Views` | Split view (sidebar, list, reader), sheets for saving, editing, Ask, feeds and settings |
| `Trove/Views/ShowsView.swift` | Shows (`docs/shows.md`): Continue, recently finished, and each followed show by series, with buttons that open the episode in the Spotify or YouTube app at the time you stopped (their universal links; the web when the app isn't installed). Opening Shows asks the server to sync your phone's progress when the last sync is over 10 minutes old, as the web app does |

Memory stays around 60 MB while browsing: list covers are decoded at display size, reader images live only in a size-limited cache, and the last-known lists and counts are cached on disk so the app opens instantly.

## Developing

Open `ios/Trove.xcodeproj` in Xcode 26 or later. To try the app against your real library without changing it, run the dev proxy and sign in to `http://127.0.0.1:8787` with `trove-dev-key` (or password `trove-dev-password`):

```bash
node ios/DevProxy/proxy.mjs
```

It forwards reads to the server in `~/.config/trove/config.json` and keeps every write (edits, deletes, saves, uploads, highlights, feeds, episodes marked in Shows) in memory; a Shows sync is answered without running. Debug builds also accept `TROVE_DEV_*` launch environment variables (see `Trove/Core/DevHooks.swift`; for Shows: `DEST=shows`, `SHOW=<show id>`, `SERIES`, `FILTER`, `PLAY`, `MARK`) for scripted simulator checks; release builds ignore them.
