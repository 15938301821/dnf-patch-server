/**
 * @fileoverview 为固定图片模型调用复核 PNG 输入、生成脱敏审计身份、附加 V6 几何约束，
 * 并从 Provider 返回字节解码真实画布；不读取 Run 授权、不选择用户配置，也不发起网络或数据库写入。
 * @module modules/openai
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：OpenAiService 在计算请求哈希和调用 OpenAiProvider 前使用输入复核函数，在 Provider
 * 返回后使用 PNG 解码函数；输入来自服务内已冻结的模型请求，输出只回到同一次 Service 编排。
 * 副作用：仅复制和解码内存字节，不访问网络、数据库或对象存储。
 * 安全边界：调用方声明的 SHA-256 不能代替字节复算；PNG 签名、数量、角色唯一性和像素预算
 * 任一不满足都必须失败关闭。Prompt 约束不能代替后续对官方尺寸、Alpha 和透明区域的像素验证。
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ModelImageInput } from "./openai.contracts.js";

const maximumModelImageBytes = 64 * 1024 * 1024;
const maximumModelImagePixels = 16 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * 复核一组模型图片输入，并阻止重复角色使 Provider 输入顺序产生歧义。
 * @param images 由受控领域 Service 组装的一至两张 PNG，不是浏览器或 Worker 任意上传入口。
 * @returns 已复制并逐张复算摘要的只读图片集合。
 * @throws Error 当数量、PNG 签名、长度、角色唯一性或任一摘要不合法时抛出稳定内部错误。
 */
export function verifiedImages(
  images: readonly ModelImageInput[],
): readonly ModelImageInput[] {
  if (images.length < 1 || images.length > 2) {
    throw new Error("MODEL_IMAGE_INPUT_COUNT_INVALID");
  }
  const verified = images.map(verifiedImage);
  if (new Set(verified.map((image) => image.role)).size !== verified.length) {
    throw new Error("MODEL_IMAGE_INPUT_ROLE_DUPLICATED");
  }
  return verified;
}

/**
 * 复制并复核单张 PNG，避免调用方在哈希审计后继续修改同一底层字节。
 * @param image 服务内模型请求携带的角色、媒体类型、字节和预期 SHA-256。
 * @returns 拥有独立 Buffer 且摘要与正文一致的图片输入。
 * @throws Error 当字节为空、超预算、签名错误或 SHA-256 漂移时抛出稳定内部错误。
 */
export function verifiedImage(image: ModelImageInput): ModelImageInput {
  const bytes = Buffer.from(image.bytes);
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength > maximumModelImageBytes ||
    bytes.byteLength < pngSignature.byteLength ||
    !bytes.subarray(0, pngSignature.byteLength).equals(pngSignature) ||
    !/^[A-F0-9]{64}$/u.test(image.sha256) ||
    sha256Bytes(bytes) !== image.sha256
  ) {
    throw new Error("MODEL_IMAGE_INPUT_INVALID");
  }
  return { ...image, bytes };
}

/** 为结构化调用哈希投影全部图片身份，不把原始字节写入审计 JSON。 */
export function imageIdentities(
  images: readonly ModelImageInput[],
): readonly ReturnType<typeof imageIdentity>[] {
  return verifiedImages(images).map(imageIdentity);
}

/**
 * 将一张已复核图片投影为可审计身份；返回值不包含图片正文。
 * @param image 待复核的服务内 PNG 输入。
 * @returns 固定角色、媒体类型、长度和实际 SHA-256。
 */
export function imageIdentity(image: ModelImageInput): {
  role: ModelImageInput["role"];
  mediaType: "image/png";
  byteLength: number;
  sha256: string;
} {
  const verified = verifiedImage(image);
  return {
    role: verified.role,
    mediaType: verified.mediaType,
    byteLength: verified.bytes.byteLength,
    sha256: verified.sha256,
  };
}

/** 对图片正文计算审计使用的大写 SHA-256，不持久化原始字节。 */
export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

/**
 * 向 V6 固定业务 Prompt 附加机器可审计的几何要求；调用方不能覆盖该段请求任意画布行为。
 * Provider 原始输出仍是不可信候选，后续正规化器会验证透明区域和官方 Alpha，而非相信文本遵循度。
 */
export function targetFramePrompt(
  prompt: string,
  targetWidth: number,
  targetHeight: number,
): string {
  return `${prompt}\n\nV6 target canvas contract: keep all visible artwork inside the largest centered rectangle whose exact aspect ratio is ${String(targetWidth)}:${String(targetHeight)}. Every pixel outside that rectangle must be fully transparent. Do not stretch the artwork. Return a transparent PNG.`;
}

/**
 * 从真实 PNG 解码实际 Provider 画布，不能用请求值或响应文本伪造返回尺寸。
 * @param bytes Provider 返回且尚未信任的候选图片字节。
 * @returns Sharp 复读得到的正整数 PNG 宽高。
 * @throws Error 当格式、尺寸或解码预算不合法时抛出稳定内部错误。
 */
export async function decodedPngDimensions(
  bytes: Uint8Array,
): Promise<{ width: number; height: number }> {
  const metadata = await sharp(Buffer.from(bytes), {
    failOn: "warning",
    limitInputPixels: maximumModelImagePixels,
    sequentialRead: true,
  }).metadata();
  if (
    metadata.format !== "png" ||
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    !metadata.width ||
    !metadata.height
  ) {
    throw new Error("IMAGE_PAYLOAD_DIMENSIONS_INVALID");
  }
  return { width: metadata.width, height: metadata.height };
}
