import {
  CheckCircle2,
  CircleDashed,
  Download,
  ListVideo,
  Radio,
  RotateCw
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/cn";
import type { PlayerEpisodeUiItem, PlayerEpisodeUiStatus } from "./player-ui-model";

interface PlayerEpisodeListProps {
  animeTitle: string;
  items: PlayerEpisodeUiItem[];
  onSelect: (item: PlayerEpisodeUiItem) => void;
  scrollable?: boolean;
  showHeader?: boolean;
}

/** 展示当前番剧的完整集数状态，并阻止未下载条目触发播放。 */
export function PlayerEpisodeList({
  animeTitle,
  items,
  onSelect,
  scrollable = false,
  showHeader = true
}: PlayerEpisodeListProps) {
  const playableCount = items.filter((item) => Boolean(item.playlistItem)).length;
  const content = (
    <div className="flex flex-col" role="list" aria-label={`${animeTitle} 播放列表`}>
      {items.map((item, index) => (
        <div key={item.id} role="listitem">
          <EpisodeRow item={item} onSelect={onSelect} />
          {index < items.length - 1 && <Separator />}
        </div>
      ))}
    </div>
  );

  return (
    <section
      aria-label={showHeader ? undefined : `${animeTitle} 播放列表`}
      aria-labelledby={showHeader ? "player-playlist-title" : undefined}
      className="flex min-h-0 flex-col"
    >
      {showHeader && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id="player-playlist-title" className="text-base font-semibold">播放列表</h2>
            <p className="truncate text-xs text-muted-foreground">{animeTitle}</p>
          </div>
          <Badge>{playableCount}/{items.length}</Badge>
        </div>
      )}
      {items.length === 0 ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
          <ListVideo />
          <p className="text-sm font-medium text-foreground">没有可播放视频</p>
          <p className="text-xs">当前番剧暂时没有已完成的视频文件</p>
        </div>
      ) : scrollable ? (
        <ScrollArea className="min-h-0 flex-1 px-2">{content}</ScrollArea>
      ) : content}
    </section>
  );
}

/** 渲染单集的编号、标题、媒体规格、进度和状态。 */
function EpisodeRow({
  item,
  onSelect
}: {
  item: PlayerEpisodeUiItem;
  onSelect: (item: PlayerEpisodeUiItem) => void;
}) {
  const active = item.status === "playing";
  const disabled = !item.playlistItem;

  return (
    <Button
      aria-current={active ? "true" : undefined}
      aria-label={`${item.numberLabel} ${item.title}，${item.statusLabel}`}
      className="h-auto min-h-14 w-full justify-start rounded-none px-4 py-2 text-left sm:px-3"
      disabled={disabled}
      onClick={() => onSelect(item)}
      variant={active ? "secondary" : "ghost"}
    >
      <span className="w-7 shrink-0 text-center font-mono text-xs font-semibold tabular-nums">
        {item.numberLabel}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{item.title}</span>
          {active && <Badge tone="primary-soft">正在播放</Badge>}
        </span>
        <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
          {item.meta} · {item.statusLabel}
        </span>
        {item.progress > 0 && item.progress < 1 && (
          <Progress className="mt-1 h-1" value={item.progress} />
        )}
      </span>
      <EpisodeStatusIcon status={item.status} />
    </Button>
  );
}

/** 使用图标和文本共同表达播放列表状态。 */
function EpisodeStatusIcon({ status }: { status: PlayerEpisodeUiStatus }) {
  const Icon = status === "playing"
    ? Radio
    : status === "watched"
      ? CheckCircle2
      : status === "ready"
        ? Download
        : status === "downloading"
          ? RotateCw
          : CircleDashed;
  return <Icon className={cn("shrink-0", status === "downloading" && "animate-spin")} aria-hidden="true" />;
}
