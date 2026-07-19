import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { cn } from "@/lib/cn";

interface WorkbenchSheetProps {
  bodyClassName?: string;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  footer?: ReactNode;
  headerContent?: ReactNode;
  onClose: () => void;
  title: ReactNode;
}

/** 提供标题、正文滚动区和可选固定底栏一致的工作台侧栏。 */
export function WorkbenchSheet({
  bodyClassName,
  children,
  className,
  description,
  footer,
  headerContent,
  onClose,
  title
}: WorkbenchSheetProps) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className={cn("flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl", className)}
        showCloseButton={false}
      >
        <SheetHeader className="shrink-0 border-b px-4 py-4 pr-16 text-left sm:px-6">
          <SheetTitle className="min-w-0 truncate">{title}</SheetTitle>
          {description && <SheetDescription className="min-w-0 truncate">{description}</SheetDescription>}
          <Button
            aria-label="关闭"
            className="absolute right-3 top-3 size-11 p-0 md:size-9"
            onClick={onClose}
            title="关闭"
            variant="ghost"
          >
            <X />
          </Button>
        </SheetHeader>
        {headerContent && <div className="shrink-0 border-b px-4 py-3 sm:px-6">{headerContent}</div>}
        <div className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 sm:px-6", bodyClassName)}>
          {children}
        </div>
        {footer && (
          <footer className="shrink-0 border-t bg-background px-4 py-3 pb-[max(0.75rem,var(--safe-area-bottom))] sm:px-6">
            {footer}
          </footer>
        )}
      </SheetContent>
    </Sheet>
  );
}
