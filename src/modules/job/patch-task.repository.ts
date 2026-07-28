/**
 * @fileoverview 持久化浏览器制作任务视图、主题技能生产、最终包记录与用户列表软归档；
 * 不删除 Run、Job、Attempt、Artifact、事件或阶段证据。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 *
 * 调用关系：PatchTaskService 读取任务与写生产结果，PatchTaskArchiveService 调用本 Repository
 * 执行归档事务；下游只访问 Job 领域拥有的 Run、Job 与制作证据表。
 * 输入输出：输入均来自已认证用户或受 Worker lease 约束的 Service，输出是脱敏 ViewModel 或
 * 稳定领域结果，不暴露数据库行锁、对象 key 与凭据。
 * 副作用：创建计划、回填生产证据或在事务内设置 Run.archivedAt；归档不会删除任何审计证据。
 * 安全边界：归档必须按同 Run Jobs -> Run 的顺序加行锁，复核稳定用户所有权，并在任何活动
 * 状态或残留 lease 下失败关闭，防止任务仍执行时从用户视图消失。
 */
import { Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { hasExactJobLease } from "../../common/contracts/index.js";
import { DatabaseService } from "../../common/db/database.service.js";
import { artifacts, jobs, runs } from "../../common/db/schema.js";
import {
  professions,
  professionStyles,
  styleSkillProductions,
} from "../../common/db/studio-schema.js";
import { stylePackages } from "../../common/db/style-package-schema.js";
import type {
  PatchTaskArtifactView,
  PatchTaskDetailView,
  PatchTaskReferenceImageView,
  PatchTaskSkillPreviewRole,
  PatchTaskSkillPreviewView,
  PatchTaskReportResult,
  PatchTaskView,
  PlannedPatchTaskPackage,
  PlannedPatchTaskSkill,
  ReportPatchTaskPackageInput,
  ReportPatchTaskSkillProductionInput,
} from "./patch-task.contracts.js";
import {
  mapPatchTaskProgress,
  mapPatchTaskStatus,
} from "./patch-task-status.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import type { ResolveProfessionExecutionContextResult } from "./profession-execution-context.js";
import { databaseNow } from "./job-run-event.repository-support.js";
import { reportProfessionSkillProduction } from "./patch-task-skill-production.repository-support.js";
import { resolveProfessionSkillExecution as resolveProfessionExecution } from "./profession-model-execution.repository-support.js";
import { resolveProfessionCompletionInTransaction } from "./profession-completion.repository-support.js";
import { findPatchTaskArtifacts } from "./patch-task-artifact.repository-support.js";
import type {
  ProfessionProductionProgressInput,
  ProfessionProductionProgressView,
} from "./profession-production-progress.contracts.js";
import { findPatchTaskDetail } from "./patch-task-detail.repository-support.js";
import { findPatchTaskReferenceImage } from "./patch-task-reference-image.repository-support.js";
import { findPatchTaskSkillPreview } from "./patch-task-reference-image.repository-support.js";

/** 归档命令的稳定持久化结果；Service 据此映射 404、409 或幂等成功。 */
export type PatchTaskArchiveResult = "archived" | "not-found" | "active";

@Injectable()
export class PatchTaskRepository {
  constructor(private readonly connection: DatabaseService) {}

  async createPlan(
    pack: PlannedPatchTaskPackage,
    skills: PlannedPatchTaskSkill[],
    disposition: "dispatch" | "blocked",
  ): Promise<void> {
    const now = new Date();
    await this.connection.database.transaction(async (transaction) => {
      const [run] = await transaction
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, pack.runId))
        .limit(1)
        .for("update");
      if (!run) throw new Error("PATCH_TASK_RUN_NOT_FOUND");
      const [existing] = await transaction
        .select({
          professionId: stylePackages.professionId,
          styleId: stylePackages.styleId,
        })
        .from(stylePackages)
        .where(eq(stylePackages.runId, pack.runId))
        .limit(1)
        .for("update");
      if (existing) {
        if (
          existing.professionId !== pack.professionId ||
          existing.styleId !== pack.styleId
        ) {
          throw new Error("PATCH_TASK_IDEMPOTENCY_PLAN_MISMATCH");
        }
        return;
      }
      await transaction.insert(stylePackages).values({
        id: pack.id,
        professionId: pack.professionId,
        styleId: pack.styleId,
        runId: pack.runId,
        status: disposition === "dispatch" ? "queued" : "blocked",
        createdAt: now,
        updatedAt: now,
        ...(disposition === "blocked" ? { finishedAt: now } : {}),
      });
      await transaction.insert(styleSkillProductions).values(
        skills.map((skill) => ({
          id: crypto.randomUUID(),
          professionId: skill.professionId,
          styleId: skill.styleId,
          skillId: skill.skillId,
          runId: pack.runId,
          sourceRunId: skill.sourceRunId,
          sourceFrameManifestArtifactId: skill.sourceFrameManifestArtifactId,
          promptSha256: skill.promptSha256,
          status: disposition === "dispatch" ? "planned" : "blocked",
          createdAt: now,
          updatedAt: now,
          ...(disposition === "blocked" ? { finishedAt: now } : {}),
        })),
      );
      if (disposition === "blocked") return;
      const activation = await transaction
        .update(jobs)
        .set({ dispatchReadyAt: now, updatedAt: now })
        .where(
          and(
            eq(jobs.runId, pack.runId),
            eq(jobs.kind, "profession"),
            eq(jobs.status, "queued"),
            isNull(jobs.dispatchReadyAt),
          ),
        );
      if (activation[0].affectedRows !== 1) {
        throw new Error("PATCH_TASK_DISPATCH_ACTIVATION_FAILED");
      }
    });
  }

  async list(ownerUserId: string): Promise<PatchTaskView[]> {
    const rows = await this.connection.database
      .select({
        id: runs.id,
        professionName: professions.name,
        styleName: professionStyles.name,
        runStatus: runs.status,
        packageStatus: stylePackages.status,
        createdAt: runs.createdAt,
        packageArtifactId: stylePackages.packageArtifactId,
        artifactName: artifacts.logicalName,
        totalSkills: sql<number>`count(${styleSkillProductions.id})`,
        passedSkills: sql<number>`sum(case when ${styleSkillProductions.status} = 'passed' then 1 else 0 end)`,
      })
      .from(stylePackages)
      .innerJoin(runs, eq(runs.id, stylePackages.runId))
      .innerJoin(professions, eq(professions.id, stylePackages.professionId))
      .innerJoin(
        professionStyles,
        eq(professionStyles.id, stylePackages.styleId),
      )
      .leftJoin(
        artifacts,
        and(
          eq(artifacts.runId, stylePackages.runId),
          eq(artifacts.id, stylePackages.packageArtifactId),
        ),
      )
      .leftJoin(
        styleSkillProductions,
        eq(styleSkillProductions.runId, stylePackages.runId),
      )
      .where(and(eq(runs.ownerUserId, ownerUserId), isNull(runs.archivedAt)))
      .groupBy(
        runs.id,
        professions.name,
        professionStyles.name,
        runs.status,
        stylePackages.status,
        runs.createdAt,
        stylePackages.packageArtifactId,
        artifacts.logicalName,
      )
      .orderBy(asc(runs.createdAt));
    return rows.map((row) => ({
      id: row.id,
      professionName: row.professionName,
      styleName: row.styleName,
      status: mapPatchTaskStatus(row.runStatus, row.packageStatus),
      progress: mapPatchTaskProgress(
        row.totalSkills,
        row.passedSkills,
        row.runStatus,
        row.packageStatus,
      ),
      createdAt: row.createdAt.toISOString(),
      ...(row.artifactName ? { artifactName: row.artifactName } : {}),
      artifactAvailable: row.packageArtifactId !== null,
    }));
  }

  /**
   * 将当前用户拥有的终态制作 Run 从默认列表软归档。
   *
   * transaction（事务）保证同 Run Job 锁、Run 锁和 archivedAt 写入要么一起成功、要么全部回滚。
   * 锁顺序固定为 Jobs 后 Run，与 claim/complete/reaper 一致，避免归档和 Worker 生命周期形成锁顺序
   * 反转。活动 Run、queued/
   * leased Job 或任何残留 lease 字段均返回 active 且零写入；已归档请求返回 archived，保持幂等。
   *
   * @param runId Controller path 中已通过 UUID 校验的 PatchTask Run 标识。
   * @param ownerUserId 浏览器 Access Token 解析出的稳定用户 ID，不能来自 body/query。
   * @returns archived 表示已归档或此前已归档；not-found 合并不存在、非 PatchTask 与跨用户情况；
   * active 表示执行或租约尚未安全收口。
   */
  archive(runId: string, ownerUserId: string): Promise<PatchTaskArchiveResult> {
    return this.connection.database.transaction(async (transaction) => {
      // 第一步：只读定位当前用户的制作 Run；此处不持锁，避免与已先锁 Job 的 Worker 形成反向等待。
      const [visibleRun] = await transaction
        .select({
          id: runs.id,
          archivedAt: runs.archivedAt,
        })
        .from(runs)
        .innerJoin(stylePackages, eq(stylePackages.runId, runs.id))
        .where(and(eq(runs.id, runId), eq(runs.ownerUserId, ownerUserId)))
        .limit(1);
      if (!visibleRun) return "not-found";
      if (visibleRun.archivedAt) return "archived";

      // 第二步：先按稳定 ID 顺序锁定全部 Job，与 Worker 的 Job -> Run 锁顺序保持一致。
      const lockedJobs = await transaction
        .select({
          status: jobs.status,
          leaseOwnerId: jobs.leaseOwnerId,
          leaseId: jobs.leaseId,
          leaseExpiresAt: jobs.leaseExpiresAt,
        })
        .from(jobs)
        .where(eq(jobs.runId, visibleRun.id))
        .orderBy(asc(jobs.id))
        .for("update");
      const hasActiveJob = lockedJobs.some(
        (job) =>
          job.status === "queued" ||
          job.status === "leased" ||
          job.leaseOwnerId !== null ||
          job.leaseId !== null ||
          job.leaseExpiresAt !== null,
      );
      if (lockedJobs.length === 0 || hasActiveJob) {
        return "active";
      }

      // 第三步：Job 集合稳定后锁定并复核 Run；并发 Worker 若正在收口，会先完成 Run 更新再释放锁。
      const [run] = await transaction
        .select({
          id: runs.id,
          status: runs.status,
          archivedAt: runs.archivedAt,
        })
        .from(runs)
        .innerJoin(stylePackages, eq(stylePackages.runId, runs.id))
        .where(
          and(eq(runs.id, visibleRun.id), eq(runs.ownerUserId, ownerUserId)),
        )
        .limit(1)
        .for("update");
      if (!run) return "not-found";
      if (run.archivedAt) return "archived";
      if (run.status === "queued" || run.status === "running") {
        return "active";
      }

      // 第四步：只写可见性时间；限制性外键下的执行、attempt、Artifact 与审计证据全部保留。
      const update = await transaction
        .update(runs)
        .set({ archivedAt: new Date() })
        .where(and(eq(runs.id, run.id), isNull(runs.archivedAt)));
      if (update[0].affectedRows !== 1) {
        throw new Error("PATCH_TASK_ARCHIVE_UPDATE_FAILED");
      }
      return "archived";
    });
  }

  /** 读取当前用户拥有的制作任务详情；跨用户或不存在时返回 undefined，不泄露可见性差异。 */
  findDetail(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskDetailView | undefined> {
    return findPatchTaskDetail(this.connection, runId, ownerUserId);
  }

  /** 按任务与技能固定语义读取当前 attempt 参考图；调用方不能传入任意 Artifact ID。 */
  findReferenceImage(
    runId: string,
    skillId: string,
    ownerUserId: string,
  ): Promise<PatchTaskReferenceImageView | undefined> {
    return findPatchTaskReferenceImage(
      this.connection,
      runId,
      skillId,
      ownerUserId,
    );
  }

  /** 按固定角色读取当前 attempt 的唯一 PNG 证据；不接受 Artifact ID、逻辑名或对象 key。 */
  findSkillPreview(
    runId: string,
    skillId: string,
    role: PatchTaskSkillPreviewRole,
    ownerUserId: string,
  ): Promise<PatchTaskSkillPreviewView | undefined> {
    return findPatchTaskSkillPreview(
      this.connection,
      runId,
      skillId,
      role,
      ownerUserId,
    );
  }

  async findArtifact(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskArtifactView | undefined> {
    return (
      await findPatchTaskArtifacts(this.connection, runId, ownerUserId)
    )?.[0];
  }

  /** 读取当前用户已通过任务的 candidate、manifest 和 validation 三项固定角色元数据。 */
  findArtifacts(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskArtifactView[] | undefined> {
    return findPatchTaskArtifacts(this.connection, runId, ownerUserId);
  }

  async resolveProfessionSkillExecution(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
  ): Promise<ResolveProfessionExecutionContextResult> {
    return resolveProfessionExecution(this.connection, jobId, input);
  }

  /** 在当前精确 lease 下读取冻结顺序的多技能进度，供重领 attempt 跳过既有 passed 技能。 */
  async resolveProfessionProductionProgress(
    jobId: string,
    input: ProfessionProductionProgressInput,
  ): Promise<
    | { status: "accepted"; progress: ProfessionProductionProgressView }
    | {
        status:
          | "lease-mismatch"
          | "job-kind-mismatch"
          | "job-integrity-failed"
          | "production-integrity-failed";
      }
  > {
    return this.connection.database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
        .for("update");
      if (!job) return { status: "lease-mismatch" };
      const now = await databaseNow(transaction);
      if (!hasExactJobLease(job, input, now)) {
        return { status: "lease-mismatch" };
      }
      if (job.kind !== "profession") {
        return { status: "job-kind-mismatch" };
      }
      const result = await resolveProfessionCompletionInTransaction(
        transaction,
        job,
      );
      return result.status === "accepted"
        ? { status: "accepted", progress: result.progress }
        : result;
    });
  }

  async reportSkillProduction(
    jobId: string,
    input: ReportPatchTaskSkillProductionInput,
  ): Promise<PatchTaskReportResult> {
    return reportProfessionSkillProduction(this.connection, jobId, input);
  }

  async reportPackage(
    jobId: string,
    input: ReportPatchTaskPackageInput,
  ): Promise<PatchTaskReportResult> {
    return this.connection.database.transaction(async (transaction) => {
      const lease = await leasedProfessionJob(transaction, jobId, input);
      if (lease.kind !== "accepted") return { status: lease.status };
      const [pack] = await transaction
        .select()
        .from(stylePackages)
        .where(eq(stylePackages.runId, lease.job.runId))
        .limit(1)
        .for("update");
      if (!pack) return { status: "package-not-found" };
      if (isTerminalPackage(pack.status)) return { status: "package-terminal" };
      // V2 只冻结 aseprite-cli；没有封包器、验证器或 package provenance 契约，任何角色自报都不可信。
      return { status: "package-capability-not-frozen" };
    });
  }
}

type Transaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

async function leasedProfessionJob(
  transaction: Transaction,
  jobId: string,
  input: { workerId: string; leaseId: string; attempt: number },
): Promise<
  | { kind: "accepted"; job: typeof jobs.$inferSelect; now: Date }
  | { kind: "rejected"; status: PatchTaskReportResult["status"] }
> {
  const [job] = await transaction
    .select()
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1)
    .for("update");
  if (!job) return { kind: "rejected", status: "lease-mismatch" };
  const now = await databaseNow(transaction);
  if (!hasExactJobLease(job, input, now)) {
    return { kind: "rejected", status: "lease-mismatch" };
  }
  return job.kind === "profession"
    ? { kind: "accepted", job, now }
    : { kind: "rejected", status: "job-kind-mismatch" };
}

function isTerminalPackage(status: string): boolean {
  return status === "passed" || status === "failed" || status === "blocked";
}
