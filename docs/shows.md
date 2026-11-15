# Shows: what you watched and listened to, on YouTube and Spotify

Many podcasts are both a YouTube channel and a Spotify show. You watch an episode on YouTube on the Mac, listen to the next one on Spotify on the iPhone, and a month later you can't tell which ones you finished, or you hear one twice. YouTube's own red bar isn't reliable either: it shows videos you finished as unwatched, and videos you skipped through as watched.

Trove keeps **one record per episode** with both platforms on it: what you actually played on each, where you stopped, and whether you finished. You see it in Trove → **Shows**, on youtube.com and open.spotify.com (badges on thumbnails and episode lists, a Resume button on the episode page) and in the **Episodes** database in Notion.

## How progress is measured

- **Played time, not position.** Players are sampled every second; time only counts when the media clock advances about as much as the wall clock (times the playback speed). Seeking forward never counts as watched, rewinding never loses what you heard, ads and buffering don't count. The result is a list of ranges per platform (`[[0, 612], [1500, 2655]]`).
- **Finished** = about 90 % of the episode played, or 70 % including the ending (sponsor reads skipped), or Spotify/YouTube says your account finished it, or you marked it. Across platforms the ranges are combined on a 0–1 timeline: half on YouTube plus half on Spotify is finished. Finishing is sticky: listening again never un-finishes; only “Not finished” does (and it forgets what was played).
- **Resume** is wherever you were last, on either platform. On the other platform the time is the same when both versions have the same length, otherwise proportional (shown with ≈).
- **Nothing is lost.** The page sends its whole session so far every 5 s and right away on pause, end, hiding the tab or leaving it; the extension keeps an outbox in storage (survives a crash or being offline) and uploads it. Sending the same thing twice changes nothing.

## Pairing YouTube videos with Spotify episodes

1. **Followed shows** (Shows → Follow a show): Trove reads every Spotify episode and the videos of the channel's playlists and uploads, then pairs them by title, length and date. A second pass pairs retitled episodes (“Boris Cherny: Building Claude Code” on Spotify is “Boris Cherny: We Cut 80% of Claude Code's Prompt” on YouTube) when they have the same length to the second and the same publish day. On the YC podcast that pairs 293 of 348 episodes automatically; most of the rest are old audio-only episodes.
2. **Everything else**: when you play a Spotify episode, Trove searches YouTube for a video with the same title and length; on the pages, an episode you haven't played on this platform is matched by title and length to one you played on the other.
3. **By hand**: Link / Not the same episode in the episode menu, or type the id in Notion.

## Series

Spotify has no playlists, so the YC podcast is one long list mixing Lightcone, How To Build The Future, Startup School, Design Review, Dalton & Michael… Series come from:

1. the show's **YouTube playlists** (an episode belongs to the series of the first playlist that has its YouTube twin). When you follow a show, Trove picks the channel's playlists that contain its episodes and names series after them;
2. **title rules** (`How To Build The Future: how to build the future`, or a `/regex/`), suggested from repeated prefixes and suffixes;
3. **by hand** per episode (or in Notion's Series column).

## Your iPhone and iPad

The YouTube and Spotify apps can't be changed, and neither platform has an official API that gives your progress without paying (Spotify's Web API needs Premium for personal apps since February 2026; YouTube's Data API has no watch history). What Trove does:

| | How |
|---|---|
| **Spotify app** (phone, iPad, Mac) | Trove's server reads your played state (position and finished, per episode) through the private API Spotify's own web player uses, signed in with your `sp_dc` cookie. Free accounts work. |
| **YouTube app** | Trove's server reads your watch history (videos from every device, with YouTube's “% watched” bar) through InnerTube, YouTube's own API, signed in with cookies from a private-window session. |
| **When** | Every hour (the trove-ai Cloudflare worker's cron), whenever you open Shows, and, with an iOS automation, the moment you close the Spotify or YouTube app. |
| **Checking before you play** | Trove on the Home Screen → Shows: Continue (what's in progress anywhere), each show by series with ✓ / ◐ and buttons that open the episode in the Spotify or YouTube app at the right time. Or from the YouTube/Spotify app itself: Share → Telegram → your Trove bot answers “✅ Already finished on Spotify” or “◐ 34% heard, stopped at 15:03 on YouTube”, with a link to continue there. |
| **Playing inside Trove** | Shows → ▶ plays the episode in an embedded Spotify or YouTube player and tracks it to the second. |

Other options considered: the Trove extension reading the same data from your browser (works, but only while the browser is open); a Safari Web Extension for iPhone (only helps when watching in Safari); Spotify's data export and Google Takeout (no positions, days to weeks old: useful only as a one-off import); the real-time Spotify Connect state (needs a permanent connection, not worth it).

Both sign-ins are private APIs: they can change without notice. Trove re-learns Spotify's request formats from the web player's code and keeps YouTube's rotated cookies like a browser does; when a sign-in stops working, Shows and Settings say so.

## Setting it up

1. Deploy (push `main`). The Episodes database is created next to the Trove database on first use (or set `TROVE_EPISODES_DS`).
2. Reload the extension (2.4.0): it asks for access to open.spotify.com.
3. Connect the sign-ins: extension settings → YouTube & Spotify progress → **Connect Spotify**; for YouTube, sign in to youtube.com in a private window (allow Trove in private windows) and click **Connect from private window**, then close the window. Or paste them in Trove → Settings → Shows. Environment variables `SPOTIFY_SP_DC` and `YOUTUBE_COOKIES` work too.
4. Follow your shows (Shows → Follow a show → the Spotify show link; the YouTube channel is found by itself).
5. Hourly sync: redeploy `workers/ai` (`wrangler deploy`); it uses its existing `TROVE_ENRICH_KEY`.
6. Optional, iPhone: Shortcuts → Automation → App → Spotify, YouTube → Is Closed → Run Immediately → Get Contents of URL `https://<your trove>/api/media/sync?key=<api key>`, method POST.

## Where things live

| | |
|---|---|
| `extension/lib/progress.js` | Played ranges, finishing, merging, matching, series rules (shared, tested) |
| `extension/content/` | youtube.com and open.spotify.com page scripts (tracking, badges) |
| `extension/lib/watch.js` | Outbox, uploads, local copy of your episodes, page matching |
| `web/lib/episodes.ts` | The Episodes database in Notion |
| `web/lib/spotify.ts`, `web/lib/innertube.ts` | Spotify web player API, YouTube InnerTube |
| `web/lib/shows.ts` | Followed shows, catalogs, pairing, series |
| `web/lib/media-sync.ts` | Server sync with your sign-ins (encrypted, `web/lib/vault.ts`) |
| `web/app/api/media/` | REST API (also in `/llms.txt` and `/openapi.json`) |
| `web/components/shows.tsx` | The Shows view and the embedded players |
