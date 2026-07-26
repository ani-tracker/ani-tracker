import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  RemotePlaybackRequestMode,
  RemotePlaybackSession
} from "@shared/contracts";
import {
  DesktopPlaybackSessionService,
  toDesktopMediaUrl
} from "../desktop-playback-session-service";
import type { RemoteMediaAsset } from "../../remote/remote-media-session-service";

const token = "T".repeat(43);
const sessionId = "S".repeat(32);

test("DesktopPlaybackSessionService 将票据会话映射为 ani-media 地址", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const service = new DesktopPlaybackSessionService({
    async createExternalSession(
      taskId: string,
      deviceId: string,
      mode: RemotePlaybackRequestMode,
      fileIndex?: number
    ): Promise<RemotePlaybackSession> {
      calls.push({ action: "create", taskId, deviceId, mode, fileIndex });
      return {
        id: sessionId,
        taskId,
        fileIndex,
        fileName: "episode.mkv",
        mode: "hls",
        streamUrl: `/api/media/external/${token}/sessions/${sessionId}/hls/index.m3u8`,
        expiresAt: "2030-01-01T00:00:00.000Z",
        subtitles: [{
          id: "subtitle-1",
          label: "简体中文",
          type: "ass",
          url: `/api/media/external/${token}/sessions/${sessionId}/subtitles/subtitle-000.ass`,
          default: true
        }]
      };
    },
    async closeSession(id: string, deviceId: string): Promise<boolean> {
      calls.push({ action: "close", id, deviceId });
      return true;
    },
    async closeDeviceSessions(deviceId: string): Promise<number> {
      calls.push({ action: "close-owner", deviceId });
      return 1;
    },
    async getExternalAsset(id: string, accessToken: string, assetName: string): Promise<RemoteMediaAsset> {
      calls.push({ action: "asset", id, accessToken, assetName });
      return { filePath: "/tmp/index.m3u8", contentType: "application/vnd.apple.mpegurl", direct: false };
    }
  });

  const session = await service.createSession({
    taskId: "task-1",
    fileIndex: 2
  }, 17);
  const asset = await service.resolveAsset(session.streamUrl);
  await service.closeSession(session.id, 17);
  await service.closeOwnerSessions(17);

  assert.equal(
    session.streamUrl,
    `ani-media://session/${token}/${sessionId}/hls/index.m3u8`
  );
  assert.equal(
    session.subtitles[0].url,
    `ani-media://session/${token}/${sessionId}/subtitles/subtitle-000.ass`
  );
  assert.equal(asset.contentType, "application/vnd.apple.mpegurl");
  assert.deepEqual(calls, [
    { action: "create", taskId: "task-1", deviceId: "desktop-player:17", mode: "direct", fileIndex: 2 },
    { action: "asset", id: sessionId, accessToken: token, assetName: "index.m3u8" },
    { action: "close", id: sessionId, deviceId: "desktop-player:17" },
    { action: "close-owner", deviceId: "desktop-player:17" }
  ]);
});

test("DesktopPlaybackSessionService 拒绝无效播放参数和媒体地址", async () => {
  const service = new DesktopPlaybackSessionService({
    async createExternalSession(): Promise<RemotePlaybackSession> {
      throw new Error("不应创建会话");
    },
    async closeSession(): Promise<boolean> {
      return false;
    },
    async closeDeviceSessions(): Promise<number> {
      return 0;
    },
    async getExternalAsset(): Promise<RemoteMediaAsset> {
      throw new Error("不应读取媒体");
    }
  });

  await assert.rejects(service.createSession({ taskId: "" }, 1));
  await assert.rejects(service.createSession({ taskId: "task-1" }, 0));
  await assert.rejects(service.resolveAsset("ani-media://session/invalid"));
  assert.throws(() => toDesktopMediaUrl("/api/media/sessions/invalid/file"));
});
