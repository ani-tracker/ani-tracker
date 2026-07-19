# Ani Tracker Detailed Design Plan

## Product Goal

Ani Tracker is a local desktop anime tracking tool. It manages seasonal discovery, followed anime, release matching, BT downloads, media probing, player launching, and daily reminders.

The first platform target is Windows. macOS should remain compatible at the interface level, while Linux and deeper platform polish can follow later.

## Technology Stack

- Desktop shell: Electron
- UI: React, TypeScript, Vite, shadcn/ui-style components, Tailwind CSS
- Local data: SQLite repository with WAL and transactional writes
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
- Anime fansub groups: groups observed from real releases and scoped to the followed anime for default and per-episode selection.
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

## Release Source Network Strategy

- Every release source owns a proxy switch and minimum request interval; the global metadata proxy supplies the actual system or manual proxy transport.
- Requests are serialized per host, deduplicated while in flight, and delayed with bounded random jitter.
- HTTP 403 responses open a persisted 10/20/30-minute circuit; 429 responses honor `Retry-After`, and repeated failures keep the circuit open for at least 30 minutes.
- A daily local-time scheduler incrementally synchronizes enabled sources at 09:00 by default. Startup immediately catches up sources without a successful local-day record.
- RSS uses ETag/Last-Modified validation. Other adapters upsert stable release IDs into SQLite, with a 90-day cache retention window.

Download submission follows a confirmed-task workflow:

1. Prefer magnet URLs; for HTTP torrent URLs, reuse the application network/proxy layer to download and validate bencode metadata before multipart upload.
2. Accept both classic qBittorrent empty/`Ok.` responses and qBittorrent Enhanced JSON results.
3. Confirm the real task by `added_torrent_ids` or the Ani Tracker correlation tag before persisting it.
4. Merge engine state by real torrent hash while preserving anime, episode, and fansub associations; never persist a synthetic pending task as a successful download.

The compatibility layer must treat `Fails.`, zero-success Enhanced results, request timeouts, and confirmation timeouts as errors. Correlation tags read from qBittorrent are normalized because some Enhanced multipart implementations may append boundary text to the final field.

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

## Playback Progress Strategy

- `PlayerAdapter` 定义播放器匹配、启动和播放监控器创建能力。
- `BasePlayerAdapter` 负责统一启动流程，各平台子类只实现差异化能力。
- macOS IINA 通过 `--mpv-input-ipc-server` 接入本地 JSON IPC，监听 `percent-pos`。
- 播放进度首次达到 90% 时，将关联 `Episode.status` 更新为 `watched`。
- IPC 仅使用本地 Unix Socket，不开放网络端口，播放结束后清理 Socket。
- Windows PotPlayer 监控暂不实现；后续在 PotPlayer 控制接口和改用 mpv IPC 之间评估，保持现有抽象接口不变。

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
- SQLite-only application repository with WAL, transactions, schema versioning, and indexes
- Fresh databases are initialized once from the application seed data
- React UI shell
- Home, My Anime, Discovery, Downloads, Sources, and Settings pages
- My Anime CRUD and per-episode fansub overrides
- Episode release search and ranked candidate preview
- AniList-backed monthly anime discovery and local anime catalog
- Media extraction chain and ffprobe media probing
- qBittorrent state mapping helper
- qBittorrent Web API adapter with classic/Enhanced add-result parsing, confirmed hash persistence, progress, speed, ETA, task actions, and file priority selection
- DMHY / 动漫花园, Mikan / 蜜柑计划, AniBT, and ACGNX site adapters
- Active SQLite schema at `src/main/core/storage/schema.sql`
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
