const MANUAL_DOWNLOAD_ADDED_EVENT = "ani:manual-download-added";
const NOTIFICATION_PROMPT_HANDLED_KEY = "ani.mobile-download-notification-prompt-handled.v1";

let promptHandledInMemory = false;

/** 通知应用壳：用户已成功添加一个手动下载任务。 */
export function emitManualDownloadAdded(): void {
  window.dispatchEvent(new Event(MANUAL_DOWNLOAD_ADDED_EVENT));
}

/** 监听手动下载成功事件，并返回解除监听函数。 */
export function onManualDownloadAdded(listener: () => void): () => void {
  window.addEventListener(MANUAL_DOWNLOAD_ADDED_EVENT, listener);
  return () => window.removeEventListener(MANUAL_DOWNLOAD_ADDED_EVENT, listener);
}

/** 原子领取一次性通知引导；领取后拒绝或取消均不再自动提示。 */
export function claimMobileDownloadNotificationPrompt(): boolean {
  if (promptHandledInMemory) return false;
  try {
    if (window.localStorage.getItem(NOTIFICATION_PROMPT_HANDLED_KEY) === "1") {
      promptHandledInMemory = true;
      return false;
    }
    window.localStorage.setItem(NOTIFICATION_PROMPT_HANDLED_KEY, "1");
  } catch (error) {
    console.warn("[mobile-notification] 一次性提示标记写入失败", error);
  }
  promptHandledInMemory = true;
  return true;
}
