/**
 * @fileoverview 持久化浏览器制作任务视图对应的主题技能生产和最终包占位记录。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
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
import type {
  ProfessionProductionProgressInput,
  ProfessionProductionProgressView,
} from "./profession-production-progress.contracts.js";

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
      .where(eq(runs.ownerUserId, ownerUserId))
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

  async findArtifact(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskArtifactView | undefined> {
    const [row] = await this.connection.database
      .select({
        artifactName: artifacts.logicalName,
        mediaType: artifacts.mediaType,
        byteLength: artifacts.byteLength,
        sha256: artifacts.sha256,
      })
      .from(stylePackages)
      .innerJoin(runs, eq(runs.id, stylePackages.runId))
      .innerJoin(
        artifacts,
        and(
          eq(artifacts.runId, stylePackages.runId),
          eq(artifacts.id, stylePackages.packageArtifactId),
        ),
      )
      .where(
        and(
          eq(stylePackages.runId, runId),
          eq(stylePackages.status, "passed"),
          eq(runs.ownerUserId, ownerUserId),
        ),
      )
      .limit(1);
    return row;
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
