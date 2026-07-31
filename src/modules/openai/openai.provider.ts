/**
 * @fileoverview 封装固定 OpenAI 端点调用与响应解析，不持久化模型证据或选择业务角色。
 * @module openai
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 model evidence
 */
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import sharp from "sharp";
import { z } from "zod";
import type { Environment } from "../../config/environment.js";
import type { ModelReasoningEffort } from "../model-configuration/model-configuration.contracts.js";
import type { ModelImageInput, ModelUsage } from "./openai.contracts.js";
import type { RequestedImageCanvas } from "./image-target-geometry.js";
import { legacyRequestedImageCanvas } from "./image-target-geometry.js";

const maxImageBytes = 32 * 1024 * 1024;
const maxEncodedImageLength = 4 * Math.ceil(maxImageBytes / 3);
const maxImagePixels = 16 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegSignature = Buffer.from([255, 216, 255]);
const geminiImageModelPattern = /^gemini-[a-z0-9._-]*image[a-z0-9._-]*$/iu;
const geminiImageMediaTypeSchema = z.enum(["image/png", "image/jpeg"]);
const tokenCountSchema = z.number().int().min(0).max(4_294_967_295);

const openAiUsageSchema = z
  .object({
    input_tokens: tokenCountSchema,
    output_tokens: tokenCountSchema,
    total_tokens: tokenCountSchema,
  })
  .loose();

const geminiUsageSchema = z
  .object({
    usageMetadata: z
      .object({
        promptTokenCount: tokenCountSchema,
        candidatesTokenCount: tokenCountSchema,
        totalTokenCount: tokenCountSchema,
      })
      .loose(),
  })
  .loose();

const geminiInlineImageSchema = z
  .object({
    data: z.string().min(1).max(maxEncodedImageLength),
    mimeType: geminiImageMediaTypeSchema.optional(),
    mime_type: geminiImageMediaTypeSchema.optional(),
  })
  .loose()
  .refine(
    (value) => value.mimeType !== undefined || value.mime_type !== undefined,
  );

const geminiImageResponseSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            content: z
              .object({ parts: z.array(z.unknown()).min(1).max(64) })
              .loose(),
          })
          .loose(),
      )
      .min(1)
      .max(8),
  })
  .loose();

export interface OpenAiCallConfiguration {
  apiKey: string;
  baseUrl: string;
}

export interface StructuredProviderRequest<T> {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  schemaName: string;
  schema: z.ZodType<T>;
  instructions: string;
  input: string;
  imageInputs?: readonly ModelImageInput[];
}

export interface ImageProviderRequest {
  model: string;
  prompt: string;
  sourceImage?: ModelImageInput;
  /** 仅由 OpenAiService 从官方 target 选择；缺失表示历史 V5 固定画布。 */
  requestedCanvas?: RequestedImageCanvas;
}

/** 结构化模型调用的已校验结果；usage 缺失时调用方必须显示为未计量。 */
export interface StructuredProviderResult<T> {
  responseId: string;
  value: T;
  usage?: ModelUsage;
}

/** 图片模型调用的已校验 PNG 与可选计量；图片字节仍只能短暂存在于服务进程内存。 */
export interface ImageProviderResult {
  bytes: Uint8Array;
  usage?: ModelUsage;
}

export interface OpenAiProviderPort {
  structured<T>(
    request: StructuredProviderRequest<T>,
    configuration: OpenAiCallConfiguration,
  ): Promise<StructuredProviderResult<T>>;
  image(
    request: ImageProviderRequest,
    configuration: OpenAiCallConfiguration,
  ): Promise<ImageProviderResult>;
}

@Injectable()
export class OpenAiProvider implements OpenAiProviderPort {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: ConfigService<Environment, true>) {
    this.timeoutMs = config.getOrThrow("OPENAI_REQUEST_TIMEOUT_MS", {
      infer: true,
    });
    this.maxRetries = config.getOrThrow("OPENAI_REQUEST_MAX_RETRIES", {
      infer: true,
    });
  }

  /** 调用固定结构化接口并在返回前执行调用方提供的 Zod schema。 */
  async structured<T>(
    request: StructuredProviderRequest<T>,
    configuration: OpenAiCallConfiguration,
  ): Promise<StructuredProviderResult<T>> {
    const client = this.client(configuration);
    const body: ResponseCreateParamsNonStreaming = {
      model: request.model,
      ...(request.reasoningEffort === "default" ||
      request.reasoningEffort === "ultra"
        ? {}
        : { reasoning: { effort: request.reasoningEffort } }),
      instructions: request.instructions,
      input: request.imageInputs?.length
        ? [
            {
              role: "user",
              content: [
                { type: "input_text" as const, text: request.input },
                ...request.imageInputs.map((image) => ({
                  type: "input_image" as const,
                  detail: "original" as const,
                  image_url: dataUrl(image),
                })),
              ],
            },
          ]
        : request.input,
      text: { format: zodTextFormat(request.schema, request.schemaName) },
      tools: [],
      store: false,
    };
    const response = await client.responses.parse(
      body,
      request.reasoningEffort === "ultra"
        ? {
            // ultra 是 OpenAI 兼容端点扩展值；原样发送，官方端点不支持时不得降级或伪造成功。
            body: { ...body, reasoning: { effort: "ultra" } },
          }
        : undefined,
    );
    return {
      responseId: response.id,
      value: request.schema.parse(response.output_parsed),
      ...optionalUsage(normalizeOpenAiUsage(response.usage)),
    };
  }

  /** 调用固定图片接口，仅返回经过非空校验的 PNG 字节。 */
  async image(
    request: ImageProviderRequest,
    configuration: OpenAiCallConfiguration,
  ): Promise<ImageProviderResult> {
    const client = this.client(configuration);
    const requestedCanvas =
      request.requestedCanvas ?? legacyRequestedImageCanvas;
    try {
      const response = request.sourceImage
        ? await client.images.edit({
            model: request.model,
            image: await toFile(
              Buffer.from(request.sourceImage.bytes),
              "official-source.png",
              { type: request.sourceImage.mediaType },
            ),
            prompt: request.prompt,
            n: 1,
            size: requestedCanvas.openAiSize,
            quality: "high",
            background: "transparent",
            output_format: "png",
            input_fidelity: "high",
          })
        : await client.images.generate({
            model: request.model,
            prompt: request.prompt,
            n: 1,
            size: requestedCanvas.openAiSize,
            quality: "high",
            background: "transparent",
            output_format: "png",
          });
      return {
        bytes: decodePngPayload(response.data?.[0]?.b64_json),
        ...optionalUsage(normalizeOpenAiUsage(response.usage)),
      };
    } catch (error) {
      // 只有确认缺少 OpenAI Images 路由的 Gemini 图片模型才切换固定协议；认证、限流和
      // Provider 失败必须原样上抛，避免把真实故障伪装为另一种模型请求。
      if (
        !(error instanceof OpenAI.NotFoundError) ||
        !geminiImageModelPattern.test(request.model)
      ) {
        throw error;
      }
      return this.geminiImage(client, request, configuration.baseUrl);
    }
  }

  /**
   * 在同一已授权 HTTPS 主机上调用固定 Antigravity Gemini 图片协议。
   * 返回体仍视为不可信外部输入，只接受有界候选集合中的 `image/png` inlineData。
   */
  private async geminiImage(
    client: OpenAI,
    request: ImageProviderRequest,
    baseUrl: string,
  ): Promise<ImageProviderResult> {
    const response = await client.post<unknown>(
      buildGeminiImageUrl(baseUrl, request.model),
      {
        body: {
          contents: [
            {
              role: "user",
              parts: [
                { text: request.prompt },
                ...(request.sourceImage
                  ? [
                      {
                        inlineData: {
                          mimeType: request.sourceImage.mediaType,
                          data: Buffer.from(request.sourceImage.bytes).toString(
                            "base64",
                          ),
                        },
                      },
                    ]
                  : []),
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              aspectRatio:
                request.requestedCanvas?.geminiAspectRatio ??
                legacyRequestedImageCanvas.geminiAspectRatio,
              imageSize: "1K",
            },
          },
        },
      },
    );
    return {
      bytes: await decodeGeminiImagePayload(extractGeminiImage(response)),
      ...optionalUsage(normalizeGeminiUsage(response)),
    };
  }

  private client(configuration: OpenAiCallConfiguration): OpenAI {
    return new OpenAI({
      apiKey: configuration.apiKey,
      baseURL: configuration.baseUrl,
      timeout: this.timeoutMs,
      maxRetries: this.maxRetries,
    });
  }
}

function dataUrl(image: ModelImageInput): string {
  return `data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}`;
}

/** OpenAI Responses/Images 共用 snake_case usage；畸形遥测被忽略，不能推翻已校验业务结果。 */
function normalizeOpenAiUsage(value: unknown): ModelUsage | undefined {
  const parsed = openAiUsageSchema.safeParse(value);
  return parsed.success
    ? {
        inputTokens: parsed.data.input_tokens,
        outputTokens: parsed.data.output_tokens,
        totalTokens: parsed.data.total_tokens,
      }
    : undefined;
}

/** Gemini 原生图片协议使用 usageMetadata；缺项或越界时保持未计量。 */
function normalizeGeminiUsage(value: unknown): ModelUsage | undefined {
  const parsed = geminiUsageSchema.safeParse(value);
  return parsed.success
    ? {
        inputTokens: parsed.data.usageMetadata.promptTokenCount,
        outputTokens: parsed.data.usageMetadata.candidatesTokenCount,
        totalTokens: parsed.data.usageMetadata.totalTokenCount,
      }
    : undefined;
}

/** 只在计量完整时添加 usage 属性，避免 `usage: undefined` 被误当成已采集字段。 */
function optionalUsage(usage: ModelUsage | undefined): { usage?: ModelUsage } {
  return usage ? { usage } : {};
}

/** 从已校验的同源 OpenAI `/v1` 地址派生固定 Gemini 混合路由，不接受响应或调用方提供路径。 */
function buildGeminiImageUrl(baseUrl: string, model: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

interface EncodedGeminiImage {
  data: string;
  mediaType: "image/png" | "image/jpeg";
}

/** 从 Gemini 外部响应中提取首个有界 PNG/JPEG inlineData；文本候选不会被误当成图片。 */
function extractGeminiImage(value: unknown): EncodedGeminiImage {
  const response = geminiImageResponseSchema.parse(value);
  for (const candidate of response.candidates) {
    for (const part of candidate.content.parts) {
      const camelCase = z
        .object({ inlineData: geminiInlineImageSchema })
        .loose()
        .safeParse(part);
      if (camelCase.success)
        return normalizeGeminiImage(camelCase.data.inlineData);
      const snakeCase = z
        .object({ inline_data: geminiInlineImageSchema })
        .loose()
        .safeParse(part);
      if (snakeCase.success)
        return normalizeGeminiImage(snakeCase.data.inline_data);
    }
  }
  throw new Error("IMAGE_PAYLOAD_MISSING");
}

function normalizeGeminiImage(
  value: z.infer<typeof geminiInlineImageSchema>,
): EncodedGeminiImage {
  const mediaType = value.mimeType ?? value.mime_type;
  if (!mediaType) throw new Error("IMAGE_MEDIA_TYPE_MISSING");
  return { data: value.data, mediaType };
}

/** Gemini 可返回 JPEG；严格解码后转为现有 Server/Worker 契约要求的 PNG。 */
async function decodeGeminiImagePayload(
  image: EncodedGeminiImage,
): Promise<Uint8Array> {
  if (image.mediaType === "image/png") return decodePngPayload(image.data);
  const jpeg = decodeImageBytes(image.data);
  if (
    jpeg.length < 5 ||
    !jpeg.subarray(0, jpegSignature.length).equals(jpegSignature) ||
    jpeg[jpeg.length - 2] !== 255 ||
    jpeg[jpeg.length - 1] !== 217
  ) {
    throw new Error("IMAGE_PAYLOAD_NOT_JPEG");
  }
  const png = await sharp(jpeg, {
    failOn: "warning",
    limitInputPixels: maxImagePixels,
  })
    .png()
    .toBuffer();
  if (png.length > maxImageBytes) throw new Error("IMAGE_PAYLOAD_TOO_LARGE");
  assertPngBytes(png);
  return png;
}

/** 解码有界 base64 并校验 PNG 文件签名；截断、空值和其他媒体类型统一失败关闭。 */
function decodePngPayload(encoded: string | undefined): Uint8Array {
  if (!encoded) throw new Error("IMAGE_PAYLOAD_MISSING");
  const bytes = decodeImageBytes(encoded);
  assertPngBytes(bytes);
  return bytes;
}

function decodeImageBytes(encoded: string): Buffer {
  if (encoded.length > maxEncodedImageLength) {
    throw new Error("IMAGE_PAYLOAD_TOO_LARGE");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) throw new Error("IMAGE_PAYLOAD_EMPTY");
  if (bytes.length > maxImageBytes) throw new Error("IMAGE_PAYLOAD_TOO_LARGE");
  return bytes;
}

function assertPngBytes(bytes: Uint8Array): void {
  if (
    bytes.length < pngSignature.length ||
    !Buffer.from(bytes).subarray(0, pngSignature.length).equals(pngSignature)
  ) {
    throw new Error("IMAGE_PAYLOAD_NOT_PNG");
  }
}
