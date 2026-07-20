import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type BadgeTone = "neutral" | "primary" | "primary-soft" | "green" | "amber" | "red" | "blue";

const tones: Record<BadgeTone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  primary: "border-primary/20 bg-primary text-primary-foreground",
  "primary-soft": "border-primary/20 bg-primary/10 text-primary",
  green: "border-success/20 bg-success/10 text-success",
  amber: "border-warning/20 bg-warning/10 text-warning",
  red: "border-destructive/20 bg-destructive/10 text-destructive",
  blue: "border-info/20 bg-info/10 text-info"
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
