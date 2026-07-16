import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PlayerProfile } from "@shared/domain";
import {
  IinaPlayerAdapter,
  MpvPlayerAdapter,
  PlayerAdapterFactory,
  PotPlayerAdapter
} from "../player-adapter";
import { parseMpvProgressEvent } from "../playback-monitor";

test("IinaPlayerAdapter adds no-stdin and creates an mpv IPC monitor", () => {
  const profile: PlayerProfile = {
    id: "iina",
    name: "IINA",
    executablePath: "/Applications/IINA.app/Contents/MacOS/iina-cli",
    argumentTemplate: "\"{file}\"",
    platform: "macos"
  };

  const adapter = new PlayerAdapterFactory().resolve(profile);
  assert.ok(adapter instanceof IinaPlayerAdapter);
  assert.deepEqual(adapter.buildArguments(profile, "/tmp/anime episode.mkv"), [
    "--no-stdin",
    "/tmp/anime episode.mkv"
  ]);
  const monitor = adapter.createPlaybackMonitor(profile, "/tmp/anime episode.mkv");
  assert.ok(monitor);
  assert.match(monitor.launchArguments[0], /^--mpv-input-ipc-server=/);
});

test("IinaPlayerAdapter keeps explicitly configured stdin behavior", () => {
  const profile: PlayerProfile = {
    id: "iina",
    name: "IINA",
    executablePath: "/Applications/IINA.app/Contents/MacOS/iina-cli",
    argumentTemplate: "--stdin \"{file}\"",
    platform: "macos"
  };

  const adapter = new PlayerAdapterFactory().resolve(profile);
  assert.deepEqual(adapter.buildArguments(profile, "/tmp/anime.mkv"), ["--stdin", "/tmp/anime.mkv"]);
});

test("PlayerAdapterFactory resolves PotPlayer and mpv subclasses", () => {
  const factory = new PlayerAdapterFactory();
  const potPlayer: PlayerProfile = {
    id: "potplayer",
    name: "PotPlayer",
    executablePath: "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe",
    argumentTemplate: "\"{file}\"",
    platform: "windows"
  };
  const mpv: PlayerProfile = {
    id: "mpv",
    name: "mpv",
    executablePath: "mpv",
    argumentTemplate: "--force-window=yes \"{file}\"",
    platform: "any"
  };

  assert.ok(factory.resolve(potPlayer) instanceof PotPlayerAdapter);
  assert.ok(factory.resolve(mpv) instanceof MpvPlayerAdapter);
  assert.equal(factory.resolve(potPlayer).createPlaybackMonitor(potPlayer, "C:\\anime.mkv"), undefined);
  assert.equal(factory.resolve(mpv).createPlaybackMonitor(mpv, "/tmp/anime.mkv"), undefined);
});

test("parseMpvProgressEvent reads and clamps percent-pos property changes", () => {
  assert.deepEqual(
    parseMpvProgressEvent(
      JSON.stringify({ event: "property-change", id: 1, name: "percent-pos", data: 92.5 }),
      "/tmp/anime.mkv"
    ),
    { filePath: "/tmp/anime.mkv", percent: 92.5 }
  );
  assert.deepEqual(
    parseMpvProgressEvent(
      JSON.stringify({ event: "property-change", id: 1, name: "percent-pos", data: 120 }),
      "/tmp/anime.mkv"
    ),
    { filePath: "/tmp/anime.mkv", percent: 100 }
  );
  assert.equal(parseMpvProgressEvent(JSON.stringify({ event: "end-file" }), "/tmp/anime.mkv"), undefined);
});
