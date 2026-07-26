import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  bundledLibraryRelativePath,
  loaderRelativePath,
  parseOtoolDependencies
} from "./libvlc-macos-relocation.mjs";

test("解析 otool 依赖并忽略文件标题", () => {
  const output = `/runtime/lib/libvlc.5.dylib:
\t@rpath/libvlccore.dylib (compatibility version 12.0.0, current version 12.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1336.61.1)
`;
  assert.deepEqual(parseOtoolDependencies(output), [
    "@rpath/libvlccore.dylib",
    "/usr/lib/libSystem.B.dylib"
  ]);
});

test("识别 VLC 私有依赖但保留系统动态库", () => {
  assert.equal(bundledLibraryRelativePath("@rpath/libvlccore.dylib"), "libvlccore.dylib");
  assert.equal(
    bundledLibraryRelativePath("/Volumes/VLC/VLC.app/Contents/MacOS/lib/libvlccore.dylib"),
    "libvlccore.dylib"
  );
  assert.equal(bundledLibraryRelativePath("/usr/lib/libSystem.B.dylib"), undefined);
});

test("为嵌套插件生成指向 lib 目录的 loader path", () => {
  const value = loaderRelativePath(
    join("runtime", "plugins", "access", "libaccess.dylib"),
    join("runtime", "lib", "libvlccore.dylib")
  );
  assert.equal(value, "@loader_path/../../lib/libvlccore.dylib");
});
