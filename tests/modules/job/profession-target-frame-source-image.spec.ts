/**
 * @fileoverview 验证官方逐帧 PNG 只在真实尺寸和逐像素 Alpha 与 prepared target 一致时通过；
 * 不访问数据库、对象存储或模型 Provider。
 * @module modules/job/profession-target-frame-source-image-spec
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - V6 逐帧模型输入冻结
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  ProfessionTargetFrameSourceImageError,
  verifyProfessionTargetFrameSourceImage,
} from "../../../src/modules/job/profession-target-frame-source-image.js";

describe("verifyProfessionTargetFrameSourceImage", () => {
  it("接受精确同尺寸且 Alpha 摘要一致的官方 PNG", async () => {
    const alpha = Buffer.from([0, 64, 128, 255, 255, 128]);
    const bytes = await sourcePng(3, 2, alpha);

    await expect(
      verifyProfessionTargetFrameSourceImage(bytes, {
        width: 3,
        height: 2,
        sourceAlphaSha256: sha256(alpha),
      }),
    ).resolves.toEqual({
      width: 3,
      height: 2,
      alphaSha256: sha256(alpha),
    });
  });

  it("拒绝同尺寸但 Alpha 与官方摘要漂移的 PNG", async () => {
    const bytes = await sourcePng(2, 2, Buffer.from([0, 32, 64, 255]));

    await expect(
      verifyProfessionTargetFrameSourceImage(bytes, {
        width: 2,
        height: 2,
        sourceAlphaSha256: "A".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ProfessionTargetFrameSourceImageError);
  });
});

async function sourcePng(
  width: number,
  height: number,
  alpha: Uint8Array,
): Promise<Buffer> {
  const rgba = Buffer.alloc(width * height * 4, 0);
  for (let index = 0; index < alpha.byteLength; index += 1) {
    rgba[index * 4] = 20;
    rgba[index * 4 + 1] = 40;
    rgba[index * 4 + 2] = 60;
    rgba[index * 4 + 3] = alpha[index] ?? 0;
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}
