export const DESKTOP_LIBVLC_VERSION = "3.0.21";

export const DESKTOP_LIBVLC_SOURCE = Object.freeze({
  archiveName: `vlc-${DESKTOP_LIBVLC_VERSION}.tar.xz`,
  archiveSha256: "24dbbe1d7dfaeea0994d5def0bbde200177347136dbfe573f5b6a4cee25afbb0",
  url: `https://get.videolan.org/vlc/${DESKTOP_LIBVLC_VERSION}/vlc-${DESKTOP_LIBVLC_VERSION}.tar.xz`
});

export const DESKTOP_LIBVLC_ASSETS = Object.freeze({
  "win32-x64": Object.freeze({
    targetKey: "win32-x64",
    platform: "win32",
    arch: "x64",
    archiveName: `vlc-${DESKTOP_LIBVLC_VERSION}-win64.zip`,
    archiveSha256: "a0b7ec02b50adf6417eed014fb8df50af39690505a4225b85b3dc2ed17d14843",
    url: `https://get.videolan.org/vlc/${DESKTOP_LIBVLC_VERSION}/win64/vlc-${DESKTOP_LIBVLC_VERSION}-win64.zip`
  }),
  "darwin-x64": Object.freeze({
    targetKey: "darwin-x64",
    platform: "darwin",
    arch: "x64",
    archiveName: `vlc-${DESKTOP_LIBVLC_VERSION}-intel64.dmg`,
    archiveSha256: "d431fd051c3dc7af02bd313c6d05d90cf604b70ed3ec5bba6fd4c49ef3e638d9",
    url: `https://get.videolan.org/vlc/${DESKTOP_LIBVLC_VERSION}/macosx/vlc-${DESKTOP_LIBVLC_VERSION}-intel64.dmg`
  }),
  "darwin-arm64": Object.freeze({
    targetKey: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    archiveName: `vlc-${DESKTOP_LIBVLC_VERSION}-arm64.dmg`,
    archiveSha256: "15dd65bf6489da9ec6a67f5585c74c40a58993acff41a82958a916dd74178044",
    url: `https://get.videolan.org/vlc/${DESKTOP_LIBVLC_VERSION}/macosx/vlc-${DESKTOP_LIBVLC_VERSION}-arm64.dmg`
  }),
  "linux-x64": Object.freeze({
    targetKey: "linux-x64",
    platform: "linux",
    arch: "x64"
  })
});

/** 返回桌面平台对应的固定 libVLC 资源描述。 */
export function findDesktopLibVlcAsset(platform, arch) {
  return DESKTOP_LIBVLC_ASSETS[`${platform}-${arch}`];
}
