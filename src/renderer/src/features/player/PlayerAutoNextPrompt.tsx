import { SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PlayerAutoNextPromptProps {
  episodeLabel: string;
  seconds: number;
  onCancel: () => void;
  onPlayNow: () => void;
}

/** 在视频区域内显示可取消的自动下一集倒计时。 */
export function PlayerAutoNextPrompt({
  episodeLabel,
  seconds,
  onCancel,
  onPlayNow
}: PlayerAutoNextPromptProps) {
  return (
    <div
      aria-live="polite"
      className="absolute bottom-24 right-3 z-30 flex max-w-[calc(100%_-_1.5rem)] items-center gap-3 rounded-lg border border-border bg-background/95 p-3 text-foreground shadow-lg backdrop-blur sm:right-5 sm:max-w-sm"
      data-player-controls
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{seconds} 秒后播放</p>
        <p className="truncate text-sm font-semibold">{episodeLabel}</p>
      </div>
      <Button aria-label="立即播放下一集" onClick={onPlayNow} size="icon">
        <SkipForward />
      </Button>
      <Button aria-label="取消自动下一集" onClick={onCancel} size="icon" variant="outline">
        <X />
      </Button>
    </div>
  );
}
