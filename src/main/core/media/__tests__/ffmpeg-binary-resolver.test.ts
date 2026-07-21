import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  resolveBundledFfmpegBinary,
  resolveBundledFfprobeBinary,
  resolveFfprobeCommands,
  resolveFfmpegCommand
} from "../ffmpeg-binary-resolver";

test("resolveBundledFfmpegBinary 按平台和架构解析内置资源", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ani-ffmpeg-resolver-test-"));
  const binaryPath = join(root, "darwin-arm64", "ffmpeg");
  await mkdir(join(root, "darwin-arm64"), { recursive: true });
  await writeFile(binaryPath, "test", "utf8");
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(resolveBundledFfmpegBinary({
    platform: "darwin",
    arch: "arm64",
    resourceRoots: [root]
  }), binaryPath);
  assert.equal(resolveBundledFfmpegBinary({
    platform: "win32",
    arch: "x64",
    resourceRoots: [root]
  }), undefined);
});

test("resolveBundledFfprobeBinary 解析同目录内置资源", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ani-ffprobe-resolver-test-"));
  const binaryPath = join(root, "win32-x64", "ffprobe.exe");
  await mkdir(join(root, "win32-x64"), { recursive: true });
  await writeFile(binaryPath, "test", "utf8");
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(resolveBundledFfprobeBinary({
    platform: "win32",
    arch: "x64",
    resourceRoots: [root]
  }), binaryPath);
});

test("resolveFfprobeCommands 默认使用内置资源且尊重用户路径", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ani-ffprobe-command-test-"));
  const bundledPath = join(root, "ffprobe.exe");
  const configuredPath = join(root, "custom-ffprobe.exe");
  await writeFile(bundledPath, "test", "utf8");
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(resolveFfprobeCommands({
    platform: "win32",
    configuredPath: "ffprobe",
    bundledFfprobePath: bundledPath
  }), [bundledPath, "ffprobe"]);
  assert.deepEqual(resolveFfprobeCommands({
    platform: "win32",
    configuredPath,
    bundledFfprobePath: bundledPath
  }), [configuredPath, bundledPath]);
  assert.deepEqual(resolveFfprobeCommands({
    platform: "win32",
    configuredPath: "ffprobe",
    bundledFfprobePath: null
  }), ["ffprobe"]);
});

test("resolveFfmpegCommand 优先使用内置资源", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ani-ffmpeg-command-test-"));
  const configuredDirectory = join(root, "configured");
  const bundledPath = join(root, "bundled", "ffmpeg");
  await Promise.all([
    mkdir(configuredDirectory, { recursive: true }),
    mkdir(join(root, "bundled"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(configuredDirectory, "ffprobe"), "test", "utf8"),
    writeFile(join(configuredDirectory, "ffmpeg"), "test", "utf8"),
    writeFile(bundledPath, "test", "utf8")
  ]);
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(resolveFfmpegCommand({
    platform: "darwin",
    arch: "x64",
    ffprobePath: join(configuredDirectory, "ffprobe"),
    bundledFfmpegPath: bundledPath
  }), bundledPath);
});

test("resolveFfmpegCommand 回退用户配置同目录和系统命令", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ani-ffmpeg-fallback-test-"));
  const ffprobePath = join(root, "ffprobe.exe");
  const configuredFfmpegPath = join(root, "ffmpeg.exe");
  await Promise.all([
    writeFile(ffprobePath, "test", "utf8"),
    writeFile(configuredFfmpegPath, "test", "utf8")
  ]);
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(resolveFfmpegCommand({
    platform: "win32",
    ffprobePath,
    bundledFfmpegPath: null
  }), configuredFfmpegPath);
  assert.equal(resolveFfmpegCommand({
    platform: "win32",
    ffprobePath: "ffprobe",
    bundledFfmpegPath: null
  }), "ffmpeg.exe");
});
