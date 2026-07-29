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
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  ObjectStorageEvidence,
  ObjectStoragePort,
} from "../../common/storage/object-storage.client.js";
import { OBJECT_STORAGE_PORT } from "../../common/storage/object-storage.tokens.js";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import {
  ARTIFACT_UPLOAD_OPTIONS,
  type ArtifactUploadOptions,
} from "../artifact/artifact.tokens.js";
import type {
  ModelCallView,
  ModelImageInput,
} from "../openai/openai.contracts.js";
import { OpenAiService } from "../openai/openai.service.js";
import { ProfessionEngineerExecutionService } from "./profession-engineer-execution.service.js";
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
import {
  createProfessionReferenceImagePrompt,
  passedView,
  referenceObjectKey,
  referenceResult,
  sha256Bytes,
  throwExecutionStateConflict,
  throwPersistenceUnavailable,
  throwReservationFailure,
} from "./profession-reference-execution.support.js";
import {
  normalizeProfessionReferenceImage,
  professionReferenceImageNormalizationPolicy,
} from "./profession-reference-image.js";

export { createProfessionReferenceImagePrompt } from "./profession-reference-execution.support.js";

const imageMediaType = "image/png" as const;
const adapterIdentity =
  "openai-image/runtime-rgb-reference-v7-plan-v3-alpha-normalized";
const generationConfig = {
  stage: professionReferenceImageStage,
  size: "1536x1024",
  quality: "high",
  background: "transparent",
  outputFormat: "png",
  adapterIdentity,
  alphaNormalization: professionReferenceImageNormalizationPolicy,
} as const;

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
    request: {
      runId: string;
      role: "artist";
      prompt: string;
      sourceImage: ModelImageInput;
    },
    beforeEgress?: (record: ModelCallView) => Promise<"accepted" | "rejected">,
  ): ReturnType<OpenAiService["image"]>;
}

/** Artist V2 内部终态；只有该结果可解锁 Engineer V2。 */
export type ProfessionReferenceExecutionResult =
  | { status: "in-progress"; executionId: string }
  | {
      status: "passed";
      executionId: string;
      modelCallId: string;
      imageAttemptId: string;
      outputArtifactId: string;
      byteLength: number;
      sha256: string;
    };

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
    const reference = await this.executeReference(jobId, input);
    if (reference.status === "in-progress") return reference;
    const engineer = await this.engineer.executeSkill(jobId, input, reference);
    if (engineer.status === "in-progress") return engineer;
    return passedView(reference, engineer);
  }

  private async executeReference(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
  ): Promise<ProfessionReferenceExecutionResult> {
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
      return referenceResult(reservation);
    }
    if (reservation.status === "in-progress") {
      return {
        status: "in-progress",
        executionId: reservation.executionId,
      };
    }
    if (reservation.status === "persistence-pending") {
      return this.recoverPersistence(input, reservation);
    }
    if (reservation.status !== "execute") {
      throwReservationFailure(reservation);
    }

    const sourceImage = await this.readSourceVisualInput(
      reservation.sourceVisualInput,
    );
    const result = await this.models.image(
      {
        runId: reservation.context.runId,
        role: "artist",
        prompt: createProfessionReferenceImagePrompt(reservation.context),
        sourceImage,
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
    const normalized = await normalizeProfessionReferenceImage(result.bytes);
    if (normalized.status !== "accepted") {
      const code =
        normalized.status === "invalid-png"
          ? "PROFESSION_MODEL_OUTPUT_NOT_PNG"
          : "PROFESSION_MODEL_OUTPUT_TRANSPARENCY_INVALID";
      await this.executions.failProfessionModelExecution(
        reservation.executionId,
        input,
        professionReferenceImageStage,
        code,
        false,
        result.record.id,
      );
      throw new ConflictException({
        code,
        message:
          normalized.status === "invalid-png"
            ? "模型返回内容不是有效 PNG 候选。"
            : "模型参考图不满足透明背景与可见特效像素约束。",
      });
    }

    const referenceBytes = normalized.bytes;
    const evidence: ProfessionModelOutputEvidence = {
      modelCallId: result.record.id,
      outputSha256: sha256Bytes(referenceBytes),
      outputByteLength: referenceBytes.byteLength,
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
        objectKey: referenceObjectKey(reservation.executionId),
        mediaType: imageMediaType,
        bytes: referenceBytes,
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
    );
  }

  private async recoverPersistence(
    input: RequestProfessionSkillExecutionInput,
    reservation: Extract<
      ReserveProfessionModelExecutionResult,
      { status: "persistence-pending" }
    >,
  ): Promise<ProfessionReferenceExecutionResult> {
    let evidence: ObjectStorageEvidence;
    try {
      evidence = await this.storage.verify({
        objectKey: referenceObjectKey(reservation.executionId),
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
    );
  }

  private async finalize(
    input: RequestProfessionSkillExecutionInput,
    executionId: string,
    context: FrozenProfessionSkillExecutionContext,
    expected: ProfessionModelOutputEvidence,
    evidence: ObjectStorageEvidence,
  ): Promise<ProfessionReferenceExecutionResult> {
    if (
      evidence.objectKey !== referenceObjectKey(executionId) ||
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
          schemaVersion: 2,
          sourceEvidence: context.skill.sourceEvidence,
          sourceVisualInput: input.sourceVisualInput,
        }),
        generationConfigSha256: sha256JcsV1(generationConfig),
        adapterIdentity,
      },
    );
    if (finalized !== "accepted") throwExecutionStateConflict();
    return referenceResult({
      status: "passed",
      stage: professionReferenceImageStage,
      executionId,
      modelCallId: expected.modelCallId,
      imageAttemptId,
      outputArtifactId: artifactId,
      outputByteLength: evidence.byteLength,
      outputSha256: evidence.sha256,
    });
  }

  private async readSourceVisualInput(
    input: Extract<
      ReserveProfessionModelExecutionResult,
      { status: "execute" }
    >["sourceVisualInput"],
  ): Promise<ModelImageInput> {
    const stored = await this.storage.readVerifiedBytes({
      objectKey: input.objectKey,
      expectedMediaType: input.mediaType,
      expectedByteLength: input.byteLength,
      expectedSha256: input.sha256,
      maxByteLength: 64 * 1024 * 1024,
    });
    return {
      role: "official-source",
      mediaType: "image/png",
      bytes: stored.bytes,
      sha256: stored.sha256.toUpperCase(),
    };
  }
}
