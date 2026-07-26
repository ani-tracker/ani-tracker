import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_IMAGE_CACHE_MAX_BYTES,
  ImageCacheError,
  ImageCacheService,
  validatePublicImageUrl
} from "../image-cache-service";

const PUBLIC_ADDRESS = async () => ["93.184.216.34"];
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("图片首次加载写入缓存，后续及重启后不再访问源站", async (context) => {
  const cacheDirectory = await createCacheDirectory(context);
  let fetchCount = 0;
  const first = createService(cacheDirectory, async () => {
    fetchCount += 1;
    return imageResponse(PNG_BYTES);
  });

  const initial = await first.get("https://example.com/poster.png#preview");
  const cached = await first.get("https://example.com/poster.png");
  const restarted = createService(cacheDirectory, async () => {
    throw new Error("重启后不应访问源站");
  });
  const restored = await restarted.get("https://example.com/poster.png");

  assert.equal(fetchCount, 1);
  assert.equal(initial.filePath, cached.filePath);
  assert.equal(cached.filePath, restored.filePath);
  assert.equal(restored.contentType, "image/png");
});

test("同一图片的并发请求只下载一次", async (context) => {
  const cacheDirectory = await createCacheDirectory(context);
  let fetchCount = 0;
  const service = createService(cacheDirectory, async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return imageResponse(PNG_BYTES);
  });

  const [first, second, third] = await Promise.all([
    service.get("https://example.com/concurrent.png"),
    service.get("https://example.com/concurrent.png"),
    service.get("https://example.com/concurrent.png")
  ]);

  assert.equal(fetchCount, 1);
  assert.equal(first.filePath, second.filePath);
  assert.equal(second.filePath, third.filePath);
});

test("缓存容量超过上限时删除最旧图片", async (context) => {
  const cacheDirectory = await createCacheDirectory(context);
  let fetchCount = 0;
  let now = Date.parse("2026-07-18T00:00:00.000Z");
  const service = new ImageCacheService({
    cacheDirectory,
    maxBytes: 6,
    maxImageBytes: 16,
    hostResolver: PUBLIC_ADDRESS,
    clock: () => now,
    fetcher: async () => {
      fetchCount += 1;
      return imageResponse(PNG_BYTES);
    }
  });

  await service.get("https://example.com/old.png");
  now += 1_000;
  await service.get("https://example.com/new.png");
  await service.get("https://example.com/old.png");

  assert.equal(fetchCount, 3);
  const dataFiles = (await readdir(cacheDirectory)).filter((name) => name.endsWith(".png"));
  assert.equal(dataFiles.length, 1);
});

test("缓存拒绝非法 MIME、私网目标和被篡改令牌", async (context) => {
  const cacheDirectory = await createCacheDirectory(context);
  const service = createService(cacheDirectory, async () => new Response("html", {
    headers: { "Content-Type": "text/html" }
  }));

  await assert.rejects(
    () => service.get("https://example.com/not-image"),
    (error: unknown) => error instanceof ImageCacheError && error.code === "IMAGE_TYPE_UNSUPPORTED"
  );
  await assert.rejects(
    () => validatePublicImageUrl("http://localhost/image.png", PUBLIC_ADDRESS),
    (error: unknown) => error instanceof ImageCacheError && error.code === "IMAGE_HOST_FORBIDDEN"
  );
  await assert.rejects(
    () => validatePublicImageUrl("https://example.com/image.png", async () => ["192.168.1.10"]),
    (error: unknown) => error instanceof ImageCacheError && error.code === "IMAGE_HOST_FORBIDDEN"
  );
  const token = service.createRemotePath("https://example.com/image.png").split("/").at(-1)!;
  const tamperedSuffix = token.endsWith("x") ? "y" : "x";
  assert.throws(
    () => service.getByToken(`${token.slice(0, -1)}${tamperedSuffix}`),
    (error: unknown) => error instanceof ImageCacheError && error.code === "IMAGE_TOKEN_INVALID"
  );
  assert.deepEqual(await readdir(cacheDirectory).catch(() => []), []);
});

test("默认图片缓存上限为 5GB", () => {
  assert.equal(DEFAULT_IMAGE_CACHE_MAX_BYTES, 5 * 1024 * 1024 * 1024);
});

function createService(cacheDirectory: string, fetcher: () => Promise<Response>): ImageCacheService {
  return new ImageCacheService({
    cacheDirectory,
    fetcher,
    hostResolver: PUBLIC_ADDRESS,
    signingSecret: Buffer.alloc(32, 7)
  });
}

function imageResponse(bytes: Buffer): Response {
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.length)
    }
  });
}

async function createCacheDirectory(context: { after: (callback: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ani-image-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "images");
}
