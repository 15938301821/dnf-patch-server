/**
 * @fileoverview 复读 Worker 从官方 BGRA 导出的单帧 PNG，并验证尺寸与 Alpha 身份；不调用模型、
 * 不访问数据库或对象存储，也不生成目标图片。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - V6 逐帧模型输入冻结
 *
 * 调用关系：ProfessionTargetFrameSourceService 从私有对象存储取得 finalized PNG 后调用本模块，
 * 校验通过才允许 Repository 把 Artifact 绑定到 prepared target 行。输入是未信任 PNG 字节和数据库
 * 冻结的宽高/Alpha 摘要，输出只含复读后的身份，不保存图片正文。
 * 副作用仅为内存解码和 SHA-256 计算。安全边界：PNG 格式、精确宽高、像素预算和逐像素 Alpha
 * 任一漂移都必须失败关闭；Artifact 摘要正确不能替代本次像素复读。
 */
import { createHash } from "node:crypto";
import sharp from "sharp";

const maximumPixels = 16 * 1024 * 1024;
const sha256Pattern = /^[A-F0-9]{64}$/u;

/** 数据库 target 行提供的官方 PNG 预期身份。 */
export interface ProfessionTargetFrameSourceImageExpectation {
  width: number;
  height: number;
  sourceAlphaSha256: string;
}

/** PNG 正文复读成功后的有限像素身份。 */
export interface VerifiedProfessionTargetFrameSourceImage {
  width: number;
  height: number;
  alphaSha256: string;
}

/** 官方源帧 PNG 格式、尺寸或 Alpha 与 prepared target 不一致时的稳定错误。 */
export class ProfessionTargetFrameSourceImageError extends Error {
  readonly code = "PROFESSION_TARGET_FRAME_SOURCE_IMAGE_INVALID";

  constructor() {
    super("PROFESSION_TARGET_FRAME_SOURCE_IMAGE_INVALID");
    this.name = "ProfessionTargetFrameSourceImageError";
  }
}

/**
 * 解码并复核单帧官方源 PNG。
 * @param bytes Server 已按 Artifact 长度和 SHA-256 读取的未信任对象正文。
 * @param expected prepared target 行冻结的精确宽高与官方 Alpha 摘要。
 * @returns 真实解码宽高与 Alpha 摘要；不返回或持久化像素正文。
 * @throws ProfessionTargetFrameSourceImageError 当格式、预算、尺寸或 Alpha 任一不一致。
 */
export async function verifyProfessionTargetFrameSourceImage(
  bytes: Uint8Array,
  expected: ProfessionTargetFrameSourceImageExpectation,
): Promise<VerifiedProfessionTargetFrameSourceImage> {
  try {
    if (
      !Number.isSafeInteger(expected.width) ||
      !Number.isSafeInteger(expected.height) ||
      expected.width <= 0 ||
      expected.height <= 0 ||
      expected.width * expected.height > maximumPixels ||
      !sha256Pattern.test(expected.sourceAlphaSha256)
    ) {
      throw new Error("SOURCE_IMAGE_EXPECTATION_INVALID");
    }
    const decoded = await sharp(Buffer.from(bytes), {
      failOn: "warning",
      limitInputPixels: maximumPixels,
      sequentialRead: true,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      decoded.info.format !== "raw" ||
      decoded.info.channels !== 4 ||
      decoded.info.width !== expected.width ||
      decoded.info.height !== expected.height
    ) {
      throw new Error("SOURCE_IMAGE_GEOMETRY_INVALID");
    }
    const alpha = Buffer.allocUnsafe(decoded.data.byteLength / 4);
    for (
      let sourceOffset = 3, targetOffset = 0;
      sourceOffset < decoded.data.byteLength;
      sourceOffset += 4, targetOffset += 1
    ) {
      alpha[targetOffset] = decoded.data[sourceOffset] ?? 0;
    }
    const alphaSha256 = createHash("sha256")
      .update(alpha)
      .digest("hex")
      .toUpperCase();
    if (alphaSha256 !== expected.sourceAlphaSha256) {
      throw new Error("SOURCE_IMAGE_ALPHA_INVALID");
    }
    return { width: expected.width, height: expected.height, alphaSha256 };
  } catch (error) {
    if (error instanceof ProfessionTargetFrameSourceImageError) throw error;
    throw new ProfessionTargetFrameSourceImageError();
  }
}
