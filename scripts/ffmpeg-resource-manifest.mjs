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
    readmeSha256: "05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a",
    ffprobe: {
      packageName: "@ffprobe-installer/darwin-arm64",
      packageVersion: "5.0.1",
      buildVersion: "4.4.1",
      homepage: "https://formulae.brew.sh/formula/ffmpeg",
      license: "LGPL-2.1-only",
      licenseFile: "LGPL-2.1-only.json",
      licenseSha256: "c0d69112ef0885bc9c16c7ffaa8f5ca9763a330a4e71ff0c7eb00ffa9a9c3b74",
      binaryName: "ffprobe",
      binarySize: 18_187_448,
      binarySha256: "c846d5db9d3b5bc33f987725e21f3ea14953931221c191575918e907ad6c18ff",
      archiveSha256: "27069fc32879761968823c3ce5353d3c6573f5df7d83d40b60bc2d878e886d39"
    }
  },
  "darwin-x64": {
    platform: "darwin",
    arch: "x64",
    binaryName: "ffmpeg",
    binarySize: 78_862_176,
    binarySha256: "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894",
    archiveSha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
    licenseSha256: "2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af",
    readmeSha256: "e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36",
    ffprobe: {
      packageName: "@ffprobe-installer/darwin-x64",
      packageVersion: "5.1.0",
      buildVersion: "20230213-f8d6d0f",
      homepage: "https://evermeet.cx/ffmpeg/",
      license: "GPL-3.0-only",
      licenseFile: "GPL-3.0-only.json",
      licenseSha256: "8924751994c3bcb0ee2f9770a6ee542549847eeac8f9bb123d0dd1c222288dd2",
      binaryName: "ffprobe",
      binarySize: 78_740_780,
      binarySha256: "424ce5e9271085240e90bd27f9e3f0ce280d388ea4379a211f76b64fcc07ce33",
      archiveSha256: "efe50b1fc86deb59a0263013a3f2c08ad5771ad1258a436e117e44b75ec8bd47"
    }
  },
  "win32-x64": {
    platform: "win32",
    arch: "x64",
    binaryName: "ffmpeg.exe",
    binarySize: 82_797_568,
    binarySha256: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
    archiveSha256: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
    licenseSha256: "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
    readmeSha256: "a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311",
    ffprobe: {
      packageName: "@ffprobe-installer/win32-x64",
      packageVersion: "5.1.0",
      buildVersion: "20230213-2296078",
      homepage: "https://www.gyan.dev/ffmpeg/builds/",
      license: "GPL-3.0-only",
      licenseFile: "GPL-3.0-only.json",
      licenseSha256: "8924751994c3bcb0ee2f9770a6ee542549847eeac8f9bb123d0dd1c222288dd2",
      binaryName: "ffprobe.exe",
      binarySize: 80_995_328,
      binarySha256: "f28c4751e7367205267025aaf0fcfc921e34d9b7edaa46bd9c8abaf367fc9051",
      archiveSha256: "97992b5e3b651c7df625831fd369eecc5ec0e9532ac98921138b1c4fbc8de96e"
    }
  }
};

/** 返回指定平台和架构的 FFmpeg 资源清单。 */
export function findFfmpegAsset(platform, arch) {
  const targetKey = `${platform}-${arch}`;
  const asset = FFMPEG_ASSETS[targetKey];
  return asset ? { targetKey, ...asset } : undefined;
}
