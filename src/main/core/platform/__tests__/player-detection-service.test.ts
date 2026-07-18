import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AppSettings, PlayerProfile } from "@shared/domain";
import { PlayerDetectionService } from "../player-detection-service";

const windowsPlayers: PlayerProfile[] = [
  {
    id: "pure-codec-potplayer",
    name: "完美解码版 PotPlayer",
    executablePath: "C:\\Program Files\\Pure Codec\\x64\\PotPlayerMini64.exe",
    argumentTemplate: "\"{file}\"",
    platform: "windows"
  },
  {
    id: "potplayer",
    name: "PotPlayer",
    executablePath: "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe",
    argumentTemplate: "\"{file}\"",
    platform: "windows"
  },
  {
    id: "mpv",
    name: "mpv",
    executablePath: "mpv",
    argumentTemplate: "\"{file}\"",
    platform: "any"
  }
];

test("PlayerDetectionService 在 Windows 自动模式优先选择完美解码版 PotPlayer", () => {
  const available = new Set([
    "C:\\Program Files\\Pure Codec\\x64\\PotPlayerMini64.exe",
    "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe",
    "C:\\Tools\\mpv.exe"
  ]);
  const service = new PlayerDetectionService({
    platform: "win32",
    pathEntries: ["C:\\Tools"],
    isFile: (path) => available.has(path)
  });

  const result = service.detect(windowsPlayers);

  assert.equal(result.platform, "windows");
  assert.equal(result.detectedProfileId, "pure-codec-potplayer");
  assert.equal(result.detectedExecutablePath, "C:\\Program Files\\Pure Codec\\x64\\PotPlayerMini64.exe");
  const resolved = service.resolve({ players: windowsPlayers, defaultPlayerProfileId: "auto" } as AppSettings);
  assert.equal(resolved.id, "pure-codec-potplayer");
  assert.equal(resolved.executablePath, "C:\\Program Files\\Pure Codec\\x64\\PotPlayerMini64.exe");
});

test("PlayerDetectionService 优先使用用户配置路径并从 PATH 解析 mpv", () => {
  const customPotPlayer = "D:\\Players\\PotPlayerMini64.exe";
  const configured = windowsPlayers.map((player) => player.id === "potplayer"
    ? { ...player, executablePath: customPotPlayer }
    : player);
  const service = new PlayerDetectionService({
    platform: "win32",
    pathEntries: ["C:\\Tools"],
    isFile: (path) => path === customPotPlayer || path === "C:\\Tools\\mpv.exe"
  });

  const result = service.detect(configured);

  assert.equal(result.detectedProfileId, "potplayer");
  assert.equal(result.candidates.find((item) => item.profileId === "potplayer")?.resolvedPath, customPotPlayer);
  assert.equal(result.candidates.find((item) => item.profileId === "mpv")?.resolvedPath, "C:\\Tools\\mpv.exe");
});

test("PlayerDetectionService 按操作系统过滤播放器并返回明确缺失提示", () => {
  const profiles: PlayerProfile[] = [
    ...windowsPlayers,
    {
      id: "iina",
      name: "IINA",
      executablePath: "/Applications/IINA.app/Contents/MacOS/iina-cli",
      argumentTemplate: "\"{file}\"",
      platform: "macos"
    }
  ];
  const service = new PlayerDetectionService({ platform: "linux", pathEntries: [], isFile: () => false });
  const result = service.detect(profiles);

  assert.deepEqual(result.candidates.map((item) => item.profileId), ["mpv"]);
  assert.throws(
    () => service.resolve({ players: profiles, defaultPlayerProfileId: "auto" } as AppSettings),
    /设置 > 播放器配置/
  );
});
