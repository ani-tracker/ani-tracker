import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { PlayerEpisodeList } from "./PlayerEpisodeList";
import type { PlayerEpisodeUiItem } from "./player-ui-model";

interface PlayerPlaylistSheetProps {
  animeTitle: string;
  items: PlayerEpisodeUiItem[];
  onOpenChange: (open: boolean) => void;
  onSelect: (item: PlayerEpisodeUiItem) => void;
  open: boolean;
}

/** 在桌面及移动横屏右侧展示固定头部和可滚动播放列表。 */
export function PlayerPlaylistSheet({
  animeTitle,
  items,
  onOpenChange,
  onSelect,
  open
}: PlayerPlaylistSheetProps) {
  const playableCount = items.filter((item) => Boolean(item.playlistItem)).length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-[44vw] min-w-80 max-w-[420px] flex-col gap-0 p-0" data-player-sheet side="right">
        <SheetHeader className="border-b px-4 py-4 pr-14 text-left">
          <SheetTitle>播放列表</SheetTitle>
          <SheetDescription className="truncate">
            {animeTitle} · {playableCount}/{items.length} 个视频
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 py-1">
          <PlayerEpisodeList
            animeTitle={animeTitle}
            items={items}
            onSelect={onSelect}
            scrollable
            showHeader={false}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
