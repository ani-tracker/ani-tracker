import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/tauri-release-desktop.yml", "utf8");

test("桌面发布强制 Windows 与 macOS 使用固定自签凭据", () => {
  assert.match(workflow, /required=\(WINDOWS_CERTIFICATE_BASE64 WINDOWS_CERTIFICATE_PASSWORD\)/);
  assert.match(workflow, /required=\(APPLE_CERTIFICATE_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY\)/);
  assert.match(workflow, /Missing required Windows self-signing secret/);
  assert.match(workflow, /Missing required macOS self-signing secret/);
});

test("macOS 发布通过临时钥匙串导入并信任自签 P12", () => {
  assert.match(workflow, /openssl pkcs12[\s\S]*?-clcerts -nokeys/);
  assert.match(workflow, /security create-keychain/);
  assert.match(workflow, /security set-key-partition-list/);
  assert.match(workflow, /security add-trusted-cert[\s\S]*?trustRoot/);
  assert.match(workflow, /security find-identity -v -p codesigning/);
});

test("macOS 产物拒绝 ad-hoc 并校验嵌入证书指纹", () => {
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /Signature=adhoc/);
  assert.match(workflow, /codesign -d --extract-certificates/);
  assert.match(workflow, /actual_fingerprint[\s\S]*?expected_fingerprint/);
  assert.match(workflow, /ani-tracker-macos-self-signed\.pem/);
});

test("macOS 发布无论成功失败都会清理临时签名材料", () => {
  assert.match(workflow, /if: always\(\) && matrix\.platform == 'darwin'/);
  assert.match(workflow, /security delete-certificate/);
  assert.match(workflow, /security delete-keychain/);
});
