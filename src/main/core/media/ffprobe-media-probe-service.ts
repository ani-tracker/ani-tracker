import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import type {
  MediaExtractInput,
  MediaProbeContext,
  MediaProbeService,
  PartialMediaInfo
} from "@shared/contracts";
import type { MediaFile } from "@shared/domain";
import {
  createDefaultMediaExtractionChain,
  mergeMediaInfo,
  normalizeVideoCodec,
  type MediaExtractionChain
} from "../media-extraction";

const execFileAsync = promisify(execFile);

export interface FfprobeMediaProbeOptions {
  ffprobePath: string;
  timeoutMs: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
  };
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string | number;
  bits_per_sample?: string | number;
  tags?: Record<string, string | undefined>;
}

export class FfprobeMediaProbeService implements MediaProbeService {
  private readonly chain: MediaExtractionChain;

  constructor(
    private readonly options: FfprobeMediaProbeOptions,
    chain = createDefaultMediaExtractionChain()
  ) {
    this.chain = chain;
  }

  async probe(filePath: string, context: MediaProbeContext = {}): Promise<MediaFile> {
    const fileStats = await stat(filePath);
    const fileName = basename(filePath);
    const chainInfo = await this.extractFromChain({
      release: context.release,
      filePath,
      fileName
    });
    const ffprobeInfo = await this.tryProbeWithFfprobe(filePath);
    const merged = mergeMediaInfo([chainInfo, ffprobeInfo].filter(Boolean) as PartialMediaInfo[]);

    return {
      id: createMediaFileId(filePath),
      animeId: context.animeId ?? "unmatched",
      episodeId: context.episodeId,
      downloadTaskId: context.downloadTaskId,
      filePath,
      fileName,
      size: fileStats.size || context.size || 0,
      container: merged.container ?? detectContainer(filePath),
      declaredVideoCodec: merged.declaredVideoCodec,
      detectedVideoCodec: merged.detectedVideoCodec,
      normalizedVideoCodec: merged.normalizedVideoCodec ?? "Unknown",
      resolution: merged.resolution,
      bitDepth: merged.bitDepth,
      audioCodecs: merged.audioCodecs ?? [],
      subtitleTracks: merged.subtitleTracks ?? [],
      durationSeconds: merged.durationSeconds,
      downloadedAt: context.downloadedAt,
      probedAt: new Date().toISOString()
    };
  }

  async extractFromChain(input: MediaExtractInput): Promise<PartialMediaInfo> {
    return this.chain.extract(input);
  }

  private async tryProbeWithFfprobe(filePath: string): Promise<PartialMediaInfo | null> {
    try {
      const output = await runFfprobe(filePath, this.options);
      return mapFfprobeOutput(output, filePath);
    } catch {
      return null;
    }
  }
}

async function runFfprobe(filePath: string, options: FfprobeMediaProbeOptions): Promise<FfprobeOutput> {
  const args = ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath];
  const { stdout } = await execFileAsync(options.ffprobePath || "ffprobe", args, {
    timeout: options.timeoutMs,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });

  return JSON.parse(String(stdout)) as FfprobeOutput;
}

function mapFfprobeOutput(output: FfprobeOutput, filePath: string): PartialMediaInfo {
  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const normalizedVideoCodec = normalizeVideoCodec(video?.codec_name);

  return {
    container: detectContainer(filePath, output.format?.format_name),
    detectedVideoCodec: video?.codec_name,
    normalizedVideoCodec,
    resolution: video?.width && video.height ? `${video.width}x${video.height}` : undefined,
    bitDepth: detectBitDepth(video),
    audioCodecs: unique(
      streams
        .filter((stream) => stream.codec_type === "audio")
        .map((stream) => normalizeAudioCodec(stream.codec_name))
        .filter(Boolean) as string[]
    ),
    subtitleTracks: unique(
      streams
        .filter((stream) => stream.codec_type === "subtitle")
        .map(formatSubtitleTrack)
        .filter(Boolean) as string[]
    ),
    durationSeconds: parseDuration(output.format?.duration),
    confidence: 0.95,
    source: "ffprobe"
  };
}

function detectContainer(filePath: string, formatName?: string): MediaFile["container"] {
  const extension = extname(filePath).replace(".", "").toLowerCase();
  if (extension === "mkv" || extension === "mp4" || extension === "avi") {
    return extension;
  }

  const normalizedFormat = formatName?.toLowerCase() ?? "";
  if (normalizedFormat.includes("matroska")) {
    return "mkv";
  }
  if (normalizedFormat.includes("mp4") || normalizedFormat.includes("mov")) {
    return "mp4";
  }
  if (normalizedFormat.includes("avi")) {
    return "avi";
  }

  return "unknown";
}

function detectBitDepth(stream?: FfprobeStream): number | undefined {
  if (!stream) {
    return undefined;
  }

  const explicit = Number(stream.bits_per_raw_sample ?? stream.bits_per_sample);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  const match = stream.pix_fmt?.match(/(?:p|gbrp)(10|12|14|16)(?:le|be)?/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function normalizeAudioCodec(codec?: string): string | undefined {
  if (!codec) {
    return undefined;
  }

  const labels: Record<string, string> = {
    aac: "AAC",
    ac3: "AC-3",
    eac3: "E-AC-3",
    flac: "FLAC",
    mp3: "MP3",
    opus: "OPUS",
    truehd: "TrueHD",
    dts: "DTS"
  };

  return labels[codec.toLowerCase()] ?? codec.toUpperCase();
}

function formatSubtitleTrack(stream: FfprobeStream): string | undefined {
  const language = stream.tags?.language?.toLowerCase();
  const title = stream.tags?.title;
  const codec = stream.codec_name?.toUpperCase();
  return [language, title, codec].filter(Boolean).join(" / ") || undefined;
}

function parseDuration(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function createMediaFileId(filePath: string): string {
  const hash = createHash("sha1").update(filePath.toLowerCase()).digest("hex").slice(0, 16);
  return `media-${hash}`;
}
