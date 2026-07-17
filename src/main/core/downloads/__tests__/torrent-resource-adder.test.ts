import { strict as assert } from "node:assert";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import type { TorrentEngine } from "@shared/contracts";
import type { DownloadTask } from "@shared/domain";
import { addReleaseTorrentToEngine, addTorrentAddressToEngine } from "../torrent-resource-adder";

test("addReleaseTorrentToEngine 先下载 torrent 临时文件再上传到下载引擎", async () => {
  const torrentData = Buffer.from("d4:infod4:name4:testee");
  const calls: string[] = [];
  let requestedSource = "";
  let uploadedPath = "";
  const engine = createFakeEngine({
    async addTorrentFile(filePath, options) {
      calls.push("addTorrentFile");
      uploadedPath = filePath;
      assert.equal(options.savePath, "/downloads");
      assert.deepEqual(await readFile(filePath), torrentData);
      return createTask("torrent-file-task");
    }
  });

  const task = await addReleaseTorrentToEngine({
    engine,
    torrentUrl: "https://example.test/download/test.torrent",
    options: { savePath: "/downloads" },
    torrentHttpClient: {
      async fetch(input, options) {
        calls.push("fetchTorrent");
        requestedSource = options?.source ?? "";
        assert.equal(String(input), "https://example.test/download/test.torrent");
        return new Response(torrentData, {
          status: 200,
          headers: {
            "content-type": "application/x-bittorrent",
            "content-length": String(torrentData.byteLength)
          }
        });
      }
    }
  });

  assert.deepEqual(calls, ["fetchTorrent", "addTorrentFile"]);
  assert.equal(requestedSource, "torrent-download");
  assert.equal(task.id, "torrent-file-task");
  await assert.rejects(() => access(uploadedPath), /ENOENT/);
});

test("addReleaseTorrentToEngine 有 magnet 时保持直传且不下载 torrent", async () => {
  let fetched = false;
  let addedMagnet = "";
  const engine = createFakeEngine({
    async addMagnet(magnetUrl) {
      addedMagnet = magnetUrl;
      return createTask("magnet-task");
    }
  });

  const task = await addReleaseTorrentToEngine({
    engine,
    magnetUrl: "magnet:?xt=urn:btih:ABC123",
    torrentUrl: "https://example.test/download/test.torrent",
    options: { savePath: "/downloads" },
    torrentHttpClient: {
      async fetch() {
        fetched = true;
        throw new Error("不应该下载 torrent");
      }
    }
  });

  assert.equal(task.id, "magnet-task");
  assert.equal(addedMagnet, "magnet:?xt=urn:btih:ABC123");
  assert.equal(fetched, false);
});

test("addTorrentAddressToEngine 拒绝把错误页作为 torrent 文件上传", async () => {
  let addFileCount = 0;
  const engine = createFakeEngine({
    async addTorrentFile() {
      addFileCount += 1;
      return createTask("should-not-add");
    }
  });

  await assert.rejects(
    () =>
      addTorrentAddressToEngine({
        engine,
        url: "https://example.test/download/error.torrent",
        options: { savePath: "/downloads" },
        torrentHttpClient: {
          async fetch() {
            return new Response("<html>cloudflare denied</html>", { status: 200 });
          }
        }
      }),
    /not valid bencode metadata/
  );
  assert.equal(addFileCount, 0);
});

/** 创建只覆盖测试所需方法的下载引擎。 */
function createFakeEngine(overrides: Partial<TorrentEngine>): TorrentEngine {
  return {
    async addMagnet() {
      throw new Error("addMagnet should not be called");
    },
    async addTorrentFile() {
      throw new Error("addTorrentFile should not be called");
    },
    async listTasks() {
      return [];
    },
    async getTask() {
      return createTask("fake-task");
    },
    async getFiles() {
      return [];
    },
    async setFilePriority() {
      return;
    },
    async pause() {
      return;
    },
    async resume() {
      return;
    },
    async remove() {
      return;
    },
    ...overrides
  };
}

/** 创建测试用下载任务。 */
function createTask(id: string): DownloadTask {
  return {
    id,
    engine: "qbittorrent",
    torrentHash: id,
    name: id,
    status: "downloading",
    progress: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    savePath: "/downloads",
    files: [],
    createdAt: "2026-07-17T00:00:00.000Z"
  };
}
