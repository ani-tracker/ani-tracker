import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyEntries,
  verifyUnsignedIosPackage
} from "./verify-tauri-mobile-package.mjs";

const unsignedIosEntries = [
  "Payload/",
  "Payload/Ani Tracker.app/",
  "Payload/Ani Tracker.app/Info.plist"
];

test("接受包含应用目录且不含签名材料的 iOS IPA", () => {
  assert.doesNotThrow(() => verifyEntries("ios", "ani-tracker.ipa", unsignedIosEntries));
  assert.doesNotThrow(() => verifyUnsignedIosPackage("ios", "ani-tracker.ipa", unsignedIosEntries));
});

test("拒绝不含 Payload 应用目录的伪 iOS IPA", () => {
  assert.throws(
    () => verifyEntries("ios", "invalid.ipa", ["README.txt"]),
    /缺少 Payload\/\*\.app/
  );
});

test("拒绝仍包含代码签名目录的 iOS 用户重签包", () => {
  assert.throws(
    () => verifyUnsignedIosPackage("ios", "signed.ipa", [
      ...unsignedIosEntries,
      "Payload/Ani Tracker.app/_CodeSignature/CodeResources"
    ]),
    /仍包含签名材料/
  );
});

test("拒绝仍包含描述文件的 iOS 用户重签包", () => {
  assert.throws(
    () => verifyUnsignedIosPackage("ios", "profile.ipa", [
      ...unsignedIosEntries,
      "Payload/Ani Tracker.app/embedded.mobileprovision"
    ]),
    /仍包含签名材料/
  );
});
