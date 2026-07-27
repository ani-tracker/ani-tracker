import { toast as sonnerToast, type ExternalToast } from "sonner";
import { getAppRuntime } from "@/lib/runtime";
import { resolveToastDuration, resolveToastPresentation, type ToastFeedbackKind } from "@shared/toast-policy";

type ToastMessage = Parameters<typeof sonnerToast>[0];

/** 应用移动停留时间，并用新提示替换已有移动提示。 */
function mobileOptions(kind: ToastFeedbackKind, options?: ExternalToast): ExternalToast | undefined {
  const runtime = getAppRuntime();
  const presentation = resolveToastPresentation(runtime);
  if (!presentation.mobile) return options;
  if (options?.id === undefined) sonnerToast.dismiss();
  const duration = resolveToastDuration(runtime, kind, Boolean(options?.action));
  return duration === undefined || options?.duration !== undefined
    ? options
    : { ...options, duration };
}

/** 使用统一移动反馈策略显示普通 Sonner 提示。 */
function showToast(kind: ToastFeedbackKind, message: ToastMessage, options?: ExternalToast) {
  const nextOptions = mobileOptions(kind, options);
  switch (kind) {
    case "success":
      return sonnerToast.success(message, nextOptions);
    case "info":
      return sonnerToast.info(message, nextOptions);
    case "warning":
      return sonnerToast.warning(message, nextOptions);
    case "error":
      return sonnerToast.error(message, nextOptions);
    case "loading":
      return sonnerToast.loading(message, nextOptions);
    default:
      return sonnerToast(message, nextOptions);
  }
}

const baseToast = ((message: ToastMessage, options?: ExternalToast) =>
  showToast("normal", message, options)) as typeof sonnerToast;

/** 保持 Sonner API 不变，并为移动端统一位置、替换和停留策略。 */
export const toast: typeof sonnerToast = Object.assign(baseToast, {
  success: (message: ToastMessage, options?: ExternalToast) => showToast("success", message, options),
  info: (message: ToastMessage, options?: ExternalToast) => showToast("info", message, options),
  warning: (message: ToastMessage, options?: ExternalToast) => showToast("warning", message, options),
  error: (message: ToastMessage, options?: ExternalToast) => showToast("error", message, options),
  loading: (message: ToastMessage, options?: ExternalToast) => showToast("loading", message, options),
  message: (message: ToastMessage, options?: ExternalToast) => showToast("normal", message, options),
  custom: (...args: Parameters<typeof sonnerToast.custom>) =>
    sonnerToast.custom(args[0], mobileOptions("normal", args[1])),
  promise: sonnerToast.promise,
  dismiss: sonnerToast.dismiss,
  getHistory: sonnerToast.getHistory,
  getToasts: sonnerToast.getToasts
});
