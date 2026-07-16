import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PlayerProfile } from "@shared/domain";
import {
  IinaPlayerAdapter,
  MpvPlayerAdapter,
  PlayerAdapterFactory,
  PotPlayerAdapter
} from "../player-adapter";

test("buildPlayerLaunchArgs adds no-stdin to existing IINA profiles", () => {
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
});

test("buildPlayerLaunchArgs keeps explicitly configured IINA stdin behavior", () => {
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
});
