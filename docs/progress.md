# Ani Tracker Progress

Last updated: 2026-07-12

## Implemented

- Electron + React + TypeScript + Vite + Tailwind desktop scaffold.
- Main/preload/renderer IPC bridge.
- Shared domain model and contracts.
- JSON-backed local repository with migration support.
- Future SQLite schema.
- Home, My Anime, Discovery, Release Search, Downloads, Sources, and Settings pages.
- RSS and Torznab release source adapters.
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

- Daily reminder summary view.
- Additional metadata sources such as Bangumi and Mikan seasonal data.
- Site-specific source adapters such as full DMHY scraping/adapter behavior.
- Real embedded BT engine. `EmbeddedTorrentEngine` is still a placeholder.
- Bundled qBittorrent/qBittorrent-nox lifecycle for users who do not install qB manually.
- SQLite repository implementation replacing JSON storage.
- madVR playback pipeline or external renderer integration.
- Tray/startup/background scheduling behavior.

## Next Recommended Work

1. Add an automation run service:
   - add tray behavior
   - avoid repeated manual scans within a short cooldown window.
2. Add Bangumi and Mikan metadata providers for discovery fallback.
3. Add a dedicated notification/reminder history view.
4. Replace JSON repository with SQLite once the domain behavior stabilizes.
