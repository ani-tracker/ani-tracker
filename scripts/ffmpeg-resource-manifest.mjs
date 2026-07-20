export const FFMPEG_RELEASE = "b6.1.1";

export const FFMPEG_ASSETS = {
  "darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    binaryName: "ffmpeg",
    binarySize: 45_568_216,
    binarySha256: "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
    archiveSha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
    licenseSha256: "cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2",
    readmeSha256: "05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a"
  },
  "darwin-x64": {
    platform: "darwin",
    arch: "x64",
    binaryName: "ffmpeg",
    binarySize: 78_862_176,
    binarySha256: "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894",
    archiveSha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
    licenseSha256: "2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af",
    readmeSha256: "e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36"
  },
  "win32-x64": {
    platform: "win32",
    arch: "x64",
    binaryName: "ffmpeg.exe",
    binarySize: 82_797_568,
    binarySha256: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
    archiveSha256: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
    licenseSha256: "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
    readmeSha256: "a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311"
  }
};

/** 返回指定平台和架构的 FFmpeg 资源清单。 */
export function findFfmpegAsset(platform, arch) {
  const targetKey = `${platform}-${arch}`;
  const asset = FFMPEG_ASSETS[targetKey];
  return asset ? { targetKey, ...asset } : undefined;
}
