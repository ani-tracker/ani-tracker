import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import type { ButtonVariant } from "@/components/ui/button";

interface ConfirmActionDialogProps {
  cancelLabel?: string;
  confirmLabel?: string;
  description: string;
  onConfirm: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
  variant?: Extract<ButtonVariant, "primary" | "destructive">;
}

/** 统一承载需要二次确认的异步操作，并在完成前保持弹窗。 */
export function ConfirmActionDialog({
  cancelLabel = "取消",
  confirmLabel = "确认",
  description,
  onConfirm,
  onOpenChange,
  open,
  title,
  variant = "destructive"
}: ConfirmActionDialogProps) {
  const [confirming, setConfirming] = useState(false);

  /** 执行确认动作，失败时保留弹窗便于用户重试。 */
  async function confirm() {
    setConfirming(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      console.error("[confirm-dialog] 确认操作失败", error);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => !confirming && onOpenChange(nextOpen)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle aria-hidden="true" className="size-5" />
            <AlertDialogTitle>{title}</AlertDialogTitle>
          </div>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={confirming}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={confirming}
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
            variant={variant}
          >
            {confirming && <LoaderCircle aria-hidden="true" className="animate-spin" data-icon="inline-start" />}
            {confirming ? "处理中" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
