import { DownloadQueuePage } from "@/features/downloads/DownloadQueuePage";
import { appApi } from "@/lib/api";

/** 为本地宿主装配完整下载能力。 */
export function DownloadsPage() {
  return <DownloadQueuePage client={appApi} logScope="local" />;
}
