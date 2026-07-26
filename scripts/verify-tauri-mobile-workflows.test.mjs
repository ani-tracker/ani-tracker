import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [mobileGate, androidRelease, iosRelease, androidGradle] = await Promise.all([
  readFile(".github/workflows/tauri-mobile.yml", "utf8"),
  readFile(".github/workflows/tauri-release-android.yml", "utf8"),
  readFile(".github/workflows/tauri-release-ios.yml", "utf8"),
  readFile("src-tauri/gen/android/app/build.gradle.kts", "utf8")
]);

test("移动持续门禁真实编译两端产物并检查原生与包边界", () => {
  assert.match(mobileGate, /pull_request:/);
  assert.match(mobileGate, /tauri android build --target aarch64 --debug --apk --ci/);
  assert.match(mobileGate, /:tauri-plugin-ani-mobile:testDebugUnitTest/);
  assert.match(mobileGate, /verify:tauri:android-package/);
  assert.match(mobileGate, /tauri ios build --target aarch64 --ci --no-sign/);
  assert.match(mobileGate, /build-for-testing/);
  assert.match(mobileGate, /verify:tauri:ios-package -- --require-unsigned/);
});

test("Android 正式发布同时强制长期 JKS、自签校验与原生单测", () => {
  assert.match(androidRelease, /Missing required Android self-signing secret/);
  assert.match(androidRelease, /tauri android build --target aarch64 --apk --ci/);
  assert.match(androidRelease, /:tauri-plugin-ani-mobile:testReleaseUnitTest/);
  assert.match(androidRelease, /apksigner[^\n]*verify --verbose --print-certs/);
  assert.match(androidGradle, /taskNames\.any \{ it\.contains\("release", ignoreCase = true\) \}/);
  assert.match(androidGradle, /Android Release 必须配置 ANI_ANDROID_KEYSTORE_PATH/);
});

test("iOS 正式发布保持未签名 IPA 与用户重签边界", () => {
  assert.match(iosRelease, /tauri ios build --target aarch64 --ci --no-sign/);
  assert.match(iosRelease, /package-unsigned-ios-ipa\.sh/);
  assert.match(iosRelease, /verify:tauri:ios-package -- --require-unsigned/);
  assert.doesNotMatch(iosRelease, /APPLE_(?:CERTIFICATE|PROVISIONING_PROFILE)/);
});
