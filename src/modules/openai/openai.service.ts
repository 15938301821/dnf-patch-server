/**
 * @fileoverview 编排固定角色模型调用、授权判断、哈希与审计状态，不暴露任意模型或工具入口。
 * @module openai
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 model evidence
 */
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { sha256Json } from "../../common/utils/canonical.js";
import { RunService } from "../run/run.service.js";
import type {
  ImageModelRequest,
  ImageModelResult,
  ModelCallView,
  ModelRole,
  StructuredModelRequest,
  StructuredModelResult,
} from "./openai.contracts.js";
import { OpenAiProvider, type OpenAiProviderPort } from "./openai.provider.js";
import {
  OpenAiRepository,
  type ModelCallCompletion,
  type OpenAiRepositoryPort,
} from "./openai.repository.js";

interface ModelConfigPort {
  getOrThrow(
    key:
      | "OPENAI_ORCHESTRATOR_MODEL"
      | "OPENAI_ENGINEER_MODEL"
      | "OPENAI_IMAGE_MODEL",
    options: { infer: true },
  ): string;
}

interface RunLookupPort {
  get(id: string): ReturnType<RunService["get"]>;
}

@Injectable()
export class OpenAiService {
  constructor(
    @Inject(ConfigService) private readonly config: ModelConfigPort,
    @Inject(OpenAiRepository) private readonly calls: OpenAiRepositoryPort,
    @Inject(RunService) private readonly runs: RunLookupPort,
    @Inject(OpenAiProvider) private readonly provider: OpenAiProviderPort,
  ) {}

  /** 结构化调用只使用服务端固定模型、空工具列表和禁用存储的 provider adapter。 */
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
    const blocked = await this.blockState(request.runId);
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
    const record = await this.createRunningRecord(
      request,
      model,
      requestSha256,
    );
    const egressRecord = await this.beginEgress(record);
    if (egressRecord.status === "failed") return { record: egressRecord };
    try {
      const response = await this.provider.structured({
        model,
        instructions: request.instructions,
        input: request.input,
        schema: request.schema,
        schemaName: request.schemaName,
      });
      return {
        value: response.value,
        record: await this.finishRecord(egressRecord, {
          status: "passed",
          responseId: response.responseId,
          responseSha256: sha256Json({
            id: response.responseId,
            output: response.value,
          }),
        }),
      };
    } catch (error) {
      return {
        record: await this.finishRecord(egressRecord, {
          status: "failed",
          errorCode: classifyModelError(error),
        }),
      };
    }
  }

  /** 图像调用只返回短暂字节与哈希证据，不把图片 BLOB 写入数据库。 */
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
    const blocked = await this.blockState(request.runId);
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
    const record = await this.createRunningRecord(
      request,
      model,
      requestSha256,
    );
    const egressRecord = await this.beginEgress(record);
    if (egressRecord.status === "failed") return { record: egressRecord };
    try {
      const bytes = await this.provider.image({
        model,
        prompt: request.prompt,
      });
      return {
        bytes,
        record: await this.finishRecord(egressRecord, {
          status: "passed",
          responseSha256: sha256Bytes(bytes),
        }),
      };
    } catch (error) {
      return {
        record: await this.finishRecord(egressRecord, {
          status: "failed",
          errorCode: classifyModelError(error),
        }),
      };
    }
  }

  private async blockState(
    runId: string,
  ): Promise<{ errorCode: string; authorized: boolean } | undefined> {
    const run = await this.runs.get(runId);
    if (!run.modelEgressAuthorized) {
      return { errorCode: "MODEL_EGRESS_NOT_AUTHORIZED", authorized: false };
    }
    if (!this.provider.configured) {
      return { errorCode: "OPENAI_API_KEY_NOT_CONFIGURED", authorized: true };
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

  private async createRunningRecord(
    request: { runId: string; role: ModelRole },
    model: string,
    requestSha256: string,
  ): Promise<ModelCallView> {
    const record = createModelCallView(
      request,
      model,
      this.provider.endpointIdentity,
      requestSha256,
      "running",
      true,
      false,
    );
    await this.calls.create(record);
    return record;
  }

  private async beginEgress(record: ModelCallView): Promise<ModelCallView> {
    if (await this.calls.markEgressPerformed(record.id)) {
      return { ...record, modelEgressPerformed: true };
    }
    return this.finishRecord(record, {
      status: "failed",
      errorCode: "MODEL_EGRESS_STATE_CONFLICT",
    });
  }

  private async recordBlocked(
    request: { runId: string; role: ModelRole },
    model: string,
    requestSha256: string,
    blocked: { errorCode: string; authorized: boolean },
  ): Promise<ModelCallView> {
    const record = createModelCallView(
      request,
      model,
      this.provider.endpointIdentity,
      requestSha256,
      "blocked",
      blocked.authorized,
      false,
      blocked.errorCode,
    );
    await this.calls.create(record);
    return record;
  }

  private async finishRecord(
    record: ModelCallView,
    completion: ModelCallCompletion,
  ): Promise<ModelCallView> {
    const finishedAt = new Date();
    if (!(await this.calls.finish(record.id, completion, finishedAt))) {
      throw new Error("MODEL_CALL_STATE_CONFLICT");
    }
    return {
      ...record,
      ...completion,
      finishedAtUtc: finishedAt.toISOString(),
    };
  }
}

function createModelCallView(
  request: { runId: string; role: ModelRole },
  model: string,
  endpointIdentity: string,
  requestSha256: string,
  status: ModelCallView["status"],
  modelEgressAuthorized: boolean,
  modelEgressPerformed: boolean,
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
    modelEgressPerformed,
    ...(errorCode ? { errorCode } : {}),
    createdAtUtc,
    ...(status !== "running" ? { finishedAtUtc: createdAtUtc } : {}),
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
