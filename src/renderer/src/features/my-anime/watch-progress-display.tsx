import { Progress } from "@/components/ui/progress";
import type { AnimeWatchProgress } from "@shared/contracts";

interface WatchProgressDisplayProps {
  progress: AnimeWatchProgress;
}

/** 只读展示播放器自动同步的连续观看进度。 */
export function WatchProgressDisplay({ progress }: WatchProgressDisplayProps) {
  return (
    <div className="min-w-0">
      <div className="flex items-end justify-between gap-3 text-xs">
        <span className="text-muted-foreground">观看进度</span>
        <span className="font-semibold tabular-nums text-primary">
          {progress.watchedEpisodeCount} / {progress.totalEpisodeCount || "--"}
        </span>
      </div>
      <Progress
        className="mt-2 h-1.5"
        value={progress.totalEpisodeCount > 0 ? progress.watchedEpisodeCount / progress.totalEpisodeCount : 0}
      />
    </div>
  );
}
