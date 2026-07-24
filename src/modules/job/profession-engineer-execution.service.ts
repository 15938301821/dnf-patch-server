/**
 * @fileoverview 编排 Profession 单技能 Engineer structured 模型、受限 style plan 正规化、私有 JSON
 * Artifact 持久化和恢复；不生成图片、不调用本机工具，也不暴露 HTTP 路由。
 * @module modules/job/profession-engineer-execution-service
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：公开 ProfessionExecutionService 先调用本内部 Service，只有返回 passed 才可继续 Artist；
 * 本 Service 下游调用固定 OpenAI engineer 角色、模型执行 Repository 和对象存储端口。
 * 输入输出：输入仍是当前 Job 的四字段 lease DTO；输出为 in-progress 或严格 plan 与脱敏 Artifact
 * 证据。副作用包括一次受 pre-egress guard 保护的模型调用、私有对象写入和事务状态转换。
 * 安全边界：Worker 不能选择 stage/schema/model/key；模型只返回受限决策，Server 固定注入几何、
 * alpha 与五项 false 安全策略。重复 egress 禁止，恢复只接受确定性 key、完整 SHA 和 canonical JSON。
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
  ObjectStoragePort,
  ObjectStorageVerifiedBytes,
} from "../../common/storage/object-storage.client.js";
import { OBJECT_STORAGE_PORT } from "../../common/storage/object-storage.tokens.js";
import {
  ARTIFACT_UPLOAD_OPTIONS,
  type ArtifactUploadOptions,
} from "../artifact/artifact.tokens.js";
import type {
  ModelEgressGuard,
  StructuredModelRequest,
  StructuredModelResult,
} from "../openai/openai.contracts.js";
import { OpenAiService } from "../openai/openai.service.js";
import {
  createProfessionEngineerStylePlan,
  encodeProfessionEngineerStylePlan,
  maxProfessionEngineerPlanBytes,
  parseProfessionEngineerStylePlanBytes,
  type EncodedProfessionEngineerStylePlan,
  type ProfessionEngineerModelDecision,
  type ProfessionEngineerStylePlan,
} from "./profession-engineer-plan.js";
import {
  assertStoredPlanEvidence,
  createEngineerModelRequest,
  engineerPlanMediaType,
  engineerPlanObjectKey,
  throwEngineerPersistenceUnavailable,
  throwEngineerReservationFailure,
  throwEngineerStateConflict,
} from "./profession-engineer-execution.support.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import {
  professionEngineerPlanStage,
  type FinalizeProfessionModelOutputInput,
  type ProfessionModelOutputEvidence,
  type ReserveProfessionModelExecutionResult,
} from "./profession-model-execution.js";
import { ProfessionModelExecutionRepository } from "./profession-model-execution.repository.js";

/** 主编排 Service 消费的 Engineer 结果；passed 同时绑定 plan 正文与持久化 Artifact 摘要。 */
export type ProfessionEngineerExecutionResult =
  | { status: "in-progress"; executionId: string }
  | {
      status: "passed";
      executionId: string;
      modelCallId: string;
      outputArtifactId: string;
      byteLength: number;
      sha256: string;
      plan: ProfessionEngineerStylePlan;
    };

interface EngineerExecutionRepositoryPort {
  reserveProfessionSkillModelExecution(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: typeof professionEngineerPlanStage,
  ): Promise<ReserveProfessionModelExecutionResult>;
  bindProfessionModelCallBeforeEgress(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: typeof professionEngineerPlanStage,
    modelCallId: string,
  ): Promise<"accepted" | "rejected">;
  prepareProfessionModelOutputPersistence(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: typeof professionEngineerPlanStage,
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
    stage: typeof professionEngineerPlanStage,
    errorCode: string,
    indeterminate: boolean,
    modelCallId?: string,
  ): Promise<boolean>;
}

interface FixedEngineerModelPort {
  structured(
    request: StructuredModelRequest<ProfessionEngineerModelDecision>,
    beforeEgress?: ModelEgressGuard,
  ): Promise<StructuredModelResult<ProfessionEngineerModelDecision>>;
}

/** 仅由主 Profession 编排调用的 Engineer 业务 Service，不注册额外 Controller。 */
@Injectable()
export class ProfessionEngineerExecutionService {
  constructor(
    @Inject(ProfessionModelExecutionRepository)
    private readonly executions: EngineerExecutionRepositoryPort,
    @Inject(OpenAiService) private readonly models: FixedEngineerModelPort,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
    @Inject(ARTIFACT_UPLOAD_OPTIONS)
    private readonly artifactOptions: ArtifactUploadOptions,
  ) {}

  /**
   * 获取或执行当前 attempt 的 Engineer plan；只有本方法的 passed 结果可解锁 Artist reservation。
   * @param jobId URL 中已校验的 Profession Job UUID。
   * @param input 当前 Worker claim 的精确 lease/attempt/skill DTO，不能携带 stage 或模型参数。
   * @returns in-progress，或已按对象证据恢复/持久化的严格 plan 与 Artifact 标识。
   * @throws 稳定 Nest 异常表示 lease、模型、配额、对象或执行状态失败；异常后不得调用 Artist。
   */
  async executeSkill(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
  ): Promise<ProfessionEngineerExecutionResult> {
    const reservation =
      await this.executions.reserveProfessionSkillModelExecution(
        jobId,
        input,
        professionEngineerPlanStage,
      );
    if (reservation.status === "in-progress") return reservation;
    if (reservation.status === "passed") {
      if (reservation.stage !== professionEngineerPlanStage) {
        throwEngineerStateConflict();
      }
      const plan = await this.readPersistedPlan(reservation);
      return {
        status: "passed",
        executionId: reservation.executionId,
        modelCallId: reservation.modelCallId,
        outputArtifactId: reservation.outputArtifactId,
        byteLength: reservation.outputByteLength,
        sha256: reservation.outputSha256.toUpperCase(),
        plan,
      };
    }
    if (reservation.status === "persistence-pending") {
      return this.recoverPersistence(input, reservation);
    }
    if (reservation.status !== "execute") {
      throwEngineerReservationFailure(reservation);
    }

    // 模型出站前由 Repository 消费唯一 egress 权；guard 拒绝时 Provider 不会被调用。
    const result = await this.models.structured(
      createEngineerModelRequest(reservation.context),
      async (record) =>
        this.executions.bindProfessionModelCallBeforeEgress(
          reservation.executionId,
          input,
          professionEngineerPlanStage,
          record.id,
        ),
    );
    if (!result.value || result.record.status !== "passed") {
      await this.failModelExecution(
        reservation.executionId,
        input,
        result.record.errorCode ?? "PROFESSION_ENGINEER_MODEL_CALL_FAILED",
        result.record.id,
      );
      throw new ServiceUnavailableException({
        code: "PROFESSION_ENGINEER_MODEL_CALL_FAILED",
        message: "固定 Engineer 模型步骤未能完成。",
      });
    }

    let encoded: EncodedProfessionEngineerStylePlan;
    try {
      encoded = encodeProfessionEngineerStylePlan(
        createProfessionEngineerStylePlan(result.value),
      );
    } catch {
      await this.failModelExecution(
        reservation.executionId,
        input,
        "PROFESSION_ENGINEER_PLAN_INVALID",
        result.record.id,
      );
      throw new ConflictException({
        code: "PROFESSION_ENGINEER_PLAN_INVALID",
        message: "Engineer 输出不能正规化为受限像素计划。",
      });
    }
    const evidence: ProfessionModelOutputEvidence = {
      modelCallId: result.record.id,
      outputSha256: encoded.sha256,
      outputByteLength: encoded.byteLength,
    };
    await this.preparePersistence(reservation.executionId, input, evidence);

    try {
      const stored = await this.storage.write({
        objectKey: engineerPlanObjectKey(reservation.executionId),
        mediaType: engineerPlanMediaType,
        bytes: encoded.bytes,
        sha256: encoded.sha256,
      });
      assertStoredPlanEvidence(
        stored,
        reservation.executionId,
        encoded.byteLength,
        encoded.sha256,
      );
    } catch {
      throwEngineerPersistenceUnavailable();
    }
    return this.finalize(
      input,
      reservation.executionId,
      evidence,
      encoded.plan,
    );
  }

  private async recoverPersistence(
    input: RequestProfessionSkillExecutionInput,
    reservation: Extract<
      ReserveProfessionModelExecutionResult,
      { status: "persistence-pending" }
    >,
  ): Promise<ProfessionEngineerExecutionResult> {
    const plan = await this.readPersistedPlan(reservation);
    return this.finalize(input, reservation.executionId, reservation, plan);
  }

  /** 只从确定性 key 读取完整 canonical JSON；Artifact 元数据不提供任意对象定位。 */
  private async readPersistedPlan(evidence: {
    executionId: string;
    outputByteLength: number;
    outputSha256: string;
  }): Promise<ProfessionEngineerStylePlan> {
    let stored: ObjectStorageVerifiedBytes;
    try {
      stored = await this.storage.readVerifiedBytes({
        objectKey: engineerPlanObjectKey(evidence.executionId),
        expectedMediaType: engineerPlanMediaType,
        expectedByteLength: evidence.outputByteLength,
        expectedSha256: evidence.outputSha256,
        maxByteLength: maxProfessionEngineerPlanBytes,
      });
      assertStoredPlanEvidence(
        stored,
        evidence.executionId,
        evidence.outputByteLength,
        evidence.outputSha256,
      );
      const plan = parseProfessionEngineerStylePlanBytes(stored.bytes);
      const canonical = encodeProfessionEngineerStylePlan(plan);
      if (
        canonical.byteLength !== stored.byteLength ||
        canonical.sha256 !== stored.sha256 ||
        !Buffer.from(canonical.bytes).equals(Buffer.from(stored.bytes))
      ) {
        throw new Error("PROFESSION_ENGINEER_PLAN_NOT_CANONICAL");
      }
      return plan;
    } catch {
      throwEngineerPersistenceUnavailable();
    }
  }

  private async preparePersistence(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    evidence: ProfessionModelOutputEvidence,
  ): Promise<void> {
    const prepared =
      await this.executions.prepareProfessionModelOutputPersistence(
        executionId,
        input,
        professionEngineerPlanStage,
        evidence,
        this.artifactOptions.maxRunBytes,
      );
    if (prepared === "run-quota-exceeded") {
      await this.failModelExecution(
        executionId,
        input,
        "PROFESSION_ENGINEER_PLAN_RUN_QUOTA_EXCEEDED",
        evidence.modelCallId,
      );
      throw new PayloadTooLargeException({
        code: "ARTIFACT_RUN_QUOTA_EXCEEDED",
        message: "当前 Run 的对象容量配额不足。",
      });
    }
    if (prepared !== "accepted") {
      await this.executions.failProfessionModelExecution(
        executionId,
        input,
        professionEngineerPlanStage,
        "PROFESSION_ENGINEER_PERSISTENCE_STATE_CONFLICT",
        true,
        evidence.modelCallId,
      );
      throwEngineerStateConflict();
    }
  }

  private async finalize(
    input: RequestProfessionSkillExecutionInput,
    executionId: string,
    evidence: ProfessionModelOutputEvidence,
    plan: ProfessionEngineerStylePlan,
  ): Promise<ProfessionEngineerExecutionResult> {
    const artifactId = randomUUID();
    const finalized = await this.executions.finalizeProfessionModelOutput(
      executionId,
      input,
      {
        ...evidence,
        stage: professionEngineerPlanStage,
        artifactId,
        storageKey: engineerPlanObjectKey(executionId),
        mediaType: engineerPlanMediaType,
        logicalName: `engineer-plan-${input.skillId}.json`,
      },
    );
    if (finalized !== "accepted") throwEngineerStateConflict();
    return {
      status: "passed",
      executionId,
      modelCallId: evidence.modelCallId,
      outputArtifactId: artifactId,
      byteLength: evidence.outputByteLength,
      sha256: evidence.outputSha256.toUpperCase(),
      plan,
    };
  }

  private async failModelExecution(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    errorCode: string,
    modelCallId: string,
  ): Promise<void> {
    if (
      !(await this.executions.failProfessionModelExecution(
        executionId,
        input,
        professionEngineerPlanStage,
        errorCode,
        false,
        modelCallId,
      ))
    ) {
      throwEngineerStateConflict();
    }
  }
}
