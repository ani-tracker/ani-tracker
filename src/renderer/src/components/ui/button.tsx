import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "destructive" | "navigation";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-accent text-accent-foreground hover:bg-accent/80",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  outline: "border border-border bg-background hover:bg-accent",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  navigation: "border-l-2 border-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:border-sidebar-primary data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:text-sidebar-primary"
};

const buttonBaseClassName =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 md:min-h-9 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

/** 返回可复用于 Radix 动作元素的统一按钮样式。 */
export function buttonClassName(variant: ButtonVariant = "primary", className?: string) {
  return cn(buttonBaseClassName, variants[variant], className);
}

/** 渲染统一尺寸、状态和图标规则的命令按钮。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", ...props }, ref) => (
    <button
      ref={ref}
      className={buttonClassName(variant, className)}
      {...props}
    />
  )
);

Button.displayName = "Button";
