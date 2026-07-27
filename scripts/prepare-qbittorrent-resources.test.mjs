import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("macOS qBittorrent 资源可被 Tauri 重复覆盖", {
  skip: process.platform === "win32"
}, async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ani-qbittorrent-permissions-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const sourceRoot = join(temporaryRoot, "source");
  const targetRoot = join(temporaryRoot, "target");
  const bundleRoot = join(sourceRoot, "darwin-x64", "qbittorrent-nox.app", "Contents");
  const binary = join(bundleRoot, "MacOS", "qbittorrent-nox");
  const frameworkRoot = join(bundleRoot, "Frameworks");
  const readOnlyLibrary = join(frameworkRoot, "ossl-modules", "legacy.dylib");
  const frameworkLink = join(frameworkRoot, "CurrentLibrary");

  await mkdir(join(bundleRoot, "MacOS"), { recursive: true });
  await mkdir(join(frameworkRoot, "ossl-modules"), { recursive: true });
  await writeFile(binary, "qBittorrent fixture\n");
  await chmod(binary, 0o755);
  await writeFile(readOnlyLibrary, "OpenSSL fixture\n");
  await chmod(readOnlyLibrary, 0o444);
  await symlink("ossl-modules/legacy.dylib", frameworkLink);

  const result = spawnSync(process.execPath, [
    resolve("scripts/prepare-qbittorrent-resources.mjs"),
    "--source", sourceRoot,
    "--target", targetRoot,
    "--platform", "darwin",
    "--arch", "x64",
    "--required"
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const copiedLibrary = join(targetRoot, "darwin-x64", "qbittorrent-nox.app", "Contents", "Frameworks", "ossl-modules", "legacy.dylib");
  assert.notEqual((await stat(copiedLibrary)).mode & 0o200, 0);
  assert.equal((await stat(readOnlyLibrary)).mode & 0o200, 0);
  assert.equal((await lstat(join(targetRoot, "darwin-x64", "qbittorrent-nox.app", "Contents", "Frameworks", "CurrentLibrary"))).isSymbolicLink(), true);
  assert.match(result.stdout, /normalized macOS writable files: 1/);
});
