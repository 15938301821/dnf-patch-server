/**
 * @fileoverview 为固定图片 Provider 选择离散画布，并在实际返回画布内计算与官方帧完全同宽高比的
 * 居中内容矩形；不调用模型、不解码图片，也不执行缩放。
 * @module modules/openai
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：OpenAiService 在 V6 图片出站前选择固定 OpenAI/Gemini 配置，Provider 返回实际画布后
 * 再调用本模块冻结正规化几何；Profession target 正规化器消费该几何。输入输出都是有界整数，
 * 无网络、数据库或对象存储副作用。
 * 安全边界：内容矩形宽高比必须与 target 约分后完全一致；只能使用统一比例缩放。极端宽高比
 * 无法在 Provider 画布中形成至少一个约分单位时失败关闭，不能退化为非等比拉伸。
 */

export type OpenAiImageSize = "1024x1024" | "1536x1024" | "1024x1536";
export type GeminiImageAspectRatio = "1:1" | "3:2" | "2:3";

/** V6 最终 target 的官方像素尺寸；不是 Provider 原始画布尺寸。 */
export interface ImageTargetDimensions {
  width: number;
  height: number;
}

/** 模型出站前可确定的离散 Provider 配置。 */
export interface RequestedImageCanvas {
  openAiSize: OpenAiImageSize;
  geminiAspectRatio: GeminiImageAspectRatio;
  expectedWidth: number;
  expectedHeight: number;
}

/** V5 未声明逐帧 target 时的历史 Provider 配置；不得用于证明最终图片与官方帧同尺寸。 */
export const legacyRequestedImageCanvas: Readonly<RequestedImageCanvas> =
  Object.freeze({
    openAiSize: "1536x1024",
    geminiAspectRatio: "3:2",
    expectedWidth: 1536,
    expectedHeight: 1024,
  });

/** Provider 返回后冻结的无拉伸正规化几何证据。 */
export interface ImageTargetGeometry {
  schemaVersion: 1;
  target: ImageTargetDimensions;
  requestedCanvas: RequestedImageCanvas;
  providerCanvas: { width: number; height: number };
  contentRect: { left: number; top: number; width: number; height: number };
  uniformScale: { numerator: number; denominator: number };
  algorithm: "centered-exact-aspect-uniform-scale-v1";
}

/** 目标尺寸或实际画布无法证明统一缩放时使用的稳定内部错误。 */
export class ImageTargetGeometryError extends Error {
  readonly code = "IMAGE_TARGET_GEOMETRY_INVALID";

  constructor() {
    super("IMAGE_TARGET_GEOMETRY_INVALID");
    this.name = "ImageTargetGeometryError";
  }
}

/**
 * 按 target 朝向选择固定 Provider 请求画布。
 * @param target 来自已验证 target-frame manifest 的正整数宽高。
 * @returns OpenAI 离散 size、Gemini 离散宽高比及用于审计的预期像素画布。
 * @throws ImageTargetGeometryError 当尺寸越界或宽高比无法在所选画布中精确表达。
 */
export function selectRequestedImageCanvas(
  target: ImageTargetDimensions,
): RequestedImageCanvas {
  assertDimensions(target);
  const requested =
    target.width === target.height
      ? {
          openAiSize: "1024x1024" as const,
          geminiAspectRatio: "1:1" as const,
          expectedWidth: 1024,
          expectedHeight: 1024,
        }
      : target.width > target.height
        ? {
            openAiSize: "1536x1024" as const,
            geminiAspectRatio: "3:2" as const,
            expectedWidth: 1536,
            expectedHeight: 1024,
          }
        : {
            openAiSize: "1024x1536" as const,
            geminiAspectRatio: "2:3" as const,
            expectedWidth: 1024,
            expectedHeight: 1536,
          };
  // 出站前先用预期画布证明该宽高比至少可表达；实际返回后仍会重新计算并复核。
  createExactAspectRect(target, {
    width: requested.expectedWidth,
    height: requested.expectedHeight,
  });
  return requested;
}

/**
 * 在 Provider 实际返回画布内冻结居中内容矩形和统一缩放比例。
 * @param target 官方最终宽高。
 * @param requested 出站请求中已哈希审计的离散画布配置。
 * @param providerCanvas 经图片解码取得的实际正整数宽高，不能只相信 Provider 文本元数据。
 * @returns 精确矩形；target 与矩形的两个轴共享同一个有理缩放比例。
 */
export function createImageTargetGeometry(
  target: ImageTargetDimensions,
  requested: RequestedImageCanvas,
  providerCanvas: { width: number; height: number },
): ImageTargetGeometry {
  assertDimensions(target);
  assertDimensions(providerCanvas);
  if (
    providerCanvas.width > 4_096 ||
    providerCanvas.height > 4_096 ||
    providerCanvas.width * providerCanvas.height > 16 * 1024 * 1024
  ) {
    throw new ImageTargetGeometryError();
  }
  const { rect, targetScale, providerScale } = createExactAspectRect(
    target,
    providerCanvas,
  );
  const scaleDivisor = greatestCommonDivisor(targetScale, providerScale);
  return {
    schemaVersion: 1,
    target: { ...target },
    requestedCanvas: { ...requested },
    providerCanvas: { ...providerCanvas },
    contentRect: rect,
    uniformScale: {
      numerator: targetScale / scaleDivisor,
      denominator: providerScale / scaleDivisor,
    },
    algorithm: "centered-exact-aspect-uniform-scale-v1",
  };
}

function createExactAspectRect(
  target: ImageTargetDimensions,
  canvas: ImageTargetDimensions,
): {
  rect: { left: number; top: number; width: number; height: number };
  targetScale: number;
  providerScale: number;
} {
  const targetScale = greatestCommonDivisor(target.width, target.height);
  const aspectWidth = target.width / targetScale;
  const aspectHeight = target.height / targetScale;
  const providerScale = Math.min(
    Math.floor(canvas.width / aspectWidth),
    Math.floor(canvas.height / aspectHeight),
  );
  if (providerScale < 1) throw new ImageTargetGeometryError();
  const width = aspectWidth * providerScale;
  const height = aspectHeight * providerScale;
  return {
    rect: {
      left: Math.floor((canvas.width - width) / 2),
      top: Math.floor((canvas.height - height) / 2),
      width,
      height,
    },
    targetScale,
    providerScale,
  };
}

function assertDimensions(value: ImageTargetDimensions): void {
  if (
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.width <= 0 ||
    value.height <= 0 ||
    value.width > 1_000_000 ||
    value.height > 1_000_000 ||
    value.width * value.height > 16 * 1024 * 1024
  ) {
    throw new ImageTargetGeometryError();
  }
}

function greatestCommonDivisor(left: number, right: number): number {
  let first = left;
  let second = right;
  while (second !== 0) {
    const remainder = first % second;
    first = second;
    second = remainder;
  }
  return first;
}
