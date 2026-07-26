import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildExternalPlayerProtocolUrl,
  detectExternalPlayer
} from "../../../../renderer/src/features/remote/external-player-launch";

test("远程播放器按 Windows 与 macOS 选择 PotPlayer 或 IINA", () => {
  assert.deepEqual(
    detectExternalPlayer("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32"),
    { kind: "potplayer", label: "PotPlayer" }
  );
  assert.deepEqual(
    detectExternalPlayer("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)", "MacIntel"),
    { kind: "iina", label: "IINA" }
  );
  assert.equal(
    detectExternalPlayer("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Mobile/15E148", "MacIntel"),
    undefined
  );
  assert.equal(detectExternalPlayer("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64"), undefined);
});

test("远程播放器协议保留完整 HTTPS 拉流地址", () => {
  const mediaUrl = "https://192.168.15.116:18083/api/media/external/token/sessions/id/file";
  assert.equal(
    buildExternalPlayerProtocolUrl("potplayer", mediaUrl),
    `potplayer://${mediaUrl}`
  );
  assert.equal(
    buildExternalPlayerProtocolUrl("iina", mediaUrl),
    `iina://weblink?url=${encodeURIComponent(mediaUrl)}`
  );
  assert.throws(
    () => buildExternalPlayerProtocolUrl("iina", "file:///Users/test/episode.mkv"),
    /仅支持 HTTP\(S\)/
  );
});
