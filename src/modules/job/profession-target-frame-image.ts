/**
 * @fileoverview 将 V6 图片模型的 Provider 画布正规化为官方帧同尺寸 target PNG；不调用模型、
 * 不访问数据库或对象存储，也不接受任意裁切矩形。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：逐帧模型 Service 从私有对象存储读取官方源 PNG，取得 OpenAiService 返回的模型 PNG
 * 与 ImageTargetGeometry 后调用本模块；输出字节随后进入 Artifact/ImageAttempt 原子持久化。
 * 副作用仅为内存图片解码、统一缩放和 PNG 编码。
 * 安全边界：Provider 离散画布只消费与官方帧同宽高比的居中矩形，矩形外像素不会进入输出；
 * 最终 Alpha 逐字节取自官方源，透明像素 RGB 清零。任一尺寸、Alpha 摘要或可见内容不变量失败关闭。
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ImageTargetGeometry } from "../openai/image-target-geometry.js";

const maximumImageBytes = 64 * 1024 * 1024;
const maximumPixels = 16 * 1024 * 1024;
const sha256Pattern = /^[A-F0-9]{64}$/u;

/** 逐帧正规化输入；source PNG 必须来自同一 target manifest 绑定的官方帧。 */
export interface NormalizeProfessionTargetFrameInput {
  sourcePng: Uint8Array;
  providerPng: Uint8Array;
  sourceAlphaSha256: string;
  geometry: ImageTargetGeometry;
}

/** 可写入逐帧执行证据的最终同尺寸 PNG 与无拉伸证明。 */
export interface NormalizedProfessionTargetFrame {
  bytes: Uint8Array;
  width: number;
  height: number;
  sha256: string;
  alphaSha256: string;
  geometry: ImageTargetGeometry;
  algorithm: "centered-exact-aspect-lanczos3-source-alpha-v1";
}

/** 模型画布、官方 Alpha 或正规化结果不满足 V6 硬条件时的稳定内部错误。 */
export class ProfessionTargetFrameImageError extends Error {
  readonly code = "PROFESSION_TARGET_FRAME_IMAGE_INVALID";

  constructor() {
    super("PROFESSION_TARGET_FRAME_IMAGE_INVALID");
    this.name = "ProfessionTargetFrameImageError";
  }
}

/**
 * 生成与官方帧像素尺寸完全相同的 target PNG。
 * @param input 已绑定的官方 PNG、模型 PNG、Alpha 摘要与服务端计算几何。
 * @returns 最终 PNG、完整摘要、Alpha 摘要和正规化算法证据；不证明视觉质量或客户端兼容。
 * @throws ProfessionTargetFrameImageError 当任何图片、几何、透明边界或 Alpha 不变量失败。
 */
export async function normalizeProfessionTargetFrame(
  input: NormalizeProfessionTargetFrameInput,
): Promise<NormalizedProfessionTargetFrame> {
  try {
    if (
      input.sourcePng.byteLength <= 0 ||
      input.sourcePng.byteLength > maximumImageBytes ||
      input.providerPng.byteLength <= 0 ||
      input.providerPng.byteLength > maximumImageBytes ||
      !sha256Pattern.test(input.sourceAlphaSha256)
    ) {
      throw new Error("TARGET_FRAME_INPUT_INVALID");
    }
    const source = await decodeRgba(input.sourcePng);
    const provider = await decodeRgba(input.providerPng);
    const geometry = input.geometry;
    if (
      source.width !== geometry.target.width ||
      source.height !== geometry.target.height ||
      provider.width !== geometry.providerCanvas.width ||
      provider.height !== geometry.providerCanvas.height ||
      alphaSha256(source.data) !== input.sourceAlphaSha256
    ) {
      throw new Error("TARGET_FRAME_IDENTITY_INVALID");
    }
    // Provider 只能返回离散画布，可能不遵循透明留白 Prompt；矩形外区域被确定性丢弃，
    // 矩形本身已由几何模块证明与官方帧同宽高比，因此不会发生非等比拉伸。
    const resized = await sharp(provider.data, {
      raw: { width: provider.width, height: provider.height, channels: 4 },
    })
      .extract(geometry.contentRect)
      .resize(geometry.target.width, geometry.target.height, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      resized.info.channels !== 4 ||
      resized.info.width !== source.width ||
      resized.info.height !== source.height
    ) {
      throw new Error("TARGET_FRAME_RESIZE_INVALID");
    }

    let visibleSourcePixels = 0;
    let visibleRgbPixels = 0;
    for (let offset = 0; offset < resized.data.length; offset += 4) {
      const sourceAlpha = source.data[offset + 3] ?? 0;
      resized.data[offset + 3] = sourceAlpha;
      if (sourceAlpha === 0) {
        resized.data[offset] = 0;
        resized.data[offset + 1] = 0;
        resized.data[offset + 2] = 0;
        continue;
      }
      visibleSourcePixels += 1;
      if (
        resized.data[offset] !== 0 ||
        resized.data[offset + 1] !== 0 ||
        resized.data[offset + 2] !== 0
      ) {
        visibleRgbPixels += 1;
      }
    }
    if (visibleSourcePixels === 0 || visibleRgbPixels === 0) {
      throw new Error("TARGET_FRAME_VISIBLE_RGB_REQUIRED");
    }
    const bytes = await sharp(resized.data, {
      raw: {
        width: source.width,
        height: source.height,
        channels: 4,
      },
    })
      .png({ adaptiveFiltering: true, compressionLevel: 9, palette: false })
      .toBuffer();
    if (bytes.byteLength > maximumImageBytes) {
      throw new Error("TARGET_FRAME_OUTPUT_TOO_LARGE");
    }
    const alphaSha256Value = alphaSha256(resized.data);
    if (alphaSha256Value !== input.sourceAlphaSha256) {
      throw new Error("TARGET_FRAME_ALPHA_CHANGED");
    }
    return {
      bytes,
      width: source.width,
      height: source.height,
      sha256: sha256(bytes),
      alphaSha256: alphaSha256Value,
      geometry,
      algorithm: "centered-exact-aspect-lanczos3-source-alpha-v1",
    };
  } catch (error) {
    if (error instanceof ProfessionTargetFrameImageError) throw error;
    throw new ProfessionTargetFrameImageError();
  }
}

async function decodeRgba(bytes: Uint8Array): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  const decoded = await sharp(Buffer.from(bytes), {
    failOn: "warning",
    limitInputPixels: maximumPixels,
    sequentialRead: true,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    decoded.info.channels !== 4 ||
    decoded.info.width <= 0 ||
    decoded.info.height <= 0
  ) {
    throw new Error("TARGET_FRAME_RGBA_REQUIRED");
  }
  return {
    data: decoded.data,
    width: decoded.info.width,
    height: decoded.info.height,
  };
}

function alphaSha256(bytes: Uint8Array): string {
  const alpha = Buffer.allocUnsafe(bytes.byteLength / 4);
  for (
    let sourceOffset = 3, targetOffset = 0;
    sourceOffset < bytes.byteLength;
    sourceOffset += 4, targetOffset += 1
  ) {
    alpha[targetOffset] = bytes[sourceOffset] ?? 0;
  }
  return sha256(alpha);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}
