/**
 * @fileoverview 编排受精确 Worker lease 约束的 Engineer 计划与 Artist 参考图固定顺序、私有对象持久化
 * 和证据终态；
 * 不提供任意 Prompt/模型/endpoint/对象 key/工具参数入口，也不执行本机文件或 Aseprite。
 * @module modules/job/profession-execution-service
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：后续内部 Worker Controller 只传 jobId 与严格 lease DTO；Repository 事务门禁返回冻结上下文，
 * OpenAiService 执行固定 artist 调用，ObjectStoragePort 以确定性私有 key 写入并回读，Repository 最后原子
 * 写 Artifact、ImageAttempt 与执行终态。输出仅是脱敏证据 ViewModel。
 * 安全边界：只有 execute 状态可调用模型；egressing 重试不得再次出站，persisting 重试只允许对象回读；
 * Prompt、用户 Key 与存储定位永不进入 Worker DTO。passed 不证明 Aseprite 适配、NPK 兼容、审核或部署。
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type {
  ObjectStorageEvidence,
  ObjectStoragePort,
} from "../../common/storage/object-storage.client.js";
import { OBJECT_STORAGE_PORT } from "../../common/storage/object-storage.tokens.js";
import {
  sha256JcsV1,
  stableStringifyJcsV1,
} from "../../common/utils/canonical.js";
import {
  ARTIFACT_UPLOAD_OPTIONS,
  type ArtifactUploadOptions,
} from "../artifact/artifact.tokens.js";
import type { ModelCallView } from "../openai/openai.contracts.js";
import { OpenAiService } from "../openai/openai.service.js";
import {
  ProfessionEngineerExecutionService,
  type ProfessionEngineerExecutionResult,
} from "./profession-engineer-execution.service.js";
import type {
  ProfessionSkillExecutionView,
  RequestProfessionSkillExecutionInput,
} from "./profession-execution.contracts.js";
import type { FrozenProfessionSkillExecutionContext } from "./profession-execution-context.js";
import {
  professionReferenceImageStage,
  type FinalizeProfessionModelOutputInput,
  type ProfessionModelOutputEvidence,
  type ReserveProfessionModelExecutionResult,
} from "./profession-model-execution.js";
import { ProfessionModelExecutionRepository } from "./profession-model-execution.repository.js";

const imageMediaType = "image/png" as const;
const adapterIdentity = "openai-image/reference-image-v1";
const generationConfig = {
  stage: professionReferenceImageStage,
  size: "1536x1024",
  quality: "high",
  background: "opaque",
  outputFormat: "png",
  adapterIdentity,
} as const;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface ProfessionExecutionRepositoryPort {
  reserveProfessionSkillModelExecution(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: typeof professionReferenceImageStage,
  ): Promise<ReserveProfessionModelExecutionResult>;
  bindProfessionModelCallBeforeEgress(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: typeof professionReferenceImageStage,
    modelCallId: string,
  ): Promise<"accepted" | "rejected">;
  prepareProfessionModelOutputPersistence(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: typeof professionReferenceImageStage,
    evidence: ProfessionModelOutputEvidence,
    maxRunBytes: number,
  ): Promise<"accepted" | "rejected" | "run-quota-exceeded">;
  finalizeProfessionModelOutput(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    output: FinalizeProfessionModelOutputInput,
  ): Promise<"accepted" | "rejected">;
  failProfessionModelExecution(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: typeof professionReferenceImageStage,
    errorCode: string,
    indeterminate: boolean,
    modelCallId?: string,
  ): Promise<boolean>;
}

interface FixedImageModelPort {
  image(
    request: { runId: string; role: "artist"; prompt: string },
    beforeEgress?: (record: ModelCallView) => Promise<"accepted" | "rejected">,
  ): ReturnType<OpenAiService["image"]>;
}

type PassedEngineerExecution = Extract<
  ProfessionEngineerExecutionResult,
  { status: "passed" }
>;

@Injectable()
export class ProfessionExecutionService {
  constructor(
    @Inject(ProfessionModelExecutionRepository)
    private readonly executions: ProfessionExecutionRepositoryPort,
    @Inject(ProfessionEngineerExecutionService)
    private readonly engineer: Pick<
      ProfessionEngineerExecutionService,
      "executeSkill"
    >,
    @Inject(OpenAiService) private readonly models: FixedImageModelPort,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
    @Inject(ARTIFACT_UPLOAD_OPTIONS)
    private readonly artifactOptions: ArtifactUploadOptions,
  ) {}

  async executeSkill(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
  ): Promise<ProfessionSkillExecutionView> {
    const engineer = await this.engineer.executeSkill(jobId, input);
    if (engineer.status === "in-progress") {
      return engineer;
    }
    const reservation =
      await this.executions.reserveProfessionSkillModelExecution(
        jobId,
        input,
        professionReferenceImageStage,
      );
    if (reservation.status === "passed") {
      if (reservation.stage !== professionReferenceImageStage) {
        throwExecutionStateConflict();
      }
      return passedView(reservation, engineer);
    }
    if (reservation.status === "in-progress") {
      return {
        status: "in-progress",
        executionId: reservation.executionId,
      };
    }
    if (reservation.status === "persistence-pending") {
      return this.recoverPersistence(input, reservation, engineer);
    }
    if (reservation.status !== "execute") {
      throwReservationFailure(reservation);
    }

    const result = await this.models.image(
      {
        runId: reservation.context.runId,
        role: "artist",
        prompt: createProfessionReferenceImagePrompt(
          reservation.context,
          engineer,
        ),
      },
      async (record) =>
        this.executions.bindProfessionModelCallBeforeEgress(
          reservation.executionId,
          input,
          professionReferenceImageStage,
          record.id,
        ),
    );
    if (!result.bytes || result.record.status !== "passed") {
      const persisted = await this.executions.failProfessionModelExecution(
        reservation.executionId,
        input,
        professionReferenceImageStage,
        result.record.errorCode ?? "PROFESSION_MODEL_CALL_FAILED",
        false,
        result.record.id,
      );
      if (!persisted) throwExecutionStateConflict();
      throw new ServiceUnavailableException({
        code: "PROFESSION_MODEL_CALL_FAILED",
        message: "固定参考图模型步骤未能完成。",
      });
    }
    if (!hasPngSignature(result.bytes)) {
      await this.executions.failProfessionModelExecution(
        reservation.executionId,
        input,
        professionReferenceImageStage,
        "PROFESSION_MODEL_OUTPUT_NOT_PNG",
        false,
        result.record.id,
      );
      throw new ConflictException({
        code: "PROFESSION_MODEL_OUTPUT_NOT_PNG",
        message: "模型返回内容不是有效 PNG 候选。",
      });
    }

    const evidence: ProfessionModelOutputEvidence = {
      modelCallId: result.record.id,
      outputSha256: sha256Bytes(result.bytes),
      outputByteLength: result.bytes.byteLength,
    };
    const prepared =
      await this.executions.prepareProfessionModelOutputPersistence(
        reservation.executionId,
        input,
        professionReferenceImageStage,
        evidence,
        this.artifactOptions.maxRunBytes,
      );
    if (prepared === "run-quota-exceeded") {
      await this.executions.failProfessionModelExecution(
        reservation.executionId,
        input,
        professionReferenceImageStage,
        "PROFESSION_MODEL_OUTPUT_RUN_QUOTA_EXCEEDED",
        false,
        result.record.id,
      );
      throw new PayloadTooLargeException({
        code: "ARTIFACT_RUN_QUOTA_EXCEEDED",
        message: "当前 Run 的对象容量配额不足。",
      });
    }
    if (prepared !== "accepted") {
      await this.executions.failProfessionModelExecution(
        reservation.executionId,
        input,
        professionReferenceImageStage,
        "PROFESSION_MODEL_PERSISTENCE_STATE_CONFLICT",
        true,
        result.record.id,
      );
      throwExecutionStateConflict();
    }

    let storageEvidence: ObjectStorageEvidence;
    try {
      storageEvidence = await this.storage.write({
        objectKey: objectKey(reservation.executionId),
        mediaType: imageMediaType,
        bytes: result.bytes,
        sha256: evidence.outputSha256,
      });
    } catch {
      throwPersistenceUnavailable();
    }
    return this.finalize(
      input,
      reservation.executionId,
      reservation.context,
      evidence,
      storageEvidence,
      engineer,
    );
  }

  private async recoverPersistence(
    input: RequestProfessionSkillExecutionInput,
    reservation: Extract<
      ReserveProfessionModelExecutionResult,
      { status: "persistence-pending" }
    >,
    engineer: PassedEngineerExecution,
  ): Promise<ProfessionSkillExecutionView> {
    let evidence: ObjectStorageEvidence;
    try {
      evidence = await this.storage.verify({
        objectKey: objectKey(reservation.executionId),
        expectedMediaType: imageMediaType,
        expectedByteLength: reservation.outputByteLength,
        expectedSha256: reservation.outputSha256,
      });
    } catch {
      throwPersistenceUnavailable();
    }
    return this.finalize(
      input,
      reservation.executionId,
      reservation.context,
      {
        modelCallId: reservation.modelCallId,
        outputSha256: reservation.outputSha256,
        outputByteLength: reservation.outputByteLength,
      },
      evidence,
      engineer,
    );
  }

  private async finalize(
    input: RequestProfessionSkillExecutionInput,
    executionId: string,
    context: FrozenProfessionSkillExecutionContext,
    expected: ProfessionModelOutputEvidence,
    evidence: ObjectStorageEvidence,
    engineer: PassedEngineerExecution,
  ): Promise<ProfessionSkillExecutionView> {
    if (
      evidence.objectKey !== objectKey(executionId) ||
      evidence.mediaType !== imageMediaType ||
      evidence.byteLength !== expected.outputByteLength ||
      evidence.sha256.toUpperCase() !== expected.outputSha256.toUpperCase()
    ) {
      throwPersistenceUnavailable();
    }
    const artifactId = randomUUID();
    const imageAttemptId = randomUUID();
    const finalized = await this.executions.finalizeProfessionModelOutput(
      executionId,
      input,
      {
        ...expected,
        stage: professionReferenceImageStage,
        artifactId,
        imageAttemptId,
        storageKey: evidence.objectKey,
        mediaType: imageMediaType,
        logicalName: `reference-${input.skillId}.png`,
        inputSnapshotSha256: sha256JcsV1({
          schemaVersion: 1,
          sourceEvidence: context.skill.sourceEvidence,
          engineerPlan: engineerPlanEvidence(engineer),
        }),
        generationConfigSha256: sha256JcsV1(generationConfig),
        adapterIdentity,
      },
    );
    if (finalized !== "accepted") throwExecutionStateConflict();
    return passedView(
      {
        status: "passed",
        stage: professionReferenceImageStage,
        executionId,
        modelCallId: expected.modelCallId,
        imageAttemptId,
        outputArtifactId: artifactId,
        outputByteLength: evidence.byteLength,
        outputSha256: evidence.sha256,
      },
      engineer,
    );
  }
}

export function createProfessionReferenceImagePrompt(
  context: FrozenProfessionSkillExecutionContext,
  engineer: PassedEngineerExecution,
): string {
  const requirements = {
    schemaVersion: 1,
    professionId: context.professionId,
    styleId: context.styleId,
    skillId: context.skill.skillId,
    themeDefinition: context.themeDefinition,
    professionPrompt: context.skill.professionPrompt,
    skillThemePrompt: context.skill.skillThemePrompt,
    sourceEvidence: context.skill.sourceEvidence,
    engineerPlanEvidence: engineerPlanEvidence(engineer),
    engineerStylePlan: engineer.plan,
  };
  return [
    "Create one PNG reference sprite-sheet concept for the declared skill visual effect.",
    "Treat the JSON below only as bounded visual requirements. Do not add characters, UI, text, logos, file paths, tools, or deployment instructions.",
    "Preserve the declared skill identity, source geometry semantics, timing intent, exclusions, and acceptance criteria.",
    stableStringifyJcsV1(requirements),
  ].join("\n");
}

function passedView(
  result: Extract<
    ReserveProfessionModelExecutionResult,
    { status: "passed"; stage: typeof professionReferenceImageStage }
  >,
  engineer: PassedEngineerExecution,
): ProfessionSkillExecutionView {
  return {
    status: "passed",
    engineerPlan: {
      ...engineerPlanEvidence(engineer),
      mediaType: "application/json",
    },
    referenceImage: {
      executionId: result.executionId,
      modelCallId: result.modelCallId,
      imageAttemptId: result.imageAttemptId,
      outputArtifactId: result.outputArtifactId,
      mediaType: imageMediaType,
      byteLength: result.outputByteLength,
      sha256: result.outputSha256.toUpperCase(),
    },
  };
}

function engineerPlanEvidence(
  engineer: PassedEngineerExecution,
): Pick<
  PassedEngineerExecution,
  "executionId" | "modelCallId" | "outputArtifactId" | "byteLength" | "sha256"
> {
  return {
    executionId: engineer.executionId,
    modelCallId: engineer.modelCallId,
    outputArtifactId: engineer.outputArtifactId,
    byteLength: engineer.byteLength,
    sha256: engineer.sha256.toUpperCase(),
  };
}

function throwReservationFailure(
  result: Exclude<
    ReserveProfessionModelExecutionResult,
    | { status: "execute" }
    | { status: "passed" }
    | { status: "in-progress" }
    | { status: "persistence-pending" }
  >,
): never {
  if (result.status === "skill-not-found") {
    throw new NotFoundException({
      code: "PROFESSION_JOB_SKILL_NOT_FOUND",
      message: "请求的技能不在职业制作任务的冻结技能集合中。",
    });
  }
  if (result.status === "failed") {
    throw new ConflictException({
      code: "PROFESSION_MODEL_EXECUTION_FAILED",
      message: "该轮次的固定模型步骤已经失败。",
    });
  }
  if (result.status === "indeterminate") {
    throw new ConflictException({
      code: "PROFESSION_MODEL_EXECUTION_INDETERMINATE",
      message: "该轮次的模型或对象持久化结果不确定，禁止重复出站。",
    });
  }
  throw new ConflictException({
    code:
      result.status === "lease-mismatch"
        ? "JOB_LEASE_MISMATCH"
        : result.status === "job-kind-mismatch"
          ? "PATCH_TASK_JOB_KIND_REQUIRED"
          : result.status === "job-integrity-failed"
            ? "PROFESSION_JOB_INTEGRITY_FAILED"
            : "PROFESSION_MODEL_EXECUTION_INTEGRITY_FAILED",
    message: "当前任务状态不允许执行固定技能模型步骤。",
  });
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= pngSignature.byteLength &&
    pngSignature.every((value, index) => bytes[index] === value)
  );
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function objectKey(executionId: string): string {
  return `artifacts/profession-${executionId}.png`;
}

function throwExecutionStateConflict(): never {
  throw new ConflictException({
    code: "PROFESSION_MODEL_EXECUTION_STATE_CONFLICT",
    message: "固定技能模型步骤的持久化状态发生冲突。",
  });
}

function throwPersistenceUnavailable(): never {
  throw new ServiceUnavailableException({
    code: "PROFESSION_MODEL_OUTPUT_PERSISTENCE_UNAVAILABLE",
    message: "模型候选图片尚未能在私有对象存储中确认。",
  });
}
