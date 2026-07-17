import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type BadgeTone = "neutral" | "green" | "amber" | "red" | "blue";

const tones: Record<BadgeTone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  green: "border-primary/20 bg-primary/10 text-primary",
  amber: "border-accent bg-accent text-accent-foreground",
  red: "border-destructive/20 bg-destructive/10 text-destructive",
  blue: "border-sidebar-accent bg-sidebar-accent text-sidebar-accent-foreground"
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/** 渲染使用语义颜色的紧凑状态标签。 */
export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}
