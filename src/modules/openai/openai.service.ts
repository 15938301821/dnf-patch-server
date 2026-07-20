import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { DatabaseService } from "../../common/db/database.service.js";
import { modelCalls } from "../../common/db/schema.js";
import { sha256Json } from "../../common/utils/canonical.js";
import type { Environment } from "../../config/environment.js";
import { resolveOpenAiEndpoint } from "../../config/openai-endpoint.js";
import { RunService } from "../run/run.service.js";
import type {
  ImageModelRequest,
  ImageModelResult,
  ModelCallView,
  ModelRole,
  StructuredModelRequest,
  StructuredModelResult,
} from "./openai.contracts.js";

@Injectable()
export class OpenAiService {
  private readonly endpoint: ReturnType<typeof resolveOpenAiEndpoint>;
  private readonly client: OpenAI | undefined;

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly connection: DatabaseService,
    private readonly runs: RunService,
  ) {
    this.endpoint = resolveOpenAiEndpoint(
      config.getOrThrow("OPENAI_BASE_URL", { infer: true }),
    );
    const apiKey = config.get("OPENAI_API_KEY", { infer: true });
    this.client = apiKey
      ? new OpenAI({
          apiKey,
          baseURL: this.endpoint.baseUrl,
          timeout: config.getOrThrow("OPENAI_REQUEST_TIMEOUT_MS", {
            infer: true,
          }),
          maxRetries: config.getOrThrow("OPENAI_REQUEST_MAX_RETRIES", {
            infer: true,
          }),
        })
      : undefined;
  }

  /** 结构化调用是服务内能力，调用方不能选择模型、工具或存储策略。 */
  async structured<T>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    const model = this.modelFor(request.role);
    const requestSha256 = sha256Json({
      model,
      instructions: request.instructions,
      input: request.input,
      schemaName: request.schemaName,
      tools: [],
      store: false,
    });
    const blocked = await this.blockReason(request.runId);
    if (blocked) {
      return {
        record: await this.recordBlocked(
          request,
          model,
          requestSha256,
          blocked,
        ),
      };
    }
    const client = this.client;
    if (!client) {
      return {
        record: await this.recordBlocked(
          request,
          model,
          requestSha256,
          "OPENAI_API_KEY_NOT_CONFIGURED",
        ),
      };
    }
    const record = await this.createPendingRecord(
      request,
      model,
      requestSha256,
    );
    try {
      const response = await client.responses.parse({
        model,
        instructions: request.instructions,
        input: request.input,
        text: { format: zodTextFormat(request.schema, request.schemaName) },
        tools: [],
        store: false,
      });
      const value = request.schema.parse(response.output_parsed);
      const finished = await this.finishRecord(record, {
        status: "passed",
        responseId: response.id,
        responseSha256: sha256Json({ id: response.id, output: value }),
      });
      return { value, record: finished };
    } catch (error) {
      return {
        record: await this.finishRecord(record, {
          status: "failed",
          errorCode: classifyModelError(error),
        }),
      };
    }
  }

  /** 图像字节只返回给服务内 Worker；数据库只保存调用哈希与状态。 */
  async image(request: ImageModelRequest): Promise<ImageModelResult> {
    const model = this.modelFor("artist");
    const requestSha256 = sha256Json({
      model,
      prompt: request.prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
      background: "opaque",
      outputFormat: "png",
    });
    const blocked = await this.blockReason(request.runId);
    if (blocked) {
      return {
        record: await this.recordBlocked(
          request,
          model,
          requestSha256,
          blocked,
        ),
      };
    }
    const client = this.client;
    if (!client) {
      return {
        record: await this.recordBlocked(
          request,
          model,
          requestSha256,
          "OPENAI_API_KEY_NOT_CONFIGURED",
        ),
      };
    }
    const record = await this.createPendingRecord(
      request,
      model,
      requestSha256,
    );
    try {
      const response = await client.images.generate({
        model,
        prompt: request.prompt,
        n: 1,
        size: "1536x1024",
        quality: "high",
        background: "opaque",
        output_format: "png",
      });
      const encoded = response.data?.[0]?.b64_json;
      if (!encoded) {
        throw new Error("IMAGE_PAYLOAD_MISSING");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length === 0) {
        throw new Error("IMAGE_PAYLOAD_EMPTY");
      }
      return {
        bytes,
        record: await this.finishRecord(record, {
          status: "passed",
          responseSha256: sha256Bytes(bytes),
        }),
      };
    } catch (error) {
      return {
        record: await this.finishRecord(record, {
          status: "failed",
          errorCode: classifyModelError(error),
        }),
      };
    }
  }

  private async blockReason(runId: string): Promise<string | undefined> {
    const run = await this.runs.get(runId);
    if (!run.modelEgressAuthorized) {
      return "MODEL_EGRESS_NOT_AUTHORIZED";
    }
    if (!this.client) {
      return "OPENAI_API_KEY_NOT_CONFIGURED";
    }
    return undefined;
  }

  private modelFor(role: ModelRole): string {
    const key =
      role === "orchestrator"
        ? "OPENAI_ORCHESTRATOR_MODEL"
        : role === "engineer"
          ? "OPENAI_ENGINEER_MODEL"
          : "OPENAI_IMAGE_MODEL";
    return this.config.getOrThrow(key, { infer: true });
  }

  private async createPendingRecord(
    request: { runId: string; role: ModelRole },
    model: string,
    requestSha256: string,
  ): Promise<ModelCallView> {
    const record = createModelCallView(
      request,
      model,
      this.endpoint.identity,
      requestSha256,
      "passed",
      true,
    );
    await this.connection.database.insert(modelCalls).values({
      ...toDatabaseRecord(record),
      status: "running",
    });
    return record;
  }

  private async recordBlocked(
    request: { runId: string; role: ModelRole },
    model: string,
    requestSha256: string,
    errorCode: string,
  ): Promise<ModelCallView> {
    const record = createModelCallView(
      request,
      model,
      this.endpoint.identity,
      requestSha256,
      "blocked",
      false,
      errorCode,
    );
    await this.connection.database
      .insert(modelCalls)
      .values(toDatabaseRecord(record));
    return record;
  }

  private async finishRecord(
    record: ModelCallView,
    result: Pick<
      ModelCallView,
      "status" | "responseId" | "responseSha256" | "errorCode"
    >,
  ): Promise<ModelCallView> {
    const finishedAt = new Date();
    await this.connection.database
      .update(modelCalls)
      .set({ ...result, finishedAt })
      .where(eq(modelCalls.id, record.id));
    return { ...record, ...result, finishedAtUtc: finishedAt.toISOString() };
  }
}

import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";

function createModelCallView(
  request: { runId: string; role: ModelRole },
  model: string,
  endpointIdentity: string,
  requestSha256: string,
  status: ModelCallView["status"],
  modelEgressAuthorized: boolean,
  errorCode?: string,
): ModelCallView {
  const createdAtUtc = new Date().toISOString();
  return {
    id: randomUUID(),
    runId: request.runId,
    role: request.role,
    model,
    endpointIdentity,
    requestSha256,
    status,
    modelEgressAuthorized,
    ...(errorCode ? { errorCode } : {}),
    createdAtUtc,
    ...(status === "blocked" ? { finishedAtUtc: createdAtUtc } : {}),
  };
}

function toDatabaseRecord(
  record: ModelCallView,
): typeof modelCalls.$inferInsert {
  return {
    id: record.id,
    runId: record.runId,
    role: record.role,
    model: record.model,
    endpointIdentity: record.endpointIdentity,
    requestSha256: record.requestSha256,
    status: record.status,
    modelEgressAuthorized: record.modelEgressAuthorized,
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    createdAt: new Date(record.createdAtUtc),
    ...(record.finishedAtUtc
      ? { finishedAt: new Date(record.finishedAtUtc) }
      : {}),
  };
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function classifyModelError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("IMAGE_PAYLOAD_")) {
    return error.message;
  }
  return "MODEL_PROVIDER_REQUEST_FAILED";
}
