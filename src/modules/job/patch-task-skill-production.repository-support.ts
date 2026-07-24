/**
 * @fileoverview 在一个事务内接收当前 Profession Job attempt 的单技能状态和最终双 Artifact；
 * 不调用模型、不读取对象正文、不执行 Aseprite，也不完成 Job、Run 或主题包终态。
 * @module modules/job/patch-task-skill-production-repository-support
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：PatchTaskRepository 的公开方法委托本文件；下游依次读取 jobs、style_skill_productions、
 * profession_skill_model_executions、来源证据和 artifact_upload_sessions。输入是 Worker token 守卫后
 * 已通过严格 DTO 的状态报告，输出有限接收状态。副作用只发生在调用方数据库 transaction 中。
 * 安全边界：锁顺序固定为 Job -> production -> Engineer/Artist execution -> 两个 upload session；
 * leaseId 是当前 attempt 的唯一 fencing 编号。模型 ID 只能从 Server 执行记录恢复，最终 Artifact
 * 必须由同一 Job/Worker/lease/attempt 的 finalized 会话产生，任一 JSON 或摘要漂移均 fail-closed。
 */
import { and, eq } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { jobs } from "../../common/db/schema.js";
import { styleSkillProductions } from "../../common/db/studio-schema.js";
import { databaseNow } from "./job-run-event.repository-support.js";
import type {
  PatchTaskReportResult,
  ReportPatchTaskSkillProductionInput,
} from "./patch-task.contracts.js";
import {
  resolveProfessionExecutionContext,
  type FrozenProfessionSkillExecutionContext,
} from "./profession-execution-context.js";
import { resolvePassedProductionEvidence } from "./patch-task-skill-production-evidence.repository-support.js";

type Transaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

/**
 * 原子接收一个技能的当前 attempt 状态；passed 分支必须同时封存模型链与双上传会话证据。
 * @param connection 服务进程共享的 Drizzle 数据库入口。
 * @param jobId 内部 Worker 路由中已经校验格式的 Profession Job UUID。
 * @param input 当前 claim 的 Worker/lease/attempt、skill 和互斥状态证据。
 * @returns accepted 或稳定拒绝状态；accepted 不证明 NPK、客户端兼容、审核或部署完成。
 */
export async function reportProfessionSkillProduction(
  connection: DatabaseService,
  jobId: string,
  input: ReportPatchTaskSkillProductionInput,
): Promise<PatchTaskReportResult> {
  return connection.database.transaction(async (transaction) => {
    // 第一步：先锁 Job 并用数据库时间同时核验精确 lease 与冻结 payload，旧 attempt 不得继续写入。
    const [job] = await transaction
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)
      .for("update");
    if (!job) return { status: "lease-mismatch" };
    const now = await databaseNow(transaction);
    const gate = resolveProfessionExecutionContext(job, input, now);
    if (gate.status !== "accepted") {
      switch (gate.status) {
        case "lease-mismatch":
          return { status: "lease-mismatch" };
        case "job-kind-mismatch":
          return { status: "job-kind-mismatch" };
        case "skill-not-found":
          return { status: "skill-production-not-found" };
        case "job-integrity-failed":
          return { status: "skill-production-evidence-mismatch" };
      }
    }

    // 第二步：锁定单技能 production，防止并发终态覆盖；数据库行必须仍属于冻结的 Run/style/source。
    const [production] = await transaction
      .select()
      .from(styleSkillProductions)
      .where(
        and(
          eq(styleSkillProductions.runId, gate.context.runId),
          eq(styleSkillProductions.skillId, input.skillId),
        ),
      )
      .limit(1)
      .for("update");
    if (!production) return { status: "skill-production-not-found" };
    if (isTerminalProduction(production.status)) {
      return { status: "skill-production-terminal" };
    }
    if (!matchesProductionContext(production, gate.context, jobId)) {
      return { status: "skill-production-evidence-mismatch" };
    }

    if (input.status !== "passed") {
      await updateNonPassedProduction(
        transaction,
        production.id,
        jobId,
        input,
        now,
      );
      return { status: "accepted" };
    }

    // 第三步：Worker 不再自报模型 ID；两阶段必须来自当前 attempt 且完整匹配冻结 Prompt 身份。
    const evidence = await resolvePassedProductionEvidence(
      transaction,
      jobId,
      gate.context.runId,
      input,
      gate.context,
    );
    if (evidence.status !== "accepted") return evidence;

    // 第四步：一次写入完整终态；任一字段或外键失败会回滚，不留下“passed 但缺 attempt/upload”的半状态。
    const update = await transaction
      .update(styleSkillProductions)
      .set({
        jobId,
        workerId: input.workerId,
        leaseId: input.leaseId,
        attempt: input.attempt,
        modelCallId: evidence.modelCallId,
        imageAttemptId: evidence.imageAttemptId,
        asepriteProfileId: "aseprite-cli",
        asepriteBinarySha256: input.asepriteBinarySha256.toUpperCase(),
        asepriteAdapterSha256: input.asepriteAdapterSha256.toUpperCase(),
        asepriteArtifactId: evidence.projects.artifactId,
        asepriteUploadId: evidence.projects.uploadId,
        validationArtifactId: evidence.validation.artifactId,
        validationUploadId: evidence.validation.uploadId,
        status: "passed",
        errorCode: null,
        updatedAt: now,
        finishedAt: now,
      })
      .where(eq(styleSkillProductions.id, production.id));
    if (update[0].affectedRows !== 1) {
      throw new Error("STYLE_SKILL_PRODUCTION_UPDATE_CONFLICT");
    }
    return { status: "accepted" };
  });
}

/** 非 passed 状态仍保存当前 fencing 身份；失败/阻断只接受 DTO 中的稳定错误码。 */
async function updateNonPassedProduction(
  transaction: Transaction,
  productionId: string,
  jobId: string,
  input: Exclude<ReportPatchTaskSkillProductionInput, { status: "passed" }>,
  now: Date,
): Promise<void> {
  const terminal = input.status === "failed" || input.status === "blocked";
  const update = await transaction
    .update(styleSkillProductions)
    .set({
      jobId,
      workerId: input.workerId,
      leaseId: input.leaseId,
      attempt: input.attempt,
      status: input.status,
      errorCode: terminal ? input.errorCode : null,
      modelCallId: null,
      imageAttemptId: null,
      asepriteProfileId: null,
      asepriteBinarySha256: null,
      asepriteAdapterSha256: null,
      asepriteArtifactId: null,
      asepriteUploadId: null,
      validationArtifactId: null,
      validationUploadId: null,
      updatedAt: now,
      finishedAt: terminal ? now : null,
    })
    .where(eq(styleSkillProductions.id, productionId));
  if (update[0].affectedRows !== 1) {
    throw new Error("STYLE_SKILL_PRODUCTION_UPDATE_CONFLICT");
  }
}

/** production 的创建期事实必须与当前冻结 Job 一致；既有 jobId 不能被另一个 Job 接管。 */
function matchesProductionContext(
  production: typeof styleSkillProductions.$inferSelect,
  context: FrozenProfessionSkillExecutionContext,
  jobId: string,
): boolean {
  return (
    production.runId === context.runId &&
    production.professionId === context.professionId &&
    production.styleId === context.styleId &&
    production.skillId === context.skill.skillId &&
    production.sourceRunId === context.skill.sourceEvidence.sourceRunId &&
    production.sourceFrameManifestArtifactId ===
      context.skill.sourceEvidence.sourceFrameManifestArtifactId &&
    production.promptSha256.toUpperCase() ===
      context.skill.promptSha256.toUpperCase() &&
    (production.jobId === null || production.jobId === jobId)
  );
}

function isTerminalProduction(status: string): boolean {
  return status === "passed" || status === "failed" || status === "blocked";
}
