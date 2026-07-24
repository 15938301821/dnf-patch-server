/**
 * @fileoverview 编排固定角色模型调用、授权判断、哈希与审计状态，不暴露任意模型或工具入口。
 * @module openai
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 model evidence
 */
import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { sha256Json } from "../../common/utils/canonical.js";
import { resolveOpenAiEndpoint } from "../../config/openai-endpoint.js";
import type {
  ModelRole as ConfigurationRole,
  ResolvedModelRoleConfiguration,
} from "../model-configuration/model-configuration.contracts.js";
import { ModelConfigurationService } from "../model-configuration/model-configuration.service.js";
import { RunService } from "../run/run.service.js";
import type {
  ImageModelRequest,
  ImageModelResult,
  ModelEgressGuard,
  ModelCallView,
  ModelRole,
  StructuredModelRequest,
  StructuredModelResult,
} from "./openai.contracts.js";
import {
  OpenAiProvider,
  type OpenAiCallConfiguration,
  type OpenAiProviderPort,
} from "./openai.provider.js";
import {
  OpenAiRepository,
  type ModelCallCompletion,
  type OpenAiRepositoryPort,
} from "./openai.repository.js";

interface ModelConfigurationLookupPort {
  resolve(
    userId: string,
    role: ConfigurationRole,
  ): ReturnType<ModelConfigurationService["resolve"]>;
}

interface RunLookupPort {
  getModelContext(id: string): ReturnType<RunService["getModelContext"]>;
}

interface ResolvedCallContext {
  blocked?: undefined;
  model: string;
  endpointIdentity: string;
  modelConfigurationVersion: number;
  provider: OpenAiCallConfiguration;
}

interface BlockedCallContext {
  blocked: { errorCode: string; authorized: boolean };
  model: string;
  endpointIdentity: string;
}

type ModelCallContext = ResolvedCallContext | BlockedCallContext;

@Injectable()
export class OpenAiService {
  constructor(
    @Inject(OpenAiRepository) private readonly calls: OpenAiRepositoryPort,
    @Inject(RunService) private readonly runs: RunLookupPort,
    @Inject(ModelConfigurationService)
    private readonly configurations: ModelConfigurationLookupPort,
    @Inject(OpenAiProvider) private readonly provider: OpenAiProviderPort,
  ) {}

  /** 结构化调用只使用服务端固定模型、空工具列表和禁用存储的 provider adapter。 */
  async structured<T>(
    request: StructuredModelRequest<T>,
    beforeEgress?: ModelEgressGuard,
  ): Promise<StructuredModelResult<T>> {
    const context = await this.resolveContext(request.runId, request.role);
    const requestSha256 = sha256Json({
      model: context.model,
      endpointIdentity: context.endpointIdentity,
      ...(context.blocked
        ? {}
        : { modelConfigurationVersion: context.modelConfigurationVersion }),
      instructions: request.instructions,
      input: request.input,
      schemaName: request.schemaName,
      tools: [],
      store: false,
    });
    if (context.blocked) {
      return {
        record: await this.recordBlocked(request, context, requestSha256),
      };
    }
    const record = await this.createRunningRecord(
      request,
      context,
      requestSha256,
    );
    const guardedRecord = await this.applyEgressGuard(record, beforeEgress);
    if (guardedRecord.status === "failed") return { record: guardedRecord };
    const egressRecord = await this.beginEgress(record);
    if (egressRecord.status === "failed") return { record: egressRecord };
    try {
      const response = await this.provider.structured(
        {
          model: context.model,
          instructions: request.instructions,
          input: request.input,
          schema: request.schema,
          schemaName: request.schemaName,
        },
        context.provider,
      );
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
  async image(
    request: ImageModelRequest,
    beforeEgress?: ModelEgressGuard,
  ): Promise<ImageModelResult> {
    const context = await this.resolveContext(request.runId, "artist");
    const requestSha256 = sha256Json({
      model: context.model,
      endpointIdentity: context.endpointIdentity,
      ...(context.blocked
        ? {}
        : { modelConfigurationVersion: context.modelConfigurationVersion }),
      prompt: request.prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
      background: "opaque",
      outputFormat: "png",
    });
    if (context.blocked) {
      return {
        record: await this.recordBlocked(request, context, requestSha256),
      };
    }
    const record = await this.createRunningRecord(
      request,
      context,
      requestSha256,
    );
    const guardedRecord = await this.applyEgressGuard(record, beforeEgress);
    if (guardedRecord.status === "failed") return { record: guardedRecord };
    const egressRecord = await this.beginEgress(record);
    if (egressRecord.status === "failed") return { record: egressRecord };
    try {
      const bytes = await this.provider.image(
        {
          model: context.model,
          prompt: request.prompt,
        },
        context.provider,
      );
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

  private async resolveContext(
    runId: string,
    role: ModelRole,
  ): Promise<ModelCallContext> {
    const run = await this.runs.getModelContext(runId);
    if (!run.modelEgressAuthorized) {
      return blockedContext("MODEL_EGRESS_NOT_AUTHORIZED", false);
    }
    if (!run.ownerUserId) {
      return blockedContext("MODEL_CONFIGURATION_OWNER_REQUIRED", true);
    }
    let configuration: ResolvedModelRoleConfiguration | undefined;
    try {
      configuration = await this.configurations.resolve(
        run.ownerUserId,
        configurationRoleFor(role),
      );
    } catch {
      return blockedContext("MODEL_CONFIGURATION_UNAVAILABLE", true);
    }
    if (!configuration) {
      return blockedContext("MODEL_CONFIGURATION_NOT_CONFIGURED", true);
    }
    const endpoint = resolveOpenAiEndpoint(configuration.endpoint);
    return {
      model: configuration.model,
      endpointIdentity: endpoint.identity,
      modelConfigurationVersion: configuration.version,
      provider: {
        apiKey: configuration.apiKey,
        baseUrl: endpoint.baseUrl,
      },
    };
  }

  private async createRunningRecord(
    request: { runId: string; role: ModelRole },
    context: ResolvedCallContext,
    requestSha256: string,
  ): Promise<ModelCallView> {
    const record = createModelCallView(
      request,
      context.model,
      context.endpointIdentity,
      requestSha256,
      "running",
      true,
      false,
      context.modelConfigurationVersion,
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

  private async applyEgressGuard(
    record: ModelCallView,
    beforeEgress: ModelEgressGuard | undefined,
  ): Promise<ModelCallView> {
    if (!beforeEgress) return record;
    try {
      if ((await beforeEgress(record)) === "accepted") return record;
      return await this.finishRecord(record, {
        status: "failed",
        errorCode: "MODEL_EGRESS_GUARD_REJECTED",
      });
    } catch {
      return this.finishRecord(record, {
        status: "failed",
        errorCode: "MODEL_EGRESS_GUARD_FAILED",
      });
    }
  }

  private async recordBlocked(
    request: { runId: string; role: ModelRole },
    context: BlockedCallContext,
    requestSha256: string,
  ): Promise<ModelCallView> {
    const record = createModelCallView(
      request,
      context.model,
      context.endpointIdentity,
      requestSha256,
      "blocked",
      context.blocked.authorized,
      false,
      undefined,
      context.blocked.errorCode,
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
  modelConfigurationVersion?: number,
  errorCode?: string,
): ModelCallView {
  const createdAtUtc = new Date().toISOString();
  return {
    id: randomUUID(),
    runId: request.runId,
    role: request.role,
    model,
    endpointIdentity,
    ...(modelConfigurationVersion ? { modelConfigurationVersion } : {}),
    requestSha256,
    status,
    modelEgressAuthorized,
    modelEgressPerformed,
    ...(errorCode ? { errorCode } : {}),
    createdAtUtc,
    ...(status !== "running" ? { finishedAtUtc: createdAtUtc } : {}),
  };
}

function blockedContext(
  errorCode: string,
  authorized: boolean,
): BlockedCallContext {
  return {
    blocked: { errorCode, authorized },
    model: "unconfigured",
    endpointIdentity: "unconfigured",
  };
}

function configurationRoleFor(role: ModelRole): ConfigurationRole {
  return role === "orchestrator"
    ? "orchestrator"
    : role === "engineer"
      ? "spriteProcessor"
      : "referenceGenerator";
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
