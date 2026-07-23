import { CircleAlert, RotateCcw, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface PlayerErrorStateProps {
  message: string;
  onClose: () => void;
  onRetry?: () => void;
  onTranscode?: () => void;
  title?: string;
}

/** 在视频表面中央显示可恢复错误，不替换已有番剧和播放列表数据。 */
export function PlayerErrorState({
  message,
  onClose,
  onRetry,
  onTranscode,
  title = "播放失败"
}: PlayerErrorStateProps) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-4" data-player-no-drag>
      <Alert className="max-w-sm border-destructive/40 bg-background shadow-xl" variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle className="text-base">{title}</AlertTitle>
        <AlertDescription>
          <p className="text-foreground">{message}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {onTranscode && (
              <Button onClick={onTranscode}>
                尝试实时转码
              </Button>
            )}
            {onRetry && (
              <Button onClick={onRetry} variant="outline">
                <RotateCcw data-icon="inline-start" />
                重试
              </Button>
            )}
            <Button onClick={onClose} variant="ghost">
              <X data-icon="inline-start" />
              关闭
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}
