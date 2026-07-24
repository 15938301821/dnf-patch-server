/**
 * @fileoverview 持久化单技能 Profession 固定模型步骤的幂等状态与最终证据；不调用模型、
 * 不写对象正文，也不把候选参考图视为可直接替换的运行时技能帧。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：PatchTaskRepository 保留公开 provider API 并委托本文件；ProfessionExecutionService
 * 在模型出站前后依次调用这些事务函数。输入为已校验 lease/技能身份和 Server 生成的证据标识，
 * 输出为有限状态；副作用仅发生在调用函数建立的数据库 transaction 内。
 * 安全边界：Job -> execution -> Run 的锁顺序、精确 lease fencing、唯一出站权、Run 总字节配额
 * 与 Artifact/ImageAttempt/execution 三表原子写入不得绕过；崩溃后的不确定执行不能自动重试模型。
 */
import { and, eq, gt, sql } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import {
  artifacts,
  imageAttempts,
  jobs,
  modelCalls,
  runs,
} from "../../common/db/schema.js";
import { professionSkillModelExecutions } from "../../common/db/profession-model-execution-schema.js";
import { databaseNow } from "./job-run-event.repository-support.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import {
  resolveProfessionExecutionContext,
  type ResolveProfessionExecutionContextResult,
} from "./profession-execution-context.js";
import {
  classifyProfessionModelExecution,
  professionEngineerPlanStage,
  professionReferenceImageStage,
  type FinalizeProfessionModelOutputInput,
  type ProfessionModelExecutionIdentity,
  type ProfessionModelExecutionStage,
  type ProfessionModelOutputEvidence,
  type ReserveProfessionModelExecutionResult,
} from "./profession-model-execution.js";
import { lockedProfessionModelExecution } from "./profession-model-execution-lock.repository-support.js";

/** 锁定 Job，并按数据库时间解析当前 lease 对应的冻结单技能上下文。 */
export async function resolveProfessionSkillExecution(
  connection: DatabaseService,
  jobId: string,
  input: RequestProfessionSkillExecutionInput,
): Promise<ResolveProfessionExecutionContextResult> {
  return connection.database.transaction(async (transaction) => {
    const [job] = await transaction
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)
      .for("update");
    if (!job) return { status: "lease-mismatch" };
    const now = await databaseNow(transaction);
    return resolveProfessionExecutionContext(job, input, now);
  });
}

/** 原子创建或复用执行记录，并只允许 prepared 状态消费一次模型出站权。 */
export async function reserveProfessionSkillModelExecution(
  connection: DatabaseService,
  jobId: string,
  input: RequestProfessionSkillExecutionInput,
  stage: ProfessionModelExecutionStage,
): Promise<ReserveProfessionModelExecutionResult> {
  return connection.database.transaction(async (transaction) => {
    const [job] = await transaction
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)
      .for("update");
    if (!job) return { status: "lease-mismatch" };
    const now = await databaseNow(transaction);
    const gate = resolveProfessionExecutionContext(job, input, now);
    if (gate.status !== "accepted") return gate;
    const identity: ProfessionModelExecutionIdentity = {
      runId: gate.context.runId,
      jobId,
      workerId: input.workerId,
      leaseId: input.leaseId,
      attempt: input.attempt,
      skillId: input.skillId,
      stage,
      promptSha256: gate.context.skill.promptSha256,
    };
    if (stage === professionReferenceImageStage) {
      const [prerequisite] = await transaction
        .select()
        .from(professionSkillModelExecutions)
        .where(
          and(
            eq(professionSkillModelExecutions.jobId, jobId),
            eq(professionSkillModelExecutions.attempt, input.attempt),
            eq(professionSkillModelExecutions.skillId, input.skillId),
            eq(
              professionSkillModelExecutions.stage,
              professionEngineerPlanStage,
            ),
          ),
        )
        .limit(1)
        .for("update");
      if (!prerequisite) return { status: "prerequisite-not-passed" };
      const prerequisiteState = classifyProfessionModelExecution(prerequisite, {
        ...identity,
        stage: professionEngineerPlanStage,
      });
      if (prerequisiteState.status === "execution-integrity-failed") {
        return prerequisiteState;
      }
      if (prerequisiteState.status !== "passed") {
        return { status: "prerequisite-not-passed" };
      }
    }
    const [existing] = await transaction
      .select()
      .from(professionSkillModelExecutions)
      .where(
        and(
          eq(professionSkillModelExecutions.jobId, jobId),
          eq(professionSkillModelExecutions.attempt, input.attempt),
          eq(professionSkillModelExecutions.skillId, input.skillId),
          eq(professionSkillModelExecutions.stage, stage),
        ),
      )
      .limit(1)
      .for("update");
    const executionId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      await transaction.insert(professionSkillModelExecutions).values({
        id: executionId,
        ...identity,
        status: "prepared",
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const state = classifyProfessionModelExecution(existing, identity);
      if (state.status === "persistence-pending") {
        return { ...state, context: gate.context };
      }
      if (state.status !== "acquire") return state;
    }
    const reservation = await transaction
      .update(professionSkillModelExecutions)
      .set({ status: "egressing", updatedAt: now })
      .where(
        and(
          eq(professionSkillModelExecutions.id, executionId),
          eq(professionSkillModelExecutions.status, "prepared"),
        ),
      );
    if (reservation[0].affectedRows !== 1) {
      throw new Error("PROFESSION_MODEL_EXECUTION_RESERVATION_CONFLICT");
    }
    return { status: "execute", executionId, context: gate.context };
  });
}

/** 在模型请求出站前，把同 Run 的 running ModelCall 绑定到唯一 egressing 执行。 */
export async function bindProfessionModelCallBeforeEgress(
  connection: DatabaseService,
  executionId: string,
  input: RequestProfessionSkillExecutionInput,
  stage: ProfessionModelExecutionStage,
  modelCallId: string,
): Promise<"accepted" | "rejected"> {
  return connection.database.transaction(async (transaction) => {
    const locked = await lockedProfessionModelExecution(
      transaction,
      executionId,
      input,
      stage,
    );
    if (!locked || locked.execution.status !== "egressing") {
      return "rejected";
    }
    if (
      locked.execution.modelCallId &&
      locked.execution.modelCallId !== modelCallId
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
      .limit(1);
    if (
      !modelCall ||
      modelCall.runId !== locked.job.runId ||
      modelCall.role !== modelRoleForStage(stage) ||
      modelCall.status !== "running"
    ) {
      return "rejected";
    }
    const update = await transaction
      .update(professionSkillModelExecutions)
      .set({ modelCallId, updatedAt: locked.now })
      .where(
        and(
          eq(professionSkillModelExecutions.id, executionId),
          eq(professionSkillModelExecutions.status, "egressing"),
        ),
      );
    return update[0].affectedRows === 1 ? "accepted" : "rejected";
  });
}

/** 锁定 Run 并计入已持久化、活跃上传和其他模型预留后，保留本次输出字节额度。 */
export async function prepareProfessionModelOutputPersistence(
  connection: DatabaseService,
  executionId: string,
  input: RequestProfessionSkillExecutionInput,
  stage: ProfessionModelExecutionStage,
  evidence: ProfessionModelOutputEvidence,
  maxRunBytes: number,
): Promise<"accepted" | "rejected" | "run-quota-exceeded"> {
  return connection.database.transaction(async (transaction) => {
    const locked = await lockedProfessionModelExecution(
      transaction,
      executionId,
      input,
      stage,
    );
    if (
      !locked ||
      locked.execution.status !== "egressing" ||
      locked.execution.modelCallId !== evidence.modelCallId ||
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
      .limit(1);
    if (
      !modelCall ||
      modelCall.runId !== locked.job.runId ||
      modelCall.role !== modelRoleForStage(stage) ||
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
      .select({ value: sql<string>`coalesce(sum(${artifacts.byteLength}), 0)` })
      .from(artifacts)
      .where(eq(artifacts.runId, locked.job.runId));
    const [uploadSessionTotal] = await transaction
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
    const [reservedTotal] = await transaction
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
    const total =
      numericTotal(artifactTotal?.value) +
      numericTotal(uploadSessionTotal?.value) +
      numericTotal(reservedTotal?.value) +
      evidence.outputByteLength;
    if (total > maxRunBytes) return "run-quota-exceeded";
    const update = await transaction
      .update(professionSkillModelExecutions)
      .set({
        status: "persisting",
        outputSha256: evidence.outputSha256.toUpperCase(),
        outputByteLength: evidence.outputByteLength,
        updatedAt: locked.now,
      })
      .where(
        and(
          eq(professionSkillModelExecutions.id, executionId),
          eq(professionSkillModelExecutions.status, "egressing"),
        ),
      );
    return update[0].affectedRows === 1 ? "accepted" : "rejected";
  });
}

/** 在一个事务内创建 Artifact、ImageAttempt，并把匹配的 persisting 执行终结为 passed。 */
export async function finalizeProfessionModelOutput(
  connection: DatabaseService,
  executionId: string,
  input: RequestProfessionSkillExecutionInput,
  output: FinalizeProfessionModelOutputInput,
): Promise<"accepted" | "rejected"> {
  return connection.database.transaction(async (transaction) => {
    const locked = await lockedProfessionModelExecution(
      transaction,
      executionId,
      input,
      output.stage,
    );
    if (
      !locked ||
      locked.execution.status !== "persisting" ||
      locked.execution.modelCallId !== output.modelCallId ||
      locked.execution.outputSha256?.toUpperCase() !==
        output.outputSha256.toUpperCase() ||
      locked.execution.outputByteLength !== output.outputByteLength
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
      provenance: {
        kind: output.stage,
        jobId: locked.job.id,
        attempt: input.attempt,
        skillId: input.skillId,
        modelCallId: output.modelCallId,
      },
      createdAt: locked.now,
    });
    if (output.stage === professionReferenceImageStage) {
      await transaction.insert(imageAttempts).values({
        id: output.imageAttemptId,
        runId: locked.job.runId,
        modelCallId: output.modelCallId,
        promptSha256: locked.execution.promptSha256.toUpperCase(),
        inputSnapshotSha256: output.inputSnapshotSha256.toUpperCase(),
        generationConfigSha256: output.generationConfigSha256.toUpperCase(),
        adapterIdentity: output.adapterIdentity,
        outputArtifactId: output.artifactId,
        status: "generated",
        directRuntimeUseAllowed: false,
        createdAt: locked.now,
      });
    }
    const update = await transaction
      .update(professionSkillModelExecutions)
      .set({
        status: "passed",
        ...(output.stage === professionReferenceImageStage
          ? { imageAttemptId: output.imageAttemptId }
          : {}),
        outputArtifactId: output.artifactId,
        updatedAt: locked.now,
        finishedAt: locked.now,
      })
      .where(
        and(
          eq(professionSkillModelExecutions.id, executionId),
          eq(professionSkillModelExecutions.status, "persisting"),
        ),
      );
    if (update[0].affectedRows !== 1) {
      throw new Error("PROFESSION_MODEL_EXECUTION_FINALIZE_CONFLICT");
    }
    return "accepted";
  });
}

/** 以 failed 或 indeterminate 终结当前非终态执行，并校验可选 ModelCall 属于同一 Run。 */
export async function failProfessionModelExecution(
  connection: DatabaseService,
  executionId: string,
  input: RequestProfessionSkillExecutionInput,
  stage: ProfessionModelExecutionStage,
  errorCode: string,
  indeterminate: boolean,
  modelCallId?: string,
): Promise<boolean> {
  return connection.database.transaction(async (transaction) => {
    const locked = await lockedProfessionModelExecution(
      transaction,
      executionId,
      input,
      stage,
    );
    if (
      !locked ||
      locked.execution.status === "passed" ||
      locked.execution.status === "failed" ||
      locked.execution.status === "indeterminate"
    ) {
      return false;
    }
    if (
      modelCallId &&
      locked.execution.modelCallId &&
      locked.execution.modelCallId !== modelCallId
    ) {
      return false;
    }
    if (modelCallId) {
      const [modelCall] = await transaction
        .select({ runId: modelCalls.runId, role: modelCalls.role })
        .from(modelCalls)
        .where(eq(modelCalls.id, modelCallId))
        .limit(1);
      if (
        !modelCall ||
        modelCall.runId !== locked.job.runId ||
        modelCall.role !== modelRoleForStage(stage)
      ) {
        return false;
      }
    }
    const update = await transaction
      .update(professionSkillModelExecutions)
      .set({
        status: indeterminate ? "indeterminate" : "failed",
        ...(modelCallId ? { modelCallId } : {}),
        errorCode,
        updatedAt: locked.now,
        finishedAt: locked.now,
        ...(indeterminate
          ? {}
          : { outputSha256: null, outputByteLength: null }),
      })
      .where(eq(professionSkillModelExecutions.id, executionId));
    return update[0].affectedRows === 1;
  });
}

function numericTotal(value: string | number | undefined): number {
  const total = Number(value ?? 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("ARTIFACT_QUOTA_TOTAL_INVALID");
  }
  return total;
}

function modelRoleForStage(
  stage: ProfessionModelExecutionStage,
): "engineer" | "artist" {
  return stage === professionEngineerPlanStage ? "engineer" : "artist";
}
