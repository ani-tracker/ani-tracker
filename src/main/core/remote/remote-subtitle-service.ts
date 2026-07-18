import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RemotePlaybackSubtitleType } from "@shared/contracts";

const execFileAsync = promisify(execFile);

export interface PreparedRemoteSubtitle {
  assetName: string;
  id: string;
  label: string;
  language?: string;
  type: RemotePlaybackSubtitleType;
  default: boolean;
}

export interface RemoteSubtitlePreparationResult {
  subtitles: PreparedRemoteSubtitle[];
  detectedCount: number;
  unsupportedCount: number;
  failedCount: number;
}

export interface RemoteSubtitlePreparationOptions {
  ffprobePaths: string[];
  ffmpegPath: string;
  timeoutMs: number;
}

interface FfprobeSubtitleStream {
  index?: number;
  codec_name?: string;
  disposition?: { default?: number };
  tags?: Record<string, string | undefined>;
}

interface FfprobeSubtitleOutput {
  streams?: FfprobeSubtitleStream[];
}

interface SupportedSubtitleStream extends FfprobeSubtitleStream {
  index: number;
  outputType: RemotePlaybackSubtitleType;
}

/** 探测并提取浏览器可渲染的内嵌文本字幕。 */
export async function prepareRemoteSubtitles(
  sourcePath: string,
  outputDirectory: string,
  options: RemoteSubtitlePreparationOptions
): Promise<RemoteSubtitlePreparationResult> {
  const detected = await probeSubtitleStreams(sourcePath, options);
  const supported = detected
    .map(resolveSupportedStream)
    .filter((stream): stream is SupportedSubtitleStream => Boolean(stream));
  const subtitles: PreparedRemoteSubtitle[] = [];
  let failedCount = 0;

  for (let order = 0; order < supported.length; order += 1) {
    const stream = supported[order];
    const assetName = `subtitle-${String(order).padStart(3, "0")}.${stream.outputType}`;
    const outputPath = join(outputDirectory, assetName);
    try {
      await execFileAsync(options.ffmpegPath, [
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-i", sourcePath,
        "-map", `0:${stream.index}`,
        "-c:s", stream.outputType === "ass" ? "ass" : "webvtt",
        "-y",
        outputPath
      ], {
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      });
      const outputStats = await stat(outputPath);
      if (outputStats.size <= 0) {
        failedCount += 1;
        continue;
      }
      const language = normalizeLanguage(stream.tags?.language);
      subtitles.push({
        assetName,
        id: `subtitle-${stream.index}`,
        label: buildSubtitleLabel(stream.tags?.title, language, order),
        language,
        type: stream.outputType,
        default: stream.disposition?.default === 1
      });
    } catch {
      failedCount += 1;
    }
  }

  return {
    subtitles,
    detectedCount: detected.length,
    unsupportedCount: detected.length - supported.length,
    failedCount
  };
}

/** 使用首个可用 FFprobe 路径读取字幕流元数据。 */
async function probeSubtitleStreams(
  sourcePath: string,
  options: RemoteSubtitlePreparationOptions
): Promise<FfprobeSubtitleStream[]> {
  let lastError: unknown;
  for (const ffprobePath of [...new Set(options.ffprobePaths.filter(Boolean))]) {
    try {
      const { stdout } = await execFileAsync(ffprobePath, [
        "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        "-select_streams", "s",
        sourcePath
      ], {
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      });
      const output = JSON.parse(String(stdout)) as FfprobeSubtitleOutput;
      return output.streams ?? [];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("FFprobe 字幕探测失败");
}

/** 将 FFprobe 字幕编码映射到 ArtPlayer 支持的文本格式。 */
function resolveSupportedStream(stream: FfprobeSubtitleStream): SupportedSubtitleStream | undefined {
  if (!Number.isInteger(stream.index)) {
    return undefined;
  }
  const codec = stream.codec_name?.toLowerCase();
  if (codec === "ass" || codec === "ssa") {
    return { ...stream, index: stream.index as number, outputType: "ass" };
  }
  if (["subrip", "srt", "webvtt", "mov_text", "text"].includes(codec ?? "")) {
    return { ...stream, index: stream.index as number, outputType: "vtt" };
  }
  return undefined;
}

/** 生成不含标记字符的字幕显示名称。 */
function buildSubtitleLabel(title: string | undefined, language: string | undefined, order: number): string {
  const normalizedTitle = sanitizeLabel(title);
  if (normalizedTitle && language && (
    normalizedTitle.includes(language) || language.includes(normalizedTitle)
  )) {
    return normalizedTitle.length >= language.length ? normalizedTitle : language;
  }
  const parts = [normalizedTitle, language].filter((value, index, values) => value && values.indexOf(value) === index);
  return parts.join(" / ") || `字幕 ${order + 1}`;
}

/** 规范常见字幕语言代码。 */
function normalizeLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  const labels: Record<string, string> = {
    zh: "中文",
    zho: "中文",
    chi: "中文",
    chs: "简体中文",
    cht: "繁体中文",
    ja: "日语",
    jpn: "日语",
    en: "英语",
    eng: "英语"
  };
  return normalized && normalized !== "und" ? (labels[normalized] ?? sanitizeLabel(normalized)) : undefined;
}

/** 清理媒体元数据中的控制符和 HTML 标记字符。 */
function sanitizeLabel(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/[<>\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
  return normalized || undefined;
}
