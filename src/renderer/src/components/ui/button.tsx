import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "outline"
  | "destructive"
  | "navigation"
  | "media"
  | "media-strong";

export type ButtonSize = "default" | "compact" | "icon" | "media" | "media-large";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: ButtonSize;
  variant?: ButtonVariant;
}

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-accent text-accent-foreground hover:bg-accent/80",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  outline: "border border-border bg-background hover:bg-accent",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  navigation: "border-l-2 border-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:border-sidebar-primary data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:text-sidebar-primary",
  media: "bg-transparent text-white hover:bg-white/15 hover:text-white",
  "media-strong": "border border-white/20 bg-black/55 text-white hover:bg-black/70 hover:text-white"
};

const buttonBaseClassName =
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const sizes: Record<ButtonSize, string> = {
  default: "min-h-11 px-3 md:min-h-9",
  compact: "min-h-9 px-2",
  icon: "size-11 p-0 md:size-9",
  media: "size-12 p-0 md:size-11 [&_svg]:!size-6",
  "media-large": "size-16 p-0 [&_svg]:!size-8"
};

/** 返回可复用于 Radix 动作元素的统一按钮样式。 */
export function buttonClassName(
  variant: ButtonVariant = "primary",
  className?: string,
  size: ButtonSize = "default"
) {
  return cn(buttonBaseClassName, variants[variant], sizes[size], className);
}

/** 渲染统一尺寸、状态和图标规则的命令按钮。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, size = "default", variant = "primary", ...props }, ref) => (
    <button
      ref={ref}
      className={buttonClassName(variant, className, size)}
      {...props}
    />
  )
);

Button.displayName = "Button";
