import { Badge } from "@/components/ui/badge";
import type {
  NormalizedVideoCodec,
  Release,
  SubtitleLanguage,
  SubtitlePreference,
  VideoBitDepth
} from "@shared/domain";
import { formatSubtitleLanguages, formatVideoBitDepth } from "@shared/release-metadata";

export interface ReleaseTechnicalMetadata {
  resolution?: Release["resolution"];
  declaredVideoCodec?: string;
  normalizedVideoCodec?: NormalizedVideoCodec;
  bitDepth?: VideoBitDepth;
  subtitleLanguages?: SubtitleLanguage[];
  subtitle?: SubtitlePreference;
}

/** 统一展示资源编码、位深、字幕语言和分辨率，未知字段不做推断。 */
export function ReleaseMetadataBadges({
  metadata,
  showResolution = true,
  showUnknown = true
}: {
  metadata: ReleaseTechnicalMetadata;
  showResolution?: boolean;
  showUnknown?: boolean;
}) {
  const codec = metadata.normalizedVideoCodec && metadata.normalizedVideoCodec !== "Unknown"
    ? metadata.normalizedVideoCodec
    : metadata.declaredVideoCodec || undefined;
  const subtitle = formatSubtitleLanguages(metadata.subtitleLanguages, metadata.subtitle);

  return (
    <>
      {showResolution && metadata.resolution && <Badge>{metadata.resolution}</Badge>}
      {(codec || showUnknown) && <Badge tone={codec ? "green" : "neutral"}>{codec ?? "编码未知"}</Badge>}
      {(metadata.bitDepth || showUnknown) && <Badge>{formatVideoBitDepth(metadata.bitDepth)}</Badge>}
      {(subtitle !== "字幕未知" || showUnknown) && <Badge>{subtitle}</Badge>}
    </>
  );
}
