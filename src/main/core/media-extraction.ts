import type { MediaExtractInput, MediaInfoExtractor, PartialMediaInfo } from "@shared/contracts";
import type { NormalizedVideoCodec } from "@shared/domain";

const codecPatterns: Array<{ pattern: RegExp; codec: NormalizedVideoCodec }> = [
  { pattern: /\b(?:h\.?265|x265|hevc)\b/i, codec: "H.265/HEVC" },
  { pattern: /\b(?:h\.?264|x264|avc)\b/i, codec: "H.264/AVC" },
  { pattern: /\bav1\b/i, codec: "AV1" },
  { pattern: /\bvp9\b/i, codec: "VP9" }
];

const resolutionPatterns = [
  /\b(2160p|4k)\b/i,
  /\b(1080p)\b/i,
  /\b(720p)\b/i,
  /\b(\d{3,4}x\d{3,4})\b/i
];

export function normalizeVideoCodec(value?: string): NormalizedVideoCodec {
  if (!value) {
    return "Unknown";
  }

  for (const item of codecPatterns) {
    if (item.pattern.test(value)) {
      return item.codec;
    }
  }

  return "Unknown";
}

export class ReleaseTitleExtractor implements MediaInfoExtractor {
  name = "release-title";

  async extract(input: MediaExtractInput): Promise<PartialMediaInfo | null> {
    if (!input.release?.title) {
      return null;
    }

    return extractFromText(input.release.title, this.name, 0.45);
  }
}

export class FileNameExtractor implements MediaInfoExtractor {
  name = "file-name";

  async extract(input: MediaExtractInput): Promise<PartialMediaInfo | null> {
    if (!input.fileName && !input.filePath) {
      return null;
    }

    const text = input.fileName ?? input.filePath ?? "";
    return extractFromText(text, this.name, 0.6);
  }
}

export class ManualOverrideExtractor implements MediaInfoExtractor {
  name = "manual-override";

  constructor(private readonly override?: PartialMediaInfo) {}

  async extract(): Promise<PartialMediaInfo | null> {
    if (!this.override) {
      return null;
    }

    return {
      ...this.override,
      confidence: 1,
      source: this.name
    };
  }
}

export class MediaExtractionChain {
  constructor(private readonly extractors: MediaInfoExtractor[]) {}

  async extract(input: MediaExtractInput): Promise<PartialMediaInfo> {
    const candidates = await Promise.all(this.extractors.map((extractor) => extractor.extract(input)));
    return mergeMediaInfo(candidates.filter(Boolean) as PartialMediaInfo[]);
  }
}

export function createDefaultMediaExtractionChain(): MediaExtractionChain {
  return new MediaExtractionChain([new ReleaseTitleExtractor(), new FileNameExtractor()]);
}

function extractFromText(text: string, source: string, confidence: number): PartialMediaInfo {
  const normalizedVideoCodec = normalizeVideoCodec(text);
  const declaredVideoCodec = detectCodecLabel(text);
  const resolution = resolutionPatterns.map((pattern) => pattern.exec(text)?.[1]).find(Boolean);
  const bitDepthMatch = text.match(/\b(8|10|12)\s*[- ]?\s*bits?\b/i);
  const bitDepth = /\b(?:hi10p|main\s*10)\b/i.test(text)
    ? 10
    : bitDepthMatch?.[1]
      ? Number(bitDepthMatch[1])
      : undefined;

  return {
    declaredVideoCodec,
    normalizedVideoCodec,
    resolution: resolution?.toUpperCase() === "4K" ? "2160p" : resolution,
    bitDepth,
    audioCodecs: detectAudioCodecs(text),
    subtitleTracks: detectSubtitleTracks(text),
    confidence,
    source
  };
}

function detectCodecLabel(text: string): string | undefined {
  const labels = [
    /\b(h\.?265|x265|hevc)\b/i,
    /\b(h\.?264|x264|avc)\b/i,
    /\bav1\b/i,
    /\bvp9\b/i
  ];

  for (const pattern of labels) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
    if (match?.[0]) {
      return match[0];
    }
  }

  return undefined;
}

function detectAudioCodecs(text: string): string[] {
  const codecs = [
    { pattern: /\bflac\b/i, value: "FLAC" },
    { pattern: /\baac\b/i, value: "AAC" },
    { pattern: /\bopus\b/i, value: "OPUS" },
    { pattern: /\be-?ac-?3\b/i, value: "E-AC-3" }
  ];

  return codecs.filter((item) => item.pattern.test(text)).map((item) => item.value);
}

function detectSubtitleTracks(text: string): string[] {
  const tracks = new Set<string>();
  if (/(?:\b(?:chs|gb)\b|简体|简中|简日|简繁|繁简)/i.test(text)) tracks.add("chs");
  if (/(?:\b(?:cht|big5)\b|繁体|繁中|繁日|简繁|繁简)/i.test(text)) tracks.add("cht");
  if (/(?:\b(?:jpn|jp)\b|日文|日语|日語|简日|繁日)/i.test(text)) tracks.add("jpn");
  if (/(?:\beng\b|英文|英语|英語)/i.test(text)) tracks.add("eng");
  return [...tracks];
}

export function mergeMediaInfo(candidates: PartialMediaInfo[]): PartialMediaInfo {
  const sorted = [...candidates].sort((a, b) => a.confidence - b.confidence);
  const merged: PartialMediaInfo = {
    confidence: 0,
    source: "empty"
  };

  for (const candidate of sorted) {
    merged.container = candidate.container ?? merged.container;
    merged.declaredVideoCodec = candidate.declaredVideoCodec ?? merged.declaredVideoCodec;
    merged.detectedVideoCodec = candidate.detectedVideoCodec ?? merged.detectedVideoCodec;
    merged.normalizedVideoCodec =
      candidate.normalizedVideoCodec && candidate.normalizedVideoCodec !== "Unknown"
        ? candidate.normalizedVideoCodec
        : merged.normalizedVideoCodec;
    merged.resolution = candidate.resolution ?? merged.resolution;
    merged.bitDepth = candidate.bitDepth ?? merged.bitDepth;
    merged.audioCodecs = candidate.audioCodecs?.length ? candidate.audioCodecs : merged.audioCodecs;
    merged.subtitleTracks = candidate.subtitleTracks?.length ? candidate.subtitleTracks : merged.subtitleTracks;
    merged.durationSeconds = candidate.durationSeconds ?? merged.durationSeconds;
    merged.confidence = Math.max(merged.confidence, candidate.confidence);
    merged.source = candidate.source;
  }

  return {
    ...merged,
    normalizedVideoCodec: merged.normalizedVideoCodec ?? "Unknown",
    audioCodecs: merged.audioCodecs ?? [],
    subtitleTracks: merged.subtitleTracks ?? []
  };
}
