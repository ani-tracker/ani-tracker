import type { MediaContentKind } from "./domain";

export interface MediaContentIdentity {
  contentKind: MediaContentKind;
  specialNo?: string;
}

const latinFileMarker = /(?:^|[^a-z0-9])(NCOP|NCED|SPECIAL|OVA|OAD|SP|PV|CM)(?:[\s._-]*(\d{1,3}))?(?:[^a-z0-9]|$)/i;
const chineseFileMarker = /(映像特典|特典|番外篇)(?:[\s._-]*(\d{1,3}))?/;
const directoryMarker = /^(NCOP|NCED|SPECIALS?|OVA|OAD|SP|PV|CM|EXTRAS?|BONUS|映像特典|特典|番外篇)(?:[\s._-]*(?:VOL(?:UME)?[\s._-]*)?\d{1,3})?$/i;

/** 目录标记优先于普通集数，推断播放文件的内容类型。 */
export function inferMediaContent(filePath: string, episodeNo?: number): MediaContentIdentity {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  const fileName = segments.at(-1) ?? filePath;
  const fileMarker = matchFileMarker(fileName);
  if (fileMarker) return buildSpecialIdentity(fileMarker, episodeNo);

  for (const directory of segments.slice(0, -1).reverse()) {
    const marker = directory.match(directoryMarker)?.[1];
    if (marker) return buildSpecialIdentity(marker, episodeNo);
  }
  return { contentKind: episodeNo === undefined ? "unknown" : "episode" };
}

/** 判断内容类型是否必须与正片进度隔离。 */
export function isSpecialMediaContent(contentKind: MediaContentKind): boolean {
  return contentKind !== "episode" && contentKind !== "unknown";
}

/** 生成播放器列表主标题，文件名由调用方作为次要信息展示。 */
export function formatMediaDisplayTitle(
  animeTitle: string,
  identity: MediaContentIdentity,
  episodeNo?: number
): string {
  const suffix = isSpecialMediaContent(identity.contentKind)
    ? identity.specialNo ?? "特别内容"
    : episodeNo === undefined ? undefined : `E${episodeNo}`;
  return suffix ? `${animeTitle} · ${suffix}` : animeTitle;
}

function matchFileMarker(fileName: string): string | undefined {
  const latin = fileName.match(latinFileMarker);
  if (latin) return `${latin[1]}:${latin[2] ?? ""}`;
  const chinese = fileName.match(chineseFileMarker);
  return chinese ? `${chinese[1]}:${chinese[2] ?? ""}` : undefined;
}

function buildSpecialIdentity(markerWithNumber: string, fallbackNumber?: number): MediaContentIdentity {
  const [rawMarker, markerNumber] = markerWithNumber.split(":", 2);
  const marker = rawMarker.toUpperCase();
  const number = markerNumber ? Number(markerNumber) : fallbackNumber;
  const [contentKind, prefix] = markerKindAndPrefix(marker);
  return {
    contentKind,
    specialNo: `${prefix}${formatSpecialNumber(number)}`
  };
}

function markerKindAndPrefix(marker: string): [MediaContentKind, string] {
  if (marker === "OVA") return ["ova", "OVA"];
  if (marker === "OAD") return ["oad", "OAD"];
  if (marker === "NCOP") return ["opening", "NCOP"];
  if (marker === "NCED") return ["ending", "NCED"];
  if (marker === "PV") return ["pv", "PV"];
  if (marker === "CM") return ["cm", "CM"];
  if (["EXTRA", "EXTRAS", "BONUS", "映像特典", "特典"].includes(marker)) {
    return ["extra", "EXTRA"];
  }
  return ["special", "SP"];
}

function formatSpecialNumber(number?: number): string {
  if (number === undefined || !Number.isFinite(number)) return "";
  return Number.isInteger(number) ? String(number).padStart(2, "0") : String(number);
}
