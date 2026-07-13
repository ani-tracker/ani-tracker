# Ani Tracker Detailed Design Plan

## Product Goal

Ani Tracker is a local desktop anime tracking tool. It manages seasonal discovery, followed anime, release matching, BT downloads, media probing, player launching, and daily reminders.

The first platform target is Windows. macOS should remain compatible at the interface level, while Linux and deeper platform polish can follow later.

## Technology Stack

- Desktop shell: Electron
- UI: React, TypeScript, Vite, shadcn/ui-style components, Tailwind CSS
- Local data: SQLite in a later implementation phase
- Download engine: bundled qBittorrent-nox by default
- Compatibility: optional external qBittorrent Web API adapter
- Media probing: ffprobe or MediaInfo
- Player launch: platform-specific player profiles

## Core Principle

Every replaceable capability should sit behind an interface:

- MetadataProvider
- ReleaseSource
- TorrentEngine
- MediaInfoExtractor
- MediaProbeService
- PlayerService
- PlatformService
- NotificationService

This keeps source adapters, BT engines, players, and platform behavior independent from the UI.

## Main Data Areas

- Anime catalog: metadata from Bangumi, AniList, Mikan, or manual input.
- My anime: followed anime with premiere year/month, status, default fansub, auto-download settings, and optional per-anime download directory.
- Episodes: episode number, air time, and lifecycle status.
- Episode preferences: per-episode fansub or release override.
- Releases: normalized resources from RSS, Torznab, site adapters, or manual magnet/torrent input.
- Download tasks: task status, speed, progress, selected files, and engine metadata.
- Media files: real downloaded files with normalized codec, container, resolution, bit depth, audio tracks, subtitle tracks, and scan time.
- Settings: download paths, user data path, player profiles, automation, and download engine.

## Download Strategy

The application should not require users to install qBittorrent manually.

The preferred model is:

- Default: managed bundled qBittorrent-nox.
- Optional: external QbittorrentEngine for users who already run qBittorrent.
- UI: always talks to the unified TorrentEngine interface.

The qB-compatible state model must include:

- progress
- download speed
- upload speed
- ETA
- task state
- file list
- per-file progress
- selected file priority

## Media Extraction Strategy

Media metadata is extracted through a chain:

1. Release title extractor
2. File name extractor
3. ffprobe extractor
4. MediaInfo extractor
5. Manual override extractor

Final field precedence:

- Manual override
- Real probe result
- File name parse
- Release title parse

The stored codec should be normalized to:

- H.264/AVC
- H.265/HEVC
- AV1
- VP9
- Unknown

Raw labels like x265, HEVC, H265, hvc1, AVC, or x264 should also be retained where useful.

## UI Pages

- Home: today's updates, pending actions, active downloads, recent completed files, weekly schedule, source health.
- My Anime: followed anime grouped by premiere year/month, default fansub, auto-download status, and preferences.
- Discovery: collect previous-month or seasonal anime, search aliases, add to following list.
- Downloads: active and completed tasks, progress, speed, file-level selection.
- Sources: RSS, Torznab, site adapters, manual input.
- Settings: download directory, user data directory, player profiles, automation, and engine settings.

## Implementation Phases

1. Scaffold Electron, React, TypeScript, Vite, Tailwind, and base UI.
2. Add shared domain types and service interfaces.
3. Build static UI shell with mocked IPC data.
4. Add SQLite storage and settings persistence.
5. Add my-anime management and episode preferences.
6. Add RSS and Torznab release source adapters.
7. Add qBittorrent-compatible adapter to validate the download workflow.
8. Add EmbeddedTorrentEngine.
9. Add ffprobe/MediaInfo probing.
10. Add player profiles and platform services.
11. Add reminders, tray, startup behavior, and packaging.

## Current Scaffold Status

The current repository contains:

- Electron main process
- Preload bridge
- Shared domain and service contracts
- JSON-backed persistent dashboard and application data
- React UI shell
- Home, My Anime, Discovery, Downloads, Sources, and Settings pages
- My Anime CRUD and per-episode fansub overrides
- Episode release search and ranked candidate preview
- AniList-backed monthly anime discovery and local anime catalog
- Media extraction chain and ffprobe media probing
- qBittorrent state mapping helper
- qBittorrent Web API adapter with progress, speed, ETA, task actions, and file priority selection
- DMHY / 动漫花园, Mikan / 蜜柑计划, AniBT, and ACGNX site adapters
- Future SQLite schema at `src/main/core/storage/schema.sql`
- Download engine adapters and monitor service
- Release title parser and automatic matching score
- Player launch and reveal-file integration
- Manual and scheduled automation run with desktop notification support
- In-app notification center with local notification history
- Tray integration, close-to-background behavior, and launch-at-login settings
- Manual and tray-triggered automation scan cooldown
- Dynamic daily reminder summary on Home
- Daily reminder notification generation

Detailed implementation status is maintained in `docs/progress.md`.

## Local Build Note

Install dependencies and run the Electron development process from the project directory:

```powershell
pnpm.cmd install
pnpm.cmd dev
```

Type checking and production build:

```powershell
pnpm.cmd exec tsc --noEmit --pretty false
pnpm.cmd build
```
