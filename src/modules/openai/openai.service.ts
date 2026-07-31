/**
 * @fileoverview 编排固定角色模型调用、授权判断、哈希与审计状态，不暴露任意模型或工具入口。
 * @module openai
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 model evidence
 */
import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { sha256Json } from "../../common/utils/canonical.js";
import { resolveOpenAiEndpoint } from "../../config/openai-endpoint.js";
import type {
  ModelReasoningEffort,
  ModelRole as ConfigurationRole,
  ResolvedModelRoleConfiguration,
} from "../model-configuration/model-configuration.contracts.js";
import { ModelConfigurationService } from "../model-configuration/model-configuration.service.js";
import { RunService } from "../run/run.service.js";
import type {
  ImageModelRequest,
  ImageModelResult,
  ModelImageInput,
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
  createImageTargetGeometry,
  legacyRequestedImageCanvas,
  selectRequestedImageCanvas,
} from "./image-target-geometry.js";
import {
  OpenAiRepository,
  type ModelCallCompletion,
  type OpenAiRepositoryPort,
} from "./openai.repository.js";

const maximumModelImageBytes = 64 * 1024 * 1024;
const maximumModelImagePixels = 16 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface ModelConfigurationLookupPort {
  resolve(
    userId: string,
    role: ConfigurationRole,
  ): ReturnType<ModelConfigurationService["resolve"]>;
}

function verifiedImages(
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

function verifiedImage(image: ModelImageInput): ModelImageInput {
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

function imageIdentities(
  images: readonly ModelImageInput[],
): readonly ReturnType<typeof imageIdentity>[] {
  return verifiedImages(images).map(imageIdentity);
}

function imageIdentity(image: ModelImageInput): {
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

interface RunLookupPort {
  getModelContext(id: string): ReturnType<RunService["getModelContext"]>;
}

interface ResolvedCallContext {
  blocked?: undefined;
  model: string;
  reasoningEffort: ModelReasoningEffort;
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
        : {
            modelConfigurationVersion: context.modelConfigurationVersion,
            ...(context.reasoningEffort === "default"
              ? {}
              : { reasoning: { effort: context.reasoningEffort } }),
          }),
      instructions: request.instructions,
      input: request.input,
      ...(request.imageInputs
        ? { imageInputs: imageIdentities(request.imageInputs) }
        : {}),
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
    const providerStartedAt = performance.now();
    try {
      const response = await this.provider.structured(
        {
          model: context.model,
          reasoningEffort: context.reasoningEffort,
          instructions: request.instructions,
          input: request.input,
          ...(request.imageInputs
            ? { imageInputs: verifiedImages(request.imageInputs) }
            : {}),
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
          ...(response.usage ? { usage: response.usage } : {}),
          providerLatencyMs: elapsedProviderMs(providerStartedAt),
        }),
      };
    } catch (error) {
      return {
        record: await this.finishRecord(egressRecord, {
          status: "failed",
          errorCode: classifyModelError(error),
          providerLatencyMs: elapsedProviderMs(providerStartedAt),
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
    const requestedCanvas = request.targetDimensions
      ? selectRequestedImageCanvas(request.targetDimensions)
      : legacyRequestedImageCanvas;
    const providerPrompt = request.targetDimensions
      ? targetFramePrompt(
          request.prompt,
          request.targetDimensions.width,
          request.targetDimensions.height,
        )
      : request.prompt;
    const requestSha256 = sha256Json({
      model: context.model,
      endpointIdentity: context.endpointIdentity,
      ...(context.blocked
        ? {}
        : { modelConfigurationVersion: context.modelConfigurationVersion }),
      prompt: providerPrompt,
      ...(request.sourceImage
        ? { sourceImage: imageIdentity(request.sourceImage) }
        : {}),
      n: 1,
      size: requestedCanvas.openAiSize,
      ...(request.targetDimensions
        ? {
            targetDimensions: request.targetDimensions,
            requestedCanvas: {
              schemaVersion: 1,
              openAiSize: requestedCanvas.openAiSize,
              geminiAspectRatio: requestedCanvas.geminiAspectRatio,
              expectedWidth: requestedCanvas.expectedWidth,
              expectedHeight: requestedCanvas.expectedHeight,
            },
          }
        : {}),
      quality: "high",
      background: "transparent",
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
    const providerStartedAt = performance.now();
    try {
      const response = await this.provider.image(
        {
          model: context.model,
          prompt: providerPrompt,
          requestedCanvas,
          ...(request.sourceImage
            ? { sourceImage: verifiedImage(request.sourceImage) }
            : {}),
        },
        context.provider,
      );
      const targetGeometry = request.targetDimensions
        ? createImageTargetGeometry(
            request.targetDimensions,
            requestedCanvas,
            await decodedPngDimensions(response.bytes),
          )
        : undefined;
      return {
        bytes: response.bytes,
        ...(targetGeometry ? { targetGeometry } : {}),
        record: await this.finishRecord(egressRecord, {
          status: "passed",
          responseSha256: sha256Bytes(response.bytes),
          ...(response.usage ? { usage: response.usage } : {}),
          providerLatencyMs: elapsedProviderMs(providerStartedAt),
        }),
      };
    } catch (error) {
      return {
        record: await this.finishRecord(egressRecord, {
          status: "failed",
          errorCode: classifyModelError(error),
          providerLatencyMs: elapsedProviderMs(providerStartedAt),
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
      reasoningEffort: configuration.reasoningEffort,
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

/**
 * 向 V6 固定业务 Prompt 附加机器可审计的几何要求；调用方不能覆盖该段来请求任意画布行为。
 * Provider 原始输出仍是不可信候选，后续正规化器会验证透明区域和官方 Alpha，而非相信文本遵循度。
 */
function targetFramePrompt(
  prompt: string,
  targetWidth: number,
  targetHeight: number,
): string {
  return `${prompt}\n\nV6 target canvas contract: keep all visible artwork inside the largest centered rectangle whose exact aspect ratio is ${targetWidth}:${targetHeight}. Every pixel outside that rectangle must be fully transparent. Do not stretch the artwork. Return a transparent PNG.`;
}

/** 从真实 PNG 解析实际 Provider 画布，不能用请求值伪造返回尺寸。 */
async function decodedPngDimensions(
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

/**
 * 把单调时钟差转换为可持久化的正整数毫秒。
 * 极快的测试替身也至少记为 1ms，避免后续吞吐计算出现除零；该值不包含数据库写入时间。
 */
function elapsedProviderMs(startedAt: number): number {
  return Math.max(1, Math.ceil(performance.now() - startedAt));
}

function classifyModelError(error: unknown): string {
  if (
    error instanceof Error &&
    (error.message.startsWith("IMAGE_PAYLOAD_") ||
      error.message === "IMAGE_TARGET_GEOMETRY_INVALID")
  ) {
    return error.message;
  }
  return "MODEL_PROVIDER_REQUEST_FAILED";
}
