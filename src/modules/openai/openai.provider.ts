/**
 * @fileoverview 封装固定 OpenAI 端点调用与响应解析，不持久化模型证据或选择业务角色。
 * @module openai
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 model evidence
 */
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import sharp from "sharp";
import { z } from "zod";
import type { Environment } from "../../config/environment.js";

const maxImageBytes = 32 * 1024 * 1024;
const maxEncodedImageLength = 4 * Math.ceil(maxImageBytes / 3);
const maxImagePixels = 16 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegSignature = Buffer.from([255, 216, 255]);
const geminiImageModelPattern = /^gemini-[a-z0-9._-]*image[a-z0-9._-]*$/iu;
const geminiImageMediaTypeSchema = z.enum(["image/png", "image/jpeg"]);

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
  schemaName: string;
  schema: z.ZodType<T>;
  instructions: string;
  input: string;
}

export interface ImageProviderRequest {
  model: string;
  prompt: string;
}

export interface OpenAiProviderPort {
  structured<T>(
    request: StructuredProviderRequest<T>,
    configuration: OpenAiCallConfiguration,
  ): Promise<{ responseId: string; value: T }>;
  image(
    request: ImageProviderRequest,
    configuration: OpenAiCallConfiguration,
  ): Promise<Uint8Array>;
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
  ): Promise<{ responseId: string; value: T }> {
    const client = this.client(configuration);
    const response = await client.responses.parse({
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      text: { format: zodTextFormat(request.schema, request.schemaName) },
      tools: [],
      store: false,
    });
    return {
      responseId: response.id,
      value: request.schema.parse(response.output_parsed),
    };
  }

  /** 调用固定图片接口，仅返回经过非空校验的 PNG 字节。 */
  async image(
    request: ImageProviderRequest,
    configuration: OpenAiCallConfiguration,
  ): Promise<Uint8Array> {
    const client = this.client(configuration);
    try {
      const response = await client.images.generate({
        model: request.model,
        prompt: request.prompt,
        n: 1,
        size: "1536x1024",
        quality: "high",
        background: "opaque",
        output_format: "png",
      });
      return decodePngPayload(response.data?.[0]?.b64_json);
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
  ): Promise<Uint8Array> {
    const response = await client.post<unknown>(
      buildGeminiImageUrl(baseUrl, request.model),
      {
        body: {
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio: "3:2", imageSize: "1K" },
          },
        },
      },
    );
    return decodeGeminiImagePayload(extractGeminiImage(response));
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
