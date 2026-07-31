/**
 * @fileoverview 验证 V6 Provider 画布只能等比正规化为官方同尺寸 target，并逐字节保留官方 Alpha。
 * 测试使用 Sharp 内存图片替代外部模型，不证明 Provider 会遵守透明 padding Prompt。
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  createImageTargetGeometry,
  ImageTargetGeometryError,
  selectRequestedImageCanvas,
} from "../../../src/modules/openai/image-target-geometry.js";
import {
  normalizeProfessionTargetFrame,
  ProfessionTargetFrameImageError,
} from "../../../src/modules/job/profession-target-frame-image.js";

describe("V6 profession target frame geometry", () => {
  it.each([
    [{ width: 4, height: 3 }, "1536x1024", "3:2"],
    [{ width: 3, height: 4 }, "1024x1536", "2:3"],
    [{ width: 7, height: 7 }, "1024x1024", "1:1"],
  ] as const)(
    "selects an orientation canvas for %o",
    (target, openAiSize, geminiAspectRatio) => {
      const requested = selectRequestedImageCanvas(target);
      const geometry = createImageTargetGeometry(target, requested, {
        width: requested.expectedWidth,
        height: requested.expectedHeight,
      });

      expect(requested).toMatchObject({ openAiSize, geminiAspectRatio });
      expect(geometry.contentRect.width * target.height).toBe(
        geometry.contentRect.height * target.width,
      );
      expect(geometry.algorithm).toBe("centered-exact-aspect-uniform-scale-v1");
    },
  );

  it("rejects an aspect ratio that cannot form one exact unit in the Provider canvas", () => {
    expect(() =>
      selectRequestedImageCanvas({ width: 2_000, height: 1 }),
    ).toThrow(ImageTargetGeometryError);
  });
});

describe("normalizeProfessionTargetFrame", () => {
  it("produces exact source dimensions and source Alpha without non-uniform stretching", async () => {
    const target = { width: 4, height: 3 };
    const requested = selectRequestedImageCanvas(target);
    const geometry = createImageTargetGeometry(target, requested, {
      width: 12,
      height: 8,
    });
    const sourceRgba = Buffer.from([
      1, 2, 3, 0, 1, 2, 3, 64, 1, 2, 3, 128, 1, 2, 3, 255, 1, 2, 3, 255, 1, 2,
      3, 128, 1, 2, 3, 64, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 255, 1, 2, 3, 255,
      1, 2, 3, 0,
    ]);
    const providerRgba = Buffer.alloc(12 * 8 * 4);
    for (let y = 0; y < geometry.contentRect.height; y += 1) {
      for (let x = 0; x < geometry.contentRect.width; x += 1) {
        const offset =
          ((geometry.contentRect.top + y) * 12 +
            geometry.contentRect.left +
            x) *
          4;
        providerRgba[offset] = 20 + x;
        providerRgba[offset + 1] = 80 + y;
        providerRgba[offset + 2] = 160;
        providerRgba[offset + 3] = 255;
      }
    }
    const sourcePng = await rawPng(sourceRgba, 4, 3);
    const providerPng = await rawPng(providerRgba, 12, 8);
    const expectedAlphaSha256 = alphaSha256(sourceRgba);

    const result = await normalizeProfessionTargetFrame({
      sourcePng,
      providerPng,
      sourceAlphaSha256: expectedAlphaSha256,
      geometry,
    });

    expect(result).toMatchObject({
      width: 4,
      height: 3,
      alphaSha256: expectedAlphaSha256,
      algorithm: "centered-exact-aspect-lanczos3-source-alpha-v1",
    });
    const decoded = await sharp(result.bytes).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    expect(decoded.info).toMatchObject({ width: 4, height: 3, channels: 4 });
    expect(alphaSha256(decoded.data)).toBe(expectedAlphaSha256);
    expect(decoded.data.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 0]));
  });

  it("rejects visible model pixels outside the exact-aspect content rectangle", async () => {
    const target = { width: 4, height: 3 };
    const requested = selectRequestedImageCanvas(target);
    const geometry = createImageTargetGeometry(target, requested, {
      width: 12,
      height: 8,
    });
    const sourceRgba = Buffer.alloc(4 * 3 * 4, 255);
    const providerRgba = Buffer.alloc(12 * 8 * 4);
    providerRgba[3] = 255;

    await expect(
      normalizeProfessionTargetFrame({
        sourcePng: await rawPng(sourceRgba, 4, 3),
        providerPng: await rawPng(providerRgba, 12, 8),
        sourceAlphaSha256: alphaSha256(sourceRgba),
        geometry,
      }),
    ).rejects.toBeInstanceOf(ProfessionTargetFrameImageError);
  });

  it("rejects a source Alpha digest that is not bound to the official frame", async () => {
    const target = { width: 1, height: 1 };
    const requested = selectRequestedImageCanvas(target);
    const geometry = createImageTargetGeometry(target, requested, {
      width: 1,
      height: 1,
    });

    await expect(
      normalizeProfessionTargetFrame({
        sourcePng: await rawPng(Buffer.from([1, 2, 3, 255]), 1, 1),
        providerPng: await rawPng(Buffer.from([4, 5, 6, 255]), 1, 1),
        sourceAlphaSha256: "A".repeat(64),
        geometry,
      }),
    ).rejects.toBeInstanceOf(ProfessionTargetFrameImageError);
  });
});

function rawPng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(Buffer.from(rgba), {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

function alphaSha256(rgba: Uint8Array): string {
  const alpha = Buffer.alloc(rgba.byteLength / 4);
  for (
    let sourceOffset = 3, targetOffset = 0;
    sourceOffset < rgba.byteLength;
    sourceOffset += 4, targetOffset += 1
  ) {
    alpha[targetOffset] = rgba[sourceOffset] ?? 0;
  }
  return createHash("sha256").update(alpha).digest("hex").toUpperCase();
}
