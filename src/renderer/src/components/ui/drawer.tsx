import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

interface DrawerProps {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  onClose: () => void;
}

/** 将抽屉挂载到 body，避免页面布局间距和层叠上下文影响全屏遮罩。 */
export function Drawer({ ariaLabel, children, className, onClose }: DrawerProps) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end bg-foreground/35"
      data-drawer-overlay=""
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <aside
        aria-label={ariaLabel}
        aria-modal="true"
        className={cn("animate-slide-in-right h-full w-full border-l bg-card shadow-xl", className)}
        role="dialog"
      >
        {children}
      </aside>
    </div>,
    document.body
  );
}
