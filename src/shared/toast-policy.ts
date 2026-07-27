import type { AppRuntimeKind } from "./platform-runtime";

export type ToastFeedbackKind = "normal" | "success" | "info" | "warning" | "error" | "loading";

export interface ToastPresentationPolicy {
  mobile: boolean;
  position: "top-right" | "bottom-center";
  closeButton: boolean;
  visibleToasts?: number;
  swipeDirections?: Array<"bottom">;
}

/** 按运行平台返回全局提示的位置、数量和关闭方式。 */
export function resolveToastPresentation(runtime: AppRuntimeKind): ToastPresentationPolicy {
  const mobile = runtime === "android" || runtime === "ios";
  return mobile
    ? {
        mobile: true,
        position: "bottom-center",
        closeButton: false,
        visibleToasts: 1,
        swipeDirections: ["bottom"]
      }
    : {
        mobile: false,
        position: "top-right",
        closeButton: true
      };
}

/** 返回移动反馈的默认停留时间，桌面继续使用 Sonner 默认值。 */
export function resolveToastDuration(
  runtime: AppRuntimeKind,
  kind: ToastFeedbackKind,
  hasAction: boolean
): number | undefined {
  if (runtime !== "android" && runtime !== "ios") return undefined;
  if (kind === "loading") return undefined;
  return hasAction || kind === "warning" || kind === "error" ? 6_000 : 3_000;
}
