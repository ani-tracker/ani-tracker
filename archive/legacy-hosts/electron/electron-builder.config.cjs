const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

/** 仅把当前 runner 已准备好的原生资源加入安装包。 */
const extraResources = ["torrent-core", "ffmpeg", "qbittorrent"]
  .map((name) => ({ name, path: resolve("out", name) }))
  .filter((item) => existsSync(item.path))
  .map((item) => ({ from: item.path, to: item.name }));

const packagePlatform = process.env.ANI_PACKAGE_PLATFORM || process.env.npm_config_platform || process.platform;
const packageArch = process.env.ANI_PACKAGE_ARCH || process.env.npm_config_arch || process.arch;
const libVlcTarget = `${packagePlatform}-${packageArch}`;
const libVlcPath = resolve("out", "libvlc", libVlcTarget);
if (!existsSync(libVlcPath)) {
  throw new Error(`Missing staged libVLC runtime: ${libVlcPath}`);
}
extraResources.push({ from: libVlcPath, to: join("libvlc", libVlcTarget) });
extraResources.push(
  { from: resolve("LICENSE"), to: join("licenses", "ani-tracker-LICENSE.txt") },
  { from: resolve("NOTICE"), to: join("licenses", "ani-tracker-NOTICE.txt") }
);

module.exports = {
  appId: "dev.ani.tracker",
  productName: "Ani Tracker",
  executableName: "Ani Tracker",
  copyright: "Copyright (c) 2026 Ani Tracker contributors. Non-commercial use only.",
  asar: true,
  asarUnpack: [
    "node_modules/better-sqlite3/**/*",
    "node_modules/electron-vlc-player/build/Release/*.node"
  ],
  npmRebuild: false,
  directories: {
    output: "release",
    buildResources: "src/renderer/public/icons"
  },
  files: [
    "out/main/**/*",
    "out/preload/**/*",
    "out/renderer/**/*",
    "package.json"
  ],
  extraResources,
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  mac: {
    category: "public.app-category.entertainment",
    hardenedRuntime: true,
    minimumSystemVersion: "12.0",
    icon: "src/renderer/public/icons/ani-tracker-1024.png",
    target: ["dmg", "zip"]
  },
  dmg: {
    sign: false
  },
  win: {
    icon: "src/renderer/public/icons/ani-tracker-512.png",
    target: ["nsis", "zip"]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true
  },
  linux: {
    category: "AudioVideo",
    maintainer: "Ani Tracker contributors <ani-tracker@users.noreply.github.com>",
    executableName: "ani-tracker",
    icon: "src/renderer/public/icons/ani-tracker-512.png",
    target: ["AppImage", "deb"]
  }
};
