/** @fileoverview 验证 Artist PNG 的 Alpha 规范化、透明 RGB 清理和失败关闭语义。 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizeProfessionReferenceImage } from "../../../src/modules/job/profession-reference-image.js";
import {
  createBrightGradientEffectCanvasPng,
  createCheckerboardEffectCanvasPng,
  createFlatBrightGradientPng,
  createFlatCheckerboardPng,
  createFlatOpaquePng,
  createOpaqueEffectCanvasPng,
  createSparseAlphaEffectCanvasPng,
  createTransparentReferencePng,
} from "./fixtures/profession-reference-image.fixture.js";

describe("normalizeProfessionReferenceImage", () => {
  it("preserves a compliant native-alpha PNG byte-for-byte", async () => {
    const input = await createTransparentReferencePng();

    const result = await normalizeProfessionReferenceImage(input);

    expect(result).toEqual({
      status: "accepted",
      bytes: input,
      mode: "native-alpha-v3",
    });
  });

  it("clears hidden RGB while preserving a native Alpha silhouette", async () => {
    const input = await createTransparentReferencePng([9, 17, 31]);

    const result = await normalizeProfessionReferenceImage(input);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("TEST_IMAGE_REQUIRED");
    expect(result.mode).toBe("native-alpha-v3");
    expect(result.bytes).not.toEqual(input);
    const statistics = await alphaStatistics(result.bytes);
    expect(statistics.visiblePixels).toBeGreaterThan(0);
    expect(statistics.transparentPixels).toBeGreaterThan(0);
    expect(statistics.transparentRgbNonzero).toBe(0);
  });

  it("derives soft Alpha from an opaque high-contrast effect canvas", async () => {
    const input = await createOpaqueEffectCanvasPng();

    const result = await normalizeProfessionReferenceImage(input);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("TEST_IMAGE_REQUIRED");
    expect(result.mode).toBe("dark-derived-alpha-v3");
    const statistics = await alphaStatistics(result.bytes);
    expect(statistics.visiblePixels).toBeGreaterThan(0);
    expect(statistics.transparentPixels).toBeGreaterThan(0);
    expect(statistics.partialPixels).toBeGreaterThan(0);
    expect(statistics.transparentBorderRatio).toBe(1);
    expect(statistics.transparentRgbNonzero).toBe(0);
  });

  it("derives Alpha when an opaque effect canvas contains sparse incidental Alpha", async () => {
    const input = await createSparseAlphaEffectCanvasPng();

    const result = await normalizeProfessionReferenceImage(input);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("TEST_IMAGE_REQUIRED");
    expect(result.mode).toBe("dark-derived-alpha-v3");
    const statistics = await alphaStatistics(result.bytes);
    expect(statistics.transparentBorderRatio).toBe(1);
    expect(statistics.transparentPixels).toBeGreaterThan(0);
    expect(statistics.partialPixels).toBeGreaterThan(0);
  });

  it("derives Alpha from an effect on a bright gradient canvas", async () => {
    const input = await createBrightGradientEffectCanvasPng();

    const result = await normalizeProfessionReferenceImage(input);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("TEST_IMAGE_REQUIRED");
    expect(result.mode).toBe("border-derived-alpha-v3");
    const statistics = await alphaStatistics(result.bytes);
    expect(statistics.transparentBorderRatio).toBe(1);
    expect(statistics.transparentPixels).toBeGreaterThan(0);
    expect(statistics.visiblePixels).toBeGreaterThan(0);
  });

  it("rejects a bright gradient canvas without a separable effect", async () => {
    await expect(
      normalizeProfessionReferenceImage(await createFlatBrightGradientPng()),
    ).resolves.toEqual({ status: "transparency-invalid" });
  });

  it("derives Alpha from an effect on a bright checkerboard canvas", async () => {
    const input = await createCheckerboardEffectCanvasPng();

    const result = await normalizeProfessionReferenceImage(input);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("TEST_IMAGE_REQUIRED");
    expect(result.mode).toBe("neutral-palette-derived-alpha-v4");
    const statistics = await alphaStatistics(result.bytes);
    expect(statistics.transparentBorderRatio).toBe(1);
    expect(statistics.transparentPixels).toBeGreaterThan(0);
    expect(statistics.visiblePixels).toBeGreaterThan(0);
  });

  it("rejects a bright checkerboard canvas without a separable effect", async () => {
    await expect(
      normalizeProfessionReferenceImage(await createFlatCheckerboardPng()),
    ).resolves.toEqual({ status: "transparency-invalid" });
  });

  it("rejects an opaque flat canvas that has no separable effect", async () => {
    await expect(
      normalizeProfessionReferenceImage(await createFlatOpaquePng()),
    ).resolves.toEqual({ status: "transparency-invalid" });
  });

  it("rejects a signature-only PNG that cannot be decoded", async () => {
    await expect(
      normalizeProfessionReferenceImage(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      ),
    ).resolves.toEqual({ status: "invalid-png" });
  });
});

async function alphaStatistics(bytes: Uint8Array): Promise<{
  visiblePixels: number;
  transparentPixels: number;
  partialPixels: number;
  transparentRgbNonzero: number;
  transparentBorderRatio: number;
}> {
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  let visiblePixels = 0;
  let transparentPixels = 0;
  let partialPixels = 0;
  let transparentRgbNonzero = 0;
  let borderPixels = 0;
  let transparentBorderPixels = 0;
  for (
    let index = 0;
    index < decoded.info.width * decoded.info.height;
    index += 1
  ) {
    const offset = index * 4;
    const alpha = decoded.data[offset + 3] ?? 0;
    const x = index % decoded.info.width;
    const y = Math.floor(index / decoded.info.width);
    const border =
      x === 0 ||
      y === 0 ||
      x === decoded.info.width - 1 ||
      y === decoded.info.height - 1;
    if (border) {
      borderPixels += 1;
      if (alpha === 0) transparentBorderPixels += 1;
    }
    if (alpha === 0) {
      transparentPixels += 1;
      if (
        decoded.data[offset] !== 0 ||
        decoded.data[offset + 1] !== 0 ||
        decoded.data[offset + 2] !== 0
      ) {
        transparentRgbNonzero += 1;
      }
    } else {
      visiblePixels += 1;
      if (alpha < 255) partialPixels += 1;
    }
  }
  return {
    visiblePixels,
    transparentPixels,
    partialPixels,
    transparentRgbNonzero,
    transparentBorderRatio: transparentBorderPixels / borderPixels,
  };
}
