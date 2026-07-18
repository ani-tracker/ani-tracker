import { ImageOff } from "lucide-react";
import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveCachedImageUrl } from "@/lib/api";
import { cn } from "@/lib/cn";

interface CachedImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "src"> {
  alt: string;
  sourceUrl: string;
  fallback?: ReactNode;
}

/** 通过主进程共享缓存加载图片，并提供稳定的加载与失败状态。 */
export function CachedImage({
  alt,
  className,
  fallback,
  onError,
  sourceUrl,
  ...props
}: CachedImageProps) {
  const [resolvedUrl, setResolvedUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setResolvedUrl(undefined);
    setFailed(false);
    void resolveCachedImageUrl(sourceUrl).then((url) => {
      if (active) {
        setResolvedUrl(url);
      }
    }).catch((error: unknown) => {
      console.warn("[image-cache] 图片缓存地址解析失败", {
        error: error instanceof Error ? error.message : String(error)
      });
      if (active) {
        setFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [sourceUrl]);

  if (failed) {
    return (
      <div
        aria-label={`${alt}加载失败`}
        className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}
        role="img"
      >
        {fallback ?? <ImageOff aria-hidden="true" />}
      </div>
    );
  }

  if (!resolvedUrl) {
    return <Skeleton aria-hidden="true" className={className} />;
  }

  return (
    <img
      {...props}
      alt={alt}
      className={className}
      onError={(event) => {
        setFailed(true);
        onError?.(event);
      }}
      src={resolvedUrl}
    />
  );
}
