import { unzipSync } from "fflate";
import { isValidThemeArchiveEntryName } from "./theme";

const MAX_THEME_ARCHIVE_ENTRIES = 2;
const MAX_THEME_ARCHIVE_OUTPUT_BYTES = 24 * 1024 * 1024;

/** 解包受限主题 ZIP，拒绝目录穿越、额外文件和高膨胀内容。 */
export function unpackThemeArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  let expandedBytes = 0;
  let entryCount = 0;
  try {
    return unzipSync(bytes, {
      filter(entry) {
        entryCount += 1;
        expandedBytes += entry.originalSize;
        if (entryCount > MAX_THEME_ARCHIVE_ENTRIES) {
          throw new Error("主题 ZIP 最多包含 JSON 和一张背景图");
        }
        if (expandedBytes > MAX_THEME_ARCHIVE_OUTPUT_BYTES) {
          throw new Error("主题 ZIP 解压后超过 24 MiB 限制");
        }
        if (!isValidThemeArchiveEntryName(entry.name)) {
          throw new Error(`主题 ZIP 包含不安全或不支持的文件：${entry.name}`);
        }
        return true;
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("主题 ZIP")) throw error;
    throw new Error("主题 ZIP 结构无效");
  }
}
