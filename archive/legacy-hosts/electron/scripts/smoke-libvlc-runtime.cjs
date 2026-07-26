#!/usr/bin/env node
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");

if (!process.versions.electron) {
  throw new Error("[libvlc] smoke test must run with Electron");
}

const runtimeDirectory = resolve(process.argv[2] || "");
if (!process.argv[2] || !existsSync(runtimeDirectory)) {
  throw new Error(`[libvlc] smoke runtime directory missing: ${runtimeDirectory}`);
}

const { getLibVlcVersion, initLibVlc } = require("electron-vlc-player");
initLibVlc(runtimeDirectory, { hardwareAcceleration: "none" });
const version = String(getLibVlcVersion().version || "");
if (!/^3\.0(?:\.|$)/.test(version)) {
  throw new Error(`[libvlc] smoke test requires VLC 3.0.x, received: ${version}`);
}

console.log(`[libvlc] Electron runtime smoke passed: ${version}`);
