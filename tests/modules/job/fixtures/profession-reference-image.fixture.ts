/** @fileoverview 为 Profession 参考图门禁测试生成小型、真实可解码的固定 PNG。 */
import sharp from "sharp";

const width = 512;
const height = 512;

export async function createTransparentReferencePng(
  hiddenRgb: readonly [number, number, number] = [0, 0, 0],
): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    pixels[offset] = hiddenRgb[0];
    pixels[offset + 1] = hiddenRgb[1];
    pixels[offset + 2] = hiddenRgb[2];
  }
  for (let y = 96; y < 416; y += 1) {
    for (let x = 96; x < 416; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 40;
      pixels[offset + 1] = 170;
      pixels[offset + 2] = 245;
      pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

export async function createOpaqueEffectCanvasPng(): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3, 24);
  for (let y = 120; y < 392; y += 1) {
    for (let x = 72; x < 440; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 28;
      pixels[offset + 1] = 55;
      pixels[offset + 2] = 65;
    }
  }
  for (let y = 128; y < 384; y += 1) {
    for (let x = 80; x < 432; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 35;
      pixels[offset + 1] = 180;
      pixels[offset + 2] = 245;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

export async function createSparseAlphaEffectCanvasPng(): Promise<Buffer> {
  const opaque = await createOpaqueEffectCanvasPng();
  const decoded = await sharp(opaque).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  decoded.data[3] = 254;
  return sharp(decoded.data, {
    raw: {
      width: decoded.info.width,
      height: decoded.info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

export async function createBrightGradientEffectCanvasPng(): Promise<Buffer> {
  const pixels = createBrightGradientPixels();
  for (let y = 128; y < 384; y += 1) {
    for (let x = 80; x < 432; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 24;
      pixels[offset + 1] = 116;
      pixels[offset + 2] = 242;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

export async function createFlatBrightGradientPng(): Promise<Buffer> {
  return sharp(createBrightGradientPixels(), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
}

export async function createCheckerboardEffectCanvasPng(): Promise<Buffer> {
  const pixels = createCheckerboardPixels();
  for (let y = 112; y < 400; y += 1) {
    for (let x = 64; x < 448; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 18;
      pixels[offset + 1] = 116;
      pixels[offset + 2] = 248;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

export async function createFlatCheckerboardPng(): Promise<Buffer> {
  return sharp(createCheckerboardPixels(), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
}

function createCheckerboardPixels(): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const value = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 ? 176 : 224;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
    }
  }
  return pixels;
}

function createBrightGradientPixels(): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 172 + Math.round((x / (width - 1)) * 42);
      pixels[offset + 1] = 184 + Math.round((y / (height - 1)) * 36);
      pixels[offset + 2] =
        196 +
        Math.round((x / (width - 1)) * 18) +
        Math.round((y / (height - 1)) * 12);
    }
  }
  return pixels;
}

export async function createFlatOpaquePng(): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 24, g: 24, b: 24 },
    },
  })
    .png()
    .toBuffer();
}
