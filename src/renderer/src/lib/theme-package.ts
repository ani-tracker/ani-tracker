import { strToU8, zipSync } from "fflate";
import {
  THEME_SCHEMA_VERSION,
  validateThemePack,
  type ThemeBackgroundImageSettings,
  type ThemePackManifest,
  type ThemeTokens
} from "@shared/theme";
import { unpackThemeArchive } from "@shared/theme-archive";
import type { SaveThemeBackgroundInput } from "@shared/contracts";

const MAX_THEME_JSON_BYTES = 128 * 1024;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BACKGROUND_BYTES = 3 * 1024 * 1024;
const MAX_BACKGROUND_EDGE = 3840;
const MAX_BACKGROUND_PIXELS = 16_000_000;
const SAMPLE_EDGE = 64;
const MIN_OVERLAY_OPACITY = 0.55;
const MAX_OVERLAY_OPACITY = 0.98;
const MIN_IMAGE_TEXT_CONTRAST = 4.5;

export interface NormalizedThemeBackground {
  writeInput: Omit<SaveThemeBackgroundInput, "themeId">;
  samples: Uint8ClampedArray;
}

export interface ThemeImportResult {
  pack: ThemePackManifest;
  background?: NormalizedThemeBackground;
}

export interface ThemeExportResult {
  blob: Blob;
  fileName: string;
}

/** 读取旧 JSON 或 v2 ZIP，并在返回前完成严格 Schema 与背景对比度校验。 */
export async function readThemeImport(file: File): Promise<ThemeImportResult> {
  if (file.size <= 0 || file.size > MAX_ARCHIVE_BYTES) {
    throw new Error("主题文件为空或超过 20 MiB 限制");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeZip(bytes)) {
    if (bytes.byteLength > MAX_THEME_JSON_BYTES) throw new Error("主题 JSON 不能超过 128KB");
    return { pack: parseThemeManifest(new TextDecoder().decode(bytes)) };
  }

  const entries = unpackThemeArchive(bytes);
  const jsonEntries = Object.entries(entries).filter(([name]) => name.endsWith(".ani-theme.json"));
  if (jsonEntries.length !== 1) throw new Error("主题 ZIP 必须包含且只能包含一个 .ani-theme.json");
  const [jsonName, jsonBytes] = jsonEntries[0];
  if (jsonBytes.byteLength > MAX_THEME_JSON_BYTES) throw new Error("主题 JSON 不能超过 128KB");
  const pack = parseThemeManifest(new TextDecoder().decode(jsonBytes));
  if (jsonName !== `${pack.id}.ani-theme.json`) {
    throw new Error("主题 ZIP 的 JSON 文件名必须与主题 ID 一致");
  }
  const otherEntries = Object.entries(entries).filter(([name]) => name !== jsonName);
  if (!pack.backgroundImage) {
    if (otherEntries.length > 0) throw new Error("纯色主题 ZIP 不应包含背景图片");
    return { pack };
  }
  const backgroundEntry = otherEntries.find(([name]) => name === pack.backgroundImage?.file);
  if (!backgroundEntry || otherEntries.length !== 1) {
    throw new Error(`主题 ZIP 缺少 JSON 引用的背景图片：${pack.backgroundImage.file}`);
  }
  const background = await normalizeThemeBackground(backgroundEntry[1], backgroundEntry[0]);
  validateThemeBackgroundContrast(pack, background.samples);
  return {
    pack: {
      ...pack,
      backgroundImage: { ...pack.backgroundImage, file: background.writeInput.fileName }
    },
    background
  };
}

/** 将用户选择的普通图片压缩为宿主允许持久化的背景格式。 */
export async function normalizeThemeBackgroundFile(file: File): Promise<NormalizedThemeBackground> {
  if (file.size <= 0 || file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("背景图片为空或超过 20 MiB 限制");
  }
  return normalizeThemeBackground(new Uint8Array(await file.arrayBuffer()), file.name);
}

/** 从应用私有主题地址读取图片采样，用于编辑后重新校验文字对比度。 */
export async function sampleThemeBackgroundUrl(url: string, fileName: string): Promise<Uint8ClampedArray> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("读取主题背景图失败");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_BACKGROUND_BYTES) {
    throw new Error("主题背景图为空或超过 3 MiB 限制");
  }
  const sourceType = detectImageType(bytes, fileName);
  const image = await loadImage(new Blob([copyToArrayBuffer(bytes)], { type: sourceType }));
  try {
    return sampleImage(image.element);
  } finally {
    image.dispose();
  }
}

/** 为手动上传图片补齐安全遮罩，并返回更新后的主题。 */
export function attachThemeBackground(
  pack: ThemePackManifest,
  background: NormalizedThemeBackground
): ThemePackManifest {
  const current = pack.backgroundImage ?? defaultBackgroundSettings(background.writeInput.fileName);
  const light = Math.max(
    current.overlayOpacity.light,
    minimumSafeOverlayOpacity(pack.tokens.light, background.samples)
  );
  const dark = Math.max(
    current.overlayOpacity.dark,
    minimumSafeOverlayOpacity(pack.tokens.dark, background.samples)
  );
  return {
    ...pack,
    schemaVersion: THEME_SCHEMA_VERSION,
    backgroundImage: {
      file: background.writeInput.fileName,
      position: current.position,
      overlayOpacity: { light, dark }
    }
  };
}

/** 创建可直接分享的 JSON 或包含独立图片的 ZIP 主题包。 */
export async function createThemeExport(
  pack: ThemePackManifest,
  backgroundUrl?: string
): Promise<ThemeExportResult> {
  const validated = validateThemePack(pack);
  if (!validated.pack) throw new Error(validated.errors[0] ?? "主题校验失败");
  const jsonBytes = strToU8(`${JSON.stringify(validated.pack, null, 2)}\n`);
  if (!validated.pack.backgroundImage) {
    return {
      blob: new Blob([jsonBytes], { type: "application/json" }),
      fileName: `${validated.pack.id}.ani-theme.json`
    };
  }
  if (!backgroundUrl) throw new Error("主题背景图尚未上传，无法导出完整主题包");
  const response = await fetch(backgroundUrl);
  if (!response.ok) throw new Error("读取主题背景图失败");
  const backgroundBytes = new Uint8Array(await response.arrayBuffer());
  if (backgroundBytes.byteLength > MAX_BACKGROUND_BYTES) throw new Error("主题背景图超过 3 MiB 限制");
  const archive = zipSync({
    [`${validated.pack.id}.ani-theme.json`]: jsonBytes,
    [validated.pack.backgroundImage.file]: backgroundBytes
  }, { level: 6 });
  return {
    blob: new Blob([archive], { type: "application/zip" }),
    fileName: `${validated.pack.id}.ani-theme.zip`
  };
}

/** 校验背景图片经过主题遮罩后仍能承载页面默认文字。 */
export function validateThemeBackgroundContrast(pack: ThemePackManifest, samples: Uint8ClampedArray): void {
  if (!pack.backgroundImage) return;
  for (const mode of ["light", "dark"] as const) {
    const configured = pack.backgroundImage.overlayOpacity[mode];
    const minimum = minimumSafeOverlayOpacity(pack.tokens[mode], samples);
    if (configured + 0.0001 < minimum) {
      const label = mode === "light" ? "浅色" : "深色";
      throw new Error(`${label}背景遮罩至少需要 ${minimum.toFixed(2)}，当前为 ${configured.toFixed(2)}`);
    }
  }
}

/** 计算给定图片和主题前景色所需的最小安全遮罩强度。 */
export function minimumSafeOverlayOpacity(tokens: ThemeTokens, samples: Uint8ClampedArray): number {
  for (let value = MIN_OVERLAY_OPACITY; value <= MAX_OVERLAY_OPACITY + 0.0001; value += 0.01) {
    const opacity = Number(value.toFixed(2));
    if (minimumSampleContrast(tokens, samples, opacity) >= MIN_IMAGE_TEXT_CONTRAST) return opacity;
  }
  throw new Error("当前主题色无法在背景图上达到 4.5:1 对比度，请提高前景与纯色背景的差异");
}

function parseThemeManifest(json: string): ThemePackManifest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("主题 JSON 格式无效");
  }
  const result = validateThemePack(value);
  if (!result.pack) throw new Error(result.errors.slice(0, 2).join("；") || "主题校验失败");
  return result.pack;
}

async function normalizeThemeBackground(bytes: Uint8Array, sourceName: string): Promise<NormalizedThemeBackground> {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("背景图片为空或超过 20 MiB 限制");
  }
  const sourceType = detectImageType(bytes, sourceName);
  const sourceBlob = new Blob([copyToArrayBuffer(bytes)], { type: sourceType });
  const image = await loadImage(sourceBlob);
  if (image.width <= 0 || image.height <= 0) throw new Error("背景图片尺寸无效");
  const scale = Math.min(
    1,
    MAX_BACKGROUND_EDGE / Math.max(image.width, image.height),
    Math.sqrt(MAX_BACKGROUND_PIXELS / (image.width * image.height))
  );
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("当前 WebView 无法处理背景图片");
  context.drawImage(image.element, 0, 0, width, height);
  image.dispose();

  const samples = sampleCanvas(canvas);
  let output = await encodeCanvas(canvas, "image/webp", 0.86);
  let contentType: SaveThemeBackgroundInput["contentType"] = "image/webp";
  if (!output || output.size > MAX_BACKGROUND_BYTES) output = await encodeCanvas(canvas, "image/jpeg", 0.82);
  if (output?.type === "image/jpeg") contentType = "image/jpeg";
  if (!output || output.size > MAX_BACKGROUND_BYTES) {
    throw new Error("背景图片压缩后仍超过 3 MiB，请选择尺寸或细节更低的图片");
  }
  const outputBytes = new Uint8Array(await output.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", outputBytes);
  const hash = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const extension = contentType === "image/webp" ? "webp" : "jpg";
  return {
    writeInput: {
      fileName: `background-${hash}.${extension}`,
      contentType,
      dataBase64: bytesToBase64(outputBytes)
    },
    samples
  };
}

function defaultBackgroundSettings(file: string): ThemeBackgroundImageSettings {
  return {
    file,
    position: { x: 50, y: 50 },
    overlayOpacity: { light: 0.82, dark: 0.86 }
  };
}

function sampleCanvas(source: HTMLCanvasElement): Uint8ClampedArray {
  return sampleImage(source);
}

function sampleImage(source: CanvasImageSource): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_EDGE;
  canvas.height = SAMPLE_EDGE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前 WebView 无法采样背景图片");
  context.drawImage(source, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
  return context.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data;
}

function minimumSampleContrast(tokens: ThemeTokens, samples: Uint8ClampedArray, opacity: number): number {
  const overlay = hslChannelsToRgb(tokens.background);
  const foreground = hslChannelsToRgb(tokens.foreground);
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < samples.length; index += 4) {
    const imageAlpha = samples[index + 3] / 255;
    const image = [samples[index], samples[index + 1], samples[index + 2]] as const;
    const base = image.map((channel, channelIndex) => (
      channel * imageAlpha + overlay[channelIndex] * (1 - imageAlpha)
    ));
    const effective = base.map((channel, channelIndex) => (
      overlay[channelIndex] * opacity + channel * (1 - opacity)
    ));
    minimum = Math.min(minimum, contrastRatio(foreground, effective));
  }
  return minimum;
}

function hslChannelsToRgb(value: string): [number, number, number] {
  const match = /^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/.exec(value);
  if (!match) throw new Error("主题包含无效 HSL 颜色");
  const hue = Number(match[1]);
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const offset = lightness - chroma / 2;
  const rgb = hue < 60 ? [chroma, secondary, 0]
    : hue < 120 ? [secondary, chroma, 0]
      : hue < 180 ? [0, chroma, secondary]
        : hue < 240 ? [0, secondary, chroma]
          : hue < 300 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  return rgb.map((channel) => Math.round((channel + offset) * 255)) as [number, number, number];
}

function contrastRatio(first: readonly number[], second: readonly number[]): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function relativeLuminance(rgb: readonly number[]): number {
  return rgb
    .map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function detectImageType(bytes: Uint8Array, sourceName: string): SaveThemeBackgroundInput["contentType"] {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    .every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 12
    && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  throw new Error(`背景图片 ${sourceName} 仅支持 JPEG、PNG 或 WebP`);
}

function loadImage(blob: Blob): Promise<{ width: number; height: number; element: CanvasImageSource; dispose: () => void }> {
  const bitmap = typeof createImageBitmap === "function"
    ? createImageBitmap(blob, { imageOrientation: "from-image" })
      .then((value) => ({
        width: value.width,
        height: value.height,
        element: value as CanvasImageSource,
        dispose: () => value.close()
      }))
    : Promise.reject(new Error("当前 WebView 不支持 ImageBitmap"));
  return bitmap.catch(() => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
        element: image,
        dispose: () => URL.revokeObjectURL(url)
      });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("背景图片无法解码"));
      };
      image.src = url;
    }));
}

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
}

/** 复制为 Blob 接受的普通 ArrayBuffer，隔离 SharedArrayBuffer 类型。 */
function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
