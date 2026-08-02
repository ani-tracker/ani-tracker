import { useState } from "react";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { readStoredSubtitleScale, storeSubtitleScale } from "@/features/player/subtitle-scale";
import {
  readRemotePlaybackMode,
  storeRemotePlaybackMode
} from "@/features/player/remote-playback-preferences";
import type { RemotePlaybackRequestMode } from "@shared/contracts";
import { PLAYER_SUBTITLE_SCALES, type PlayerSubtitleScale } from "@shared/player-contract";

/** 管理当前远程设备独立的播放模式和字幕大小。 */
export function RemotePlaybackSettingsSection() {
  const [playbackMode, setPlaybackMode] = useState<RemotePlaybackRequestMode>(readRemotePlaybackMode);
  const [subtitleScale, setSubtitleScale] = useState<PlayerSubtitleScale>(readStoredSubtitleScale);

  /** 保存远程设备播放偏好，不修改 PC 播放器配置。 */
  function updatePreferences(mode: RemotePlaybackRequestMode, scale: PlayerSubtitleScale): void {
    setPlaybackMode(mode);
    setSubtitleScale(scale);
    storeRemotePlaybackMode(mode);
    storeSubtitleScale(scale);
  }

  return (
    <FieldGroup className="grid gap-4 md:grid-cols-2">
      <Field>
        <FieldLabel htmlFor="remote-playback-mode">默认播放模式</FieldLabel>
        <Select
          value={playbackMode}
          onValueChange={(value) => updatePreferences(value as RemotePlaybackRequestMode, subtitleScale)}
        >
          <SelectTrigger id="remote-playback-mode"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="direct">优先直传</SelectItem>
              <SelectItem value="transcode">优先实时转码</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>直传失败时播放器会自动切换为实时转码。</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="remote-subtitle-scale">字幕大小</FieldLabel>
        <Select
          value={String(subtitleScale)}
          onValueChange={(value) => updatePreferences(playbackMode, Number(value) as PlayerSubtitleScale)}
        >
          <SelectTrigger id="remote-subtitle-scale"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {PLAYER_SUBTITLE_SCALES.map((scale) => (
                <SelectItem key={scale} value={String(scale)}>{scale}%</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  );
}
