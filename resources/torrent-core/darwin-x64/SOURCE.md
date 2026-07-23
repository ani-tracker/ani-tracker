# macOS x64 torrent-core source record

- Target: `darwin-x64`
- torrent-core: Ani Tracker `native/torrent-core`, version `0.1.0`
- libtorrent-rasterbar: Homebrew bottle `2.1.0`, BSD-3-Clause
- OpenSSL: Homebrew `3.6.3`, Apache-2.0
- Boost headers: Homebrew `1.90.0`, BSL-1.0
- Build toolchain: Apple Clang, CMake release preset
- Current minimum macOS recorded by the executable: `26.0`

The libtorrent and OpenSSL load commands were rewritten to `@loader_path` and all runtime libraries are stored beside `torrent-core`. Files currently use ad-hoc signatures for local verification; the release pipeline must replace them with the application signing identity and notarize the final package.

This resource is verified for the current macOS x64 development host. A broader deployment target must be rebuilt with the portable preset and tested on the oldest supported macOS before release.
