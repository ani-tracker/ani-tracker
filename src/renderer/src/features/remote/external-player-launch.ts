export type ExternalPlayerKind = "potplayer" | "iina";

export interface ExternalPlayerDescriptor {
  kind: ExternalPlayerKind;
  label: string;
}

/** 根据远程浏览器平台选择可调用的本地播放器。 */
export function detectExternalPlayer(
  userAgent: string,
  platform = ""
): ExternalPlayerDescriptor | undefined {
  const platformSignature = `${platform} ${userAgent}`.toLowerCase();
  if (/windows|win32|win64/.test(platformSignature)) {
    return { kind: "potplayer", label: "PotPlayer" };
  }
  const mobileAppleDevice = /iphone|ipad|ipod|mobile/.test(userAgent.toLowerCase());
  if (!mobileAppleDevice && /macintosh|mac os x|macintel/.test(platformSignature)) {
    return { kind: "iina", label: "IINA" };
  }
  return undefined;
}

/** 将受控 HTTP(S) 媒体地址转换为播放器协议地址。 */
export function buildExternalPlayerProtocolUrl(
  player: ExternalPlayerKind,
  mediaUrl: string
): string {
  const parsedUrl = new URL(mediaUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("本地播放器仅支持 HTTP(S) 媒体地址");
  }
  return player === "potplayer"
    ? `potplayer://${mediaUrl}`
    : `iina://weblink?url=${encodeURIComponent(mediaUrl)}`;
}
