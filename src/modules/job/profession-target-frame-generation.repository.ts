/**
 * @fileoverview 持久化 Profession V6 单帧图片生成状态机；不调用模型、不读写对象正文，也不把
 * 目标 PNG 解释为可直接部署或已兼容客户端。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - 用户要求执行真实数据测试
 *
 * 调用关系：Generation Service 先 reserve；只有 execute 结果可读取官方 PNG 并调用图片模型，
 * OpenAiService 的 beforeEgress 回调再 bind；正规化后依次 preparePersistence、对象写入和 finalize。
 * 输入是已校验的当前 lease、服务端模型证据和目标 PNG 摘要，输出为有限领域状态。
 * 副作用：每个公开方法独立开启短数据库事务，统一按 Job -> target -> ModelCall/Run 的顺序加锁。
 * 安全边界：reserved/egressing 不自动重放模型；persisting 只允许复读确定性对象 key；Artifact、
 * ImageAttempt 与 passed 在同一事务提交。blocked 可保留已绑定 ModelCall，但不能保留候选 PNG 证据。
 */
import { Injectable } from "@nestjs/common";
import { and, eq, gt, sql } from "drizzle-orm";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import { DatabaseService } from "../../common/db/database.service.js";
import { professionSkillFrameTargets } from "../../common/db/profession-frame-target-schema.js";
import {
  artifacts,
  imageAttempts,
  modelCalls,
  runs,
} from "../../common/db/schema.js";
import { professionSkillModelExecutions } from "../../common/db/profession-model-execution-schema.js";
import type { GenerateProfessionTargetFrameInput } from "./profession-target-frame-generation.contracts.js";
import type {
  FinalizeProfessionTargetFrameOutputInput,
  InspectProfessionTargetFrameGenerationResult,
  ProfessionTargetFrameOutputEvidence,
  ReserveProfessionTargetFrameGenerationResult,
} from "./profession-target-frame-generation.js";
import {
  classifyProfessionTargetFrameGeneration as generationStateView,
  lockProfessionTargetFrameGeneration as lockGenerationTarget,
  lockProfessionTargetFrameGenerationById as lockGenerationTargetById,
  professionTargetFrameNumericTotal as numericTotal,
  resolveProfessionTargetFrameGenerationContext as generationContext,
} from "./profession-target-frame-generation.repository-support.js";

@Injectable()
/** 单帧生成的事务所有者；所有公开返回均为有限状态或脱敏证据。 */
export class ProfessionTargetFrameGenerationRepository {
  constructor(private readonly connection: DatabaseService) {}

  /** 无副作用读取当前帧状态和官方PNG声明，供Service在争夺出站权前完成可重试复读。 */
  inspect(
    jobId: string,
    input: GenerateProfessionTargetFrameInput,
  ): Promise<InspectProfessionTargetFrameGenerationResult> {
    return this.connection.database.transaction(async (transaction) => {
      const locked = await lockGenerationTarget(transaction, jobId, input);
      if (locked.status !== "ready") return locked;
      const generation = await generationContext(transaction, locked);
      if (!generation) return { status: "source-frame-not-ready" };
      const existing = generationStateView(locked.target, input);
      return existing.status === "new"
        ? { status: "new", generation }
        : existing.status === "persistence-pending"
          ? { ...existing, generation }
          : existing;
    });
  }

  /** 原子取得一帧唯一模型出站权，或恢复其既有状态。 */
  reserve(
    jobId: string,
    input: GenerateProfessionTargetFrameInput,
  ): Promise<ReserveProfessionTargetFrameGenerationResult> {
    return this.connection.database.transaction(async (transaction) => {
      const locked = await lockGenerationTarget(transaction, jobId, input);
      if (locked.status !== "ready") return locked;
      const generation = await generationContext(transaction, locked);
      if (!generation) return { status: "source-frame-not-ready" };
      const existing = generationStateView(locked.target, input);
      if (existing.status === "new") {
        const updated = await transaction
          .update(professionSkillFrameTargets)
          .set({
            generationStatus: "reserved",
            generationStartedAt: locked.now,
          })
          .where(
            and(
              eq(professionSkillFrameTargets.id, locked.target.id),
              sql`${professionSkillFrameTargets.generationStatus} is null`,
            ),
          );
        if (updated[0].affectedRows !== 1) {
          return { status: "generation-state-conflict" };
        }
        return { status: "execute", generation };
      }
      if (existing.status === "persistence-pending") {
        return { ...existing, generation };
      }
      return existing;
    });
  }

  /** 在Provider网络请求前，把同Run的running Artist ModelCall绑定到reserved目标行。 */
  bindModelCallBeforeEgress(
    jobId: string,
    targetId: string,
    input: GenerateProfessionTargetFrameInput,
    modelCallId: string,
  ): Promise<"accepted" | "rejected"> {
    return this.connection.database.transaction(async (transaction) => {
      const locked = await lockGenerationTargetById(
        transaction,
        jobId,
        targetId,
        input,
      );
      if (
        !locked ||
        locked.target.generationStatus !== "reserved" ||
        locked.target.generationModelCallId !== null
      ) {
        return "rejected";
      }
      const [modelCall] = await transaction
        .select({
          runId: modelCalls.runId,
          role: modelCalls.role,
          status: modelCalls.status,
        })
        .from(modelCalls)
        .where(eq(modelCalls.id, modelCallId))
        .limit(1)
        .for("update");
      if (
        !modelCall ||
        modelCall.runId !== locked.job.runId ||
        modelCall.role !== "artist" ||
        modelCall.status !== "running"
      ) {
        return "rejected";
      }
      const updated = await transaction
        .update(professionSkillFrameTargets)
        .set({
          generationStatus: "egressing",
          generationModelCallId: modelCallId,
        })
        .where(
          and(
            eq(professionSkillFrameTargets.id, targetId),
            eq(professionSkillFrameTargets.generationStatus, "reserved"),
          ),
        );
      return updated[0].affectedRows === 1 ? "accepted" : "rejected";
    });
  }

  /** 锁定Run并计入现有Artifact、活跃上传及两代模型预留后，为目标PNG保留字节额度。 */
  preparePersistence(
    jobId: string,
    targetId: string,
    input: GenerateProfessionTargetFrameInput,
    evidence: ProfessionTargetFrameOutputEvidence,
    maxRunBytes: number,
  ): Promise<"accepted" | "rejected" | "run-quota-exceeded"> {
    return this.connection.database.transaction(async (transaction) => {
      const locked = await lockGenerationTargetById(
        transaction,
        jobId,
        targetId,
        input,
      );
      if (
        !locked ||
        locked.target.generationStatus !== "egressing" ||
        locked.target.generationModelCallId !== evidence.modelCallId ||
        evidence.outputByteLength <= 0
      ) {
        return "rejected";
      }
      const [modelCall] = await transaction
        .select({
          runId: modelCalls.runId,
          role: modelCalls.role,
          status: modelCalls.status,
        })
        .from(modelCalls)
        .where(eq(modelCalls.id, evidence.modelCallId))
        .limit(1)
        .for("update");
      if (
        !modelCall ||
        modelCall.runId !== locked.job.runId ||
        modelCall.role !== "artist" ||
        modelCall.status !== "passed"
      ) {
        return "rejected";
      }
      await transaction
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, locked.job.runId))
        .limit(1)
        .for("update");
      const [artifactTotal] = await transaction
        .select({
          value: sql<string>`coalesce(sum(${artifacts.byteLength}), 0)`,
        })
        .from(artifacts)
        .where(eq(artifacts.runId, locked.job.runId));
      const [uploadTotal] = await transaction
        .select({
          value: sql<string>`coalesce(sum(${artifactUploadSessions.expectedByteLength}), 0)`,
        })
        .from(artifactUploadSessions)
        .where(
          and(
            eq(artifactUploadSessions.runId, locked.job.runId),
            eq(artifactUploadSessions.status, "authorized"),
            gt(artifactUploadSessions.expiresAt, locked.now),
          ),
        );
      const [legacyReservationTotal] = await transaction
        .select({
          value: sql<string>`coalesce(sum(${professionSkillModelExecutions.outputByteLength}), 0)`,
        })
        .from(professionSkillModelExecutions)
        .where(
          and(
            eq(professionSkillModelExecutions.runId, locked.job.runId),
            eq(professionSkillModelExecutions.status, "persisting"),
          ),
        );
      const [targetReservationTotal] = await transaction
        .select({
          value: sql<string>`coalesce(sum(${professionSkillFrameTargets.targetPngByteLength}), 0)`,
        })
        .from(professionSkillFrameTargets)
        .where(
          and(
            eq(professionSkillFrameTargets.runId, locked.job.runId),
            eq(professionSkillFrameTargets.generationStatus, "persisting"),
          ),
        );
      const total =
        numericTotal(artifactTotal?.value) +
        numericTotal(uploadTotal?.value) +
        numericTotal(legacyReservationTotal?.value) +
        numericTotal(targetReservationTotal?.value) +
        evidence.outputByteLength;
      if (!Number.isSafeInteger(maxRunBytes) || total > maxRunBytes) {
        return "run-quota-exceeded";
      }
      const updated = await transaction
        .update(professionSkillFrameTargets)
        .set({
          generationStatus: "persisting",
          targetPngSha256: evidence.outputSha256.toUpperCase(),
          targetPngByteLength: evidence.outputByteLength,
          targetNormalizationAlgorithm: evidence.normalizationAlgorithm,
        })
        .where(
          and(
            eq(professionSkillFrameTargets.id, targetId),
            eq(professionSkillFrameTargets.generationStatus, "egressing"),
          ),
        );
      return updated[0].affectedRows === 1 ? "accepted" : "rejected";
    });
  }

  /** 在单一事务内创建目标Artifact与ImageAttempt，并把匹配的persisting目标终结为passed。 */
  finalize(
    jobId: string,
    targetId: string,
    input: GenerateProfessionTargetFrameInput,
    output: FinalizeProfessionTargetFrameOutputInput,
  ): Promise<"accepted" | "rejected"> {
    return this.connection.database.transaction(async (transaction) => {
      const locked = await lockGenerationTargetById(
        transaction,
        jobId,
        targetId,
        input,
      );
      if (
        !locked ||
        locked.target.generationStatus !== "persisting" ||
        locked.target.generationModelCallId !== output.modelCallId ||
        locked.target.targetPngSha256?.toUpperCase() !==
          output.outputSha256.toUpperCase() ||
        locked.target.targetPngByteLength !== output.outputByteLength ||
        locked.target.targetNormalizationAlgorithm !==
          output.normalizationAlgorithm ||
        output.provenance.runId !== locked.job.runId ||
        output.provenance.jobId !== locked.job.id ||
        output.provenance.modelCallId !== output.modelCallId ||
        output.provenance.imageAttemptId !== output.imageAttemptId
      ) {
        return "rejected";
      }
      await transaction.insert(artifacts).values({
        id: output.artifactId,
        runId: locked.job.runId,
        logicalName: output.logicalName,
        storageKey: output.storageKey,
        mediaType: output.mediaType,
        byteLength: output.outputByteLength,
        sha256: output.outputSha256.toUpperCase(),
        provenance: output.provenance,
        createdAt: locked.now,
      });
      await transaction.insert(imageAttempts).values({
        id: output.imageAttemptId,
        runId: locked.job.runId,
        modelCallId: output.modelCallId,
        promptSha256: output.promptSha256.toUpperCase(),
        inputSnapshotSha256: output.inputSnapshotSha256.toUpperCase(),
        generationConfigSha256: output.generationConfigSha256.toUpperCase(),
        adapterIdentity: output.adapterIdentity,
        outputArtifactId: output.artifactId,
        status: "generated",
        directRuntimeUseAllowed: false,
        createdAt: locked.now,
      });
      const updated = await transaction
        .update(professionSkillFrameTargets)
        .set({
          generationStatus: "passed",
          generationImageAttemptId: output.imageAttemptId,
          targetPngArtifactId: output.artifactId,
          generationFinishedAt: locked.now,
        })
        .where(
          and(
            eq(professionSkillFrameTargets.id, targetId),
            eq(professionSkillFrameTargets.generationStatus, "persisting"),
          ),
        );
      if (updated[0].affectedRows !== 1) {
        throw new Error("PROFESSION_TARGET_FRAME_FINALIZE_CONFLICT");
      }
      return "accepted";
    });
  }

  /** 将当前非终态帧终结为blocked；Provider失败时保留已绑定ModelCall，配置阻断时保持为空。 */
  block(
    jobId: string,
    targetId: string,
    input: GenerateProfessionTargetFrameInput,
    errorCode: string,
    modelCallId?: string,
  ): Promise<boolean> {
    return this.connection.database.transaction(async (transaction) => {
      const locked = await lockGenerationTargetById(
        transaction,
        jobId,
        targetId,
        input,
      );
      if (
        !locked ||
        locked.target.generationStatus === null ||
        locked.target.generationStatus === "passed" ||
        locked.target.generationStatus === "blocked" ||
        !/^[A-Z0-9_]{1,100}$/u.test(errorCode)
      ) {
        return false;
      }
      if (modelCallId && locked.target.generationModelCallId !== modelCallId) {
        return false;
      }
      const updated = await transaction
        .update(professionSkillFrameTargets)
        .set({
          generationStatus: "blocked",
          generationErrorCode: errorCode,
          targetPngSha256: null,
          targetPngByteLength: null,
          targetNormalizationAlgorithm: null,
          generationFinishedAt: locked.now,
        })
        .where(eq(professionSkillFrameTargets.id, targetId));
      return updated[0].affectedRows === 1;
    });
  }
}
