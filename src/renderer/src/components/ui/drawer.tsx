import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";

interface DrawerProps {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  onClose: () => void;
}

/** 使用 Radix Sheet 提供带焦点锁定和焦点恢复的兼容抽屉。 */
export function Drawer({ ariaLabel, children, className, onClose }: DrawerProps) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent className={cn("gap-0 p-0", className)} showCloseButton={false}>
        <SheetTitle className="sr-only">{ariaLabel}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
