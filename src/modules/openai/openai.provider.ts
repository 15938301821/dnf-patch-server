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
import type { z } from "zod";
import type { Environment } from "../../config/environment.js";

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
    const response = await client.images.generate({
      model: request.model,
      prompt: request.prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
      background: "opaque",
      output_format: "png",
    });
    const encoded = response.data?.[0]?.b64_json;
    if (!encoded) throw new Error("IMAGE_PAYLOAD_MISSING");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0) throw new Error("IMAGE_PAYLOAD_EMPTY");
    return bytes;
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
