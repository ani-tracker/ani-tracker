import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

interface PanelProps extends HTMLAttributes<HTMLElement> {
  title?: string;
  description?: string;
  action?: ReactNode;
}

export function Panel({ title, description, action, children, className, ...props }: PanelProps) {
  return (
    <section className={cn("rounded-lg border bg-card p-4 shadow-sm", className)} {...props}>
      {(title || description || action) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-base font-semibold tracking-normal">{title}</h2>}
            {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
