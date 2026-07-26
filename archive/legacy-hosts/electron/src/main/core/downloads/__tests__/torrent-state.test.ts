import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mapQbittorrentState } from "../../torrent-state";

test("qBittorrent 5 stopped states map completed uploads and paused downloads correctly", () => {
  assert.equal(mapQbittorrentState("stoppedUP"), "completed");
  assert.equal(mapQbittorrentState("stoppedDL"), "paused");
  assert.equal(mapQbittorrentState("checkingUP"), "checking");
});
