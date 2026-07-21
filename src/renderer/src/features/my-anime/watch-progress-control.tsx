import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import type { AnimeWatchProgress } from "@shared/contracts";

interface WatchProgressControlProps {
  disabled?: boolean;
  maximumEpisodeCount?: number;
  progress: AnimeWatchProgress;
  onChange: (watchedEpisodeCount: number) => void | Promise<void>;
}

/** 展示并维护“看到第几集”的连续观看进度。 */
export function WatchProgressControl({
  disabled = false,
  maximumEpisodeCount,
  progress,
  onChange
}: WatchProgressControlProps) {
  const [draft, setDraft] = useState(String(progress.watchedEpisodeCount));
  const maximum = Number.isSafeInteger(maximumEpisodeCount) && maximumEpisodeCount! > 0
    ? Math.max(maximumEpisodeCount!, progress.watchedEpisodeCount)
    : 10_000;

  useEffect(() => {
    setDraft(String(progress.watchedEpisodeCount));
  }, [progress.watchedEpisodeCount]);

  /** 校验输入并提交观看进度。 */
  function commit(value: number) {
    const normalized = Math.max(0, Math.min(maximum, Math.round(value)));
    setDraft(String(normalized));
    if (normalized !== progress.watchedEpisodeCount) {
      void onChange(normalized);
    }
  }

  /** 基于尚未失焦提交的输入值增减，避免点击步进按钮时产生两次竞态写入。 */
  function step(delta: number) {
    const draftValue = Number(draft);
    const currentValue = Number.isFinite(draftValue) ? draftValue : progress.watchedEpisodeCount;
    commit(currentValue + delta);
  }

  return (
    <div className="min-w-0">
      <div className="flex items-end justify-between gap-3 text-xs">
        <span className="text-muted-foreground">观看进度</span>
        <span className="font-semibold tabular-nums text-primary">
          {progress.watchedEpisodeCount} / {progress.totalEpisodeCount || "--"}
        </span>
      </div>
      <Progress
        aria-label="观看进度"
        className="mt-2 h-1.5"
        value={progress.totalEpisodeCount > 0 ? progress.watchedEpisodeCount / progress.totalEpisodeCount : 0}
      />
      <div className="mt-2 grid grid-cols-[2.25rem_minmax(3.5rem,1fr)_2.25rem] items-center gap-1.5">
        <Button
          aria-label="观看进度减一集"
          className="size-9 p-0"
          disabled={disabled || progress.watchedEpisodeCount <= 0}
          onClick={() => step(-1)}
          onPointerDown={(event) => event.preventDefault()}
          title="减一集"
          type="button"
          variant="outline"
        >
          <Minus data-icon="inline-start" />
        </Button>
        <Input
          aria-label="已观看集数"
          className="h-9 min-w-0 px-2 text-center tabular-nums"
          disabled={disabled}
          inputMode="numeric"
          max={maximum}
          min={0}
          onBlur={() => commit(Number(draft) || 0)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          type="number"
          value={draft}
        />
        <Button
          aria-label="观看进度加一集"
          className="size-9 p-0"
          disabled={disabled || progress.watchedEpisodeCount >= maximum}
          onClick={() => step(1)}
          onPointerDown={(event) => event.preventDefault()}
          title="加一集"
          type="button"
          variant="outline"
        >
          <Plus data-icon="inline-start" />
        </Button>
      </div>
    </div>
  );
}
