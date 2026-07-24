# VLC / libVLC notices

Ani Tracker uses libVLC as the built-in player on Electron, Android, and iOS.
The remote web player remains ArtPlayer-based and does not load libVLC.

The desktop package dynamically loads the shared libraries from
`resources/libvlc/<platform-arch>`. Users may replace that entire directory
with an ABI-compatible VLC 3.0.x build for the same operating system and CPU
architecture. Ani Tracker does not statically link libVLC.

The complete LGPL 2.1 text is shipped as `LGPL-2.1-only.json` and as plain
text in desktop packages. Desktop packages also retain the upstream VLC or
distribution GPL notice. See `SOURCE.md` and the generated `SOURCE.json` for
exact source and binary provenance.

This notice is informational and is not legal advice. A release owner should
review the selected VLC modules and codecs before public distribution.
