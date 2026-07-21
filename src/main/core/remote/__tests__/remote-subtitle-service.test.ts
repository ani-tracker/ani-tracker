import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  resolveBundledFfmpegBinary,
  resolveBundledFfprobeBinary
} from "../../media/ffmpeg-binary-resolver";
import { prepareRemoteSubtitles } from "../remote-subtitle-service";

const execFileAsync = promisify(execFile);
const ffprobePath = resolveBundledFfprobeBinary();
const ffmpegPath = resolveBundledFfmpegBinary() ?? (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

test("prepareRemoteSubtitles 提取 ASS 并将 SRT 转换为 WebVTT", async (context) => {
  if (!ffprobePath || !(await isCommandAvailable(ffmpegPath))) {
    context.skip("当前平台没有内置 FFmpeg 或 FFprobe");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "ani-remote-subtitle-test-"));
  const outputDirectory = join(directory, "output");
  const assPath = join(directory, "subtitle.ass");
  const srtPath = join(directory, "subtitle.srt");
  const mediaPath = join(directory, "episode.mkv");
  await mkdir(outputDirectory);
  await writeFile(assPath, createAssSubtitle(), "utf8");
  await writeFile(srtPath, "1\n00:00:00,000 --> 00:00:00,800\nHello\n", "utf8");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await execFileAsync(ffmpegPath, [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "color=c=black:s=320x180:r=24:d=1",
    "-i", assPath,
    "-i", srtPath,
    "-map", "0:v:0",
    "-map", "1:0",
    "-map", "2:0",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:s:0", "ass",
    "-c:s:1", "srt",
    "-metadata:s:s:0", "language=chi",
    "-metadata:s:s:0", "title=简体中文",
    "-disposition:s:0", "default",
    "-metadata:s:s:1", "language=eng",
    "-metadata:s:s:1", "title=English",
    "-disposition:s:1", "0",
    "-t", "1",
    "-y",
    mediaPath
  ], { timeout: 30_000, windowsHide: true });

  const result = await prepareRemoteSubtitles(mediaPath, outputDirectory, {
    ffprobePaths: [ffprobePath],
    ffmpegPath,
    timeoutMs: 30_000
  });

  assert.equal(result.detectedCount, 2);
  assert.equal(result.unsupportedCount, 0);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.subtitles.map((subtitle) => ({
    label: subtitle.label,
    type: subtitle.type,
    default: subtitle.default
  })), [
    { label: "简体中文", type: "ass", default: true },
    { label: "English / 英语", type: "vtt", default: false }
  ]);
  assert.match(await readFile(join(outputDirectory, "subtitle-000.ass"), "utf8"), /Dialogue:/);
  assert.match(await readFile(join(outputDirectory, "subtitle-001.vtt"), "utf8"), /^WEBVTT/);
});

/** 创建 FFmpeg 可解析的最小 ASS 字幕。 */
function createAssSubtitle(): string {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:00.00,0:00:00.80,Default,,0,0,0,,你好"
  ].join("\n");
}

/** 检查测试环境是否存在可执行命令。 */
async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["-version"], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
