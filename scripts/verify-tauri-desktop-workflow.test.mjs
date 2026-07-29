import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(".github/workflows/tauri-release-desktop.yml", "utf8");
const torrentCorePrepare = await readFile("scripts/prepare-desktop-torrent-core-dev.mjs", "utf8");

test("桌面原生依赖按平台使用独立步骤和工具链", () => {
  assert.match(workflow, /name: Prepare Windows libVLC[\s\S]*?if: matrix\.platform == 'win32'[\s\S]*?shell: pwsh/);
  assert.match(workflow, /name: Prepare macOS libVLC[\s\S]*?if: matrix\.platform == 'darwin'[\s\S]*?shell: bash/);
  assert.match(workflow, /name: Prepare Linux libVLC[\s\S]*?if: matrix\.platform == 'linux'[\s\S]*?shell: bash/);
  assert.match(workflow, /name: Build Windows torrent-core[\s\S]*?shell: pwsh/);
  assert.match(workflow, /name: Build macOS torrent-core[\s\S]*?shell: bash/);
  assert.match(workflow, /name: Build Linux torrent-core[\s\S]*?shell: bash/);
  assert.match(workflow, /name: Build Windows managed qBittorrent[\s\S]*?shell: pwsh/);
  assert.match(workflow, /name: Build macOS managed qBittorrent[\s\S]*?shell: bash/);
  assert.match(workflow, /name: Build Linux managed qBittorrent[\s\S]*?shell: bash/);
});

test("macOS Intel 架构转换为 CMake 识别的 x86_64", () => {
  assert.match(torrentCorePrepare, /arch === "x64" \? "x86_64" : arch/);
  assert.match(torrentCorePrepare, /CMAKE_OSX_ARCHITECTURES=\$\{cmakeArchitecture\}/);
});

test("桌面发布强制 Windows 与 macOS 使用固定自签凭据", () => {
  assert.match(workflow, /required=\(WINDOWS_CERTIFICATE_BASE64 WINDOWS_CERTIFICATE_PASSWORD\)/);
  assert.match(workflow, /required=\(APPLE_CERTIFICATE_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY\)/);
  assert.match(workflow, /Missing required Windows self-signing secret/);
  assert.match(workflow, /Missing required macOS self-signing secret/);
});

test("macOS 发布通过临时钥匙串导入并信任自签 P12", () => {
  assert.match(workflow, /openssl pkcs12[\s\S]*?-clcerts -nokeys/);
  assert.doesNotMatch(workflow, /openssl x509[^\n]*-purpose/);
  assert.match(workflow, /certificate does not match APPLE_SIGNING_IDENTITY/);
  assert.match(workflow, /security create-keychain/);
  assert.match(workflow, /security set-key-partition-list/);
  assert.match(workflow, /current_keychains=\(\)[\s\S]*?"\$\{current_keychains\[@\]\}"/);
  assert.doesNotMatch(workflow, /security list-keychains[^\n]*\$\{current_keychains\}(?:\s|$)/);
  assert.match(workflow, /security add-trusted-cert[\s\S]*?trustRoot/);
  assert.match(workflow, /security find-identity -v -p codesigning/);
});

test("macOS 发布在 Tauri 打包前按由内到外顺序签名托管 qBittorrent", () => {
  assert.match(workflow, /name: Sign staged macOS managed qBittorrent/);
  assert.match(workflow, /find "\$\{managed_app\}\/Contents" -type f -name '\*\.dylib'/);
  assert.match(workflow, /find "\$\{managed_app\}\/Contents\/Frameworks" -type d -name '\*\.framework'/);
  assert.match(workflow, /--sign "\$\{APPLE_SIGNING_IDENTITY\}" "\$\{managed_executable\}"/);
  assert.match(workflow, /--sign "\$\{APPLE_SIGNING_IDENTITY\}" "\$\{managed_app\}"/);
  assert.match(workflow, /codesign --verify --deep --strict "\$\{managed_app\}"/);
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
