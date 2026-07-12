# Ani Tracker Progress

Last updated: 2026-07-13

## Implemented

- Electron + React + TypeScript + Vite + Tailwind desktop scaffold.
- Main/preload/renderer IPC bridge.
- Shared domain model and contracts.
- JSON-backed local repository with migration support.
- Future SQLite schema.
- Home, My Anime, Discovery, Release Search, Downloads, Sources, and Settings pages.
- Daily reminder summary on Home:
  - computes today's followed episodes from My Anime and episode air times
  - summarizes total, upcoming, actionable, downloading, and completed counts
  - shows each episode's time, default fansub, status, and linked download task state.
- Daily reminder notifications:
  - creates one reminder notification per local date when followed episodes air today
  - skips duplicate daily reminder records
  - uses the existing desktop notification preference.
- RSS and Torznab release source adapters.
- DMHY / 动漫花园 site adapter:
  - searches `share.dmhy.org/topics/list`
  - parses title, magnet link, torrent link, publish time, and size from list HTML
  - reuses release title enrichment for fansub, episode, resolution, subtitle, and codec.
- Release title parsing for fansub, episode number, resolution, subtitle language, and codec.
- Release ranking using anime aliases, episode number, default fansub, per-episode fansub override, resolution, codec, subtitle, and seeders.
- qBittorrent Web API compatible adapter:
  - add URL/torrent
  - list tasks
  - progress
  - speed
  - ETA
  - file list
  - pause/resume/remove
  - per-file priority selection
- Download queue auto-refresh and file selection UI.
- Player launch and reveal-file IPC.
- Media extraction chain from release title and file name.
- ffprobe-based media probing with fallback to filename/title parsing.
- Download task media scan and MediaFile upsert.
- Completed download media auto-scan:
  - runs after download status refresh
  - scans completed/seeding tasks in the background
  - skips tasks already represented in media files
  - logs scan results and failures
  - keeps progress refresh responsive.
- Settings for download paths, storage paths, players, qB, embedded engine placeholder, automation, and media probing.
- My Anime CRUD:
  - title/original title
  - aliases
  - premiere year/month
  - status
  - default fansub
  - auto-download flag
  - resolution/codec/subtitle preferences
  - per-anime download directory
- Episode and episode preference persistence in JSON.
- Per-episode rules:
  - add next episode
  - edit episode status
  - inherit default fansub
  - override fansub per episode
- Episode release preview:
  - searches title/original title/aliases
  - ranks candidates
  - displays top candidates
  - can add a candidate to the download queue.
- Manual automation run:
  - scans followed anime with auto-download enabled
  - applies a short cooldown to repeated manual or tray-triggered scans
  - respects global auto-download setting
  - respects per-anime auto-download setting
  - respects per-episode fansub override
  - skips episodes already downloading/downloaded/watched
  - ranks release candidates
  - adds the best candidate to the download queue
  - updates episode status to downloading
  - exposes result counts in the top "scan updates" UI.
- Scheduled automation:
  - starts with the Electron main process
  - uses the configured scan interval
  - can be enabled/disabled from Settings
  - restarts when settings are saved
  - prevents concurrent scans
  - exposes scheduler status, next run time, last run time, and last result in Settings.
- Desktop notifications:
  - sends a notification after scheduled/manual automation adds downloads or hits errors
  - respects the "new episode notification" setting.
- Notification center:
  - stores notification history in local JSON data
  - shows automation/download/system reminders in the app
  - supports unread state
  - supports marking one/all as read
  - supports clearing all records.
- Desktop integration:
  - adds tray menu actions for showing the main window, scanning updates, and quitting
  - supports closing the main window to the tray while keeping background scans alive
  - supports a launch-at-login setting for Windows/macOS
  - applies desktop integration settings immediately after Settings is saved.
- New anime discovery:
  - stores a local anime catalog separate from "My Anime"
  - collects monthly anime from AniList by season/year and filters by premiere month
  - supports local catalog search by title/original title/aliases
  - supports month filtering
  - can add catalog items to My Anime from the Discovery page.

## Verified

These commands pass:

```powershell
pnpm.cmd exec tsc --noEmit --pretty false
pnpm.cmd build
```

Known non-blocking warning:

- Electron/Vite still prints an ES module warning during build. Output is generated successfully.

## Not Implemented Yet

- Additional metadata sources such as Bangumi and Mikan seasonal data.
- More site-specific source adapters beyond DMHY.
- Real embedded BT engine. `EmbeddedTorrentEngine` is still a placeholder.
- Bundled qBittorrent/qBittorrent-nox lifecycle for users who do not install qB manually.
- SQLite repository implementation replacing JSON storage.
- madVR playback pipeline or external renderer integration.

## Next Recommended Work

1. Add Bangumi and Mikan metadata providers for discovery fallback.
2. Replace JSON repository with SQLite once the domain behavior stabilizes.
