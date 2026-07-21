/**
 * @fileoverview 持久化浏览器制作任务视图对应的主题技能生产和最终包占位记录。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import { Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  artifacts,
  imageAttempts,
  jobs,
  modelCalls,
  runs,
} from "../../common/db/schema.js";
import {
  professions,
  professionStyles,
  stylePackages,
  styleSkillProductions,
} from "../../common/db/studio-schema.js";
import type {
  PatchTaskArtifactView,
  PatchTaskReportResult,
  PatchTaskView,
  PlannedPatchTaskPackage,
  PlannedPatchTaskSkill,
  ReportPatchTaskPackageInput,
  ReportPatchTaskSkillProductionInput,
} from "./patch-task.contracts.js";
import { validateLeaseMutation } from "./job-lease.js";
import { mapPatchTaskStatus } from "./patch-task-status.js";

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
      progress: progress(row.totalSkills, row.passedSkills, row.runStatus),
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
        storageKey: artifacts.storageKey,
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

  async reportSkillProduction(
    jobId: string,
    input: ReportPatchTaskSkillProductionInput,
  ): Promise<PatchTaskReportResult> {
    return this.connection.database.transaction(async (transaction) => {
      const lease = await leasedProfessionJob(transaction, jobId, input);
      if (lease.kind !== "accepted") return { status: lease.status };
      const [production] = await transaction
        .select()
        .from(styleSkillProductions)
        .where(
          and(
            eq(styleSkillProductions.runId, lease.job.runId),
            eq(styleSkillProductions.skillId, input.skillId),
          ),
        )
        .limit(1)
        .for("update");
      if (!production) return { status: "skill-production-not-found" };
      if (isTerminalProduction(production.status)) {
        return { status: "skill-production-terminal" };
      }
      if (input.status === "passed") {
        const evidence = await validateSkillEvidence(
          transaction,
          lease.job.runId,
          input,
        );
        if (evidence) return evidence;
      }
      await transaction
        .update(styleSkillProductions)
        .set({
          jobId,
          status: input.status,
          updatedAt: lease.now,
          ...(isTerminalProduction(input.status)
            ? { finishedAt: lease.now }
            : { finishedAt: null }),
          ...(input.status === "passed"
            ? {
                modelCallId: input.modelCallId,
                imageAttemptId: input.imageAttemptId,
                asepriteProfileId: input.asepriteProfileId,
                asepriteBinarySha256: input.asepriteBinarySha256?.toUpperCase(),
                asepriteArtifactId: input.asepriteArtifactId,
                validationArtifactId: input.validationArtifactId,
              }
            : {}),
        })
        .where(eq(styleSkillProductions.id, production.id));
      return { status: "accepted" };
    });
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
      if (input.status === "passed") {
        const packageArtifact = await validateArtifactRun(
          transaction,
          lease.job.runId,
          input.packageArtifactId,
        );
        if (packageArtifact) return packageArtifact;
        const [summary] = await transaction
          .select({
            total: sql<number>`count(${styleSkillProductions.id})`,
            passed: sql<number>`sum(case when ${styleSkillProductions.status} = 'passed' then 1 else 0 end)`,
          })
          .from(styleSkillProductions)
          .where(eq(styleSkillProductions.runId, lease.job.runId));
        const total = summary?.total ?? 0;
        const passed = summary?.passed ?? 0;
        if (total <= 0 || passed !== total) {
          return { status: "package-skills-incomplete" };
        }
      }
      await transaction
        .update(stylePackages)
        .set({
          status: input.status,
          updatedAt: lease.now,
          ...(isTerminalPackage(input.status)
            ? { finishedAt: lease.now }
            : { finishedAt: null }),
          ...(input.status === "passed"
            ? {
                packageArtifactId: input.packageArtifactId,
                manifestSha256: input.manifestSha256?.toUpperCase(),
              }
            : {}),
        })
        .where(eq(stylePackages.id, pack.id));
      return { status: "accepted" };
    });
  }
}

type Transaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

async function leasedProfessionJob(
  transaction: Transaction,
  jobId: string,
  input: { workerId: string; leaseId?: string | undefined },
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
  const leaseStatus = validateLeaseMutation(job, input, now);
  if (leaseStatus !== "accepted") {
    return { kind: "rejected", status: leaseStatus };
  }
  return job.kind === "profession"
    ? { kind: "accepted", job, now }
    : { kind: "rejected", status: "job-kind-mismatch" };
}

async function validateSkillEvidence(
  transaction: Transaction,
  runId: string,
  input: ReportPatchTaskSkillProductionInput,
): Promise<PatchTaskReportResult | undefined> {
  const [modelCall] = await transaction
    .select({ runId: modelCalls.runId, status: modelCalls.status })
    .from(modelCalls)
    .where(eq(modelCalls.id, input.modelCallId ?? ""))
    .limit(1);
  if (!modelCall) return { status: "model-call-not-found" };
  if (modelCall.runId !== runId) return { status: "model-call-run-mismatch" };
  if (modelCall.status !== "passed") return { status: "model-call-not-passed" };

  const [imageAttempt] = await transaction
    .select({ runId: imageAttempts.runId, status: imageAttempts.status })
    .from(imageAttempts)
    .where(eq(imageAttempts.id, input.imageAttemptId ?? ""))
    .limit(1);
  if (!imageAttempt) return { status: "image-attempt-not-found" };
  if (imageAttempt.runId !== runId) {
    return { status: "image-attempt-run-mismatch" };
  }
  if (
    imageAttempt.status !== "generated" &&
    imageAttempt.status !== "adapted"
  ) {
    return { status: "image-attempt-not-ready" };
  }

  return (
    (await validateArtifactRun(transaction, runId, input.asepriteArtifactId)) ??
    (await validateArtifactRun(transaction, runId, input.validationArtifactId))
  );
}

async function validateArtifactRun(
  transaction: Transaction,
  runId: string,
  artifactId: string | undefined,
): Promise<PatchTaskReportResult | undefined> {
  const [artifact] = await transaction
    .select({ runId: artifacts.runId })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId ?? ""))
    .limit(1);
  if (!artifact) return { status: "artifact-not-found" };
  return artifact.runId === runId
    ? undefined
    : { status: "artifact-run-mismatch" };
}

async function databaseNow(transaction: Transaction): Promise<Date> {
  const [row] = await transaction
    .select({ value: sql<Date>`CURRENT_TIMESTAMP(3)` })
    .from(jobs)
    .limit(1);
  if (!row) throw new Error("DATABASE_TIME_UNAVAILABLE");
  return row.value instanceof Date ? row.value : new Date(row.value);
}

function isTerminalProduction(status: string): boolean {
  return status === "passed" || status === "failed" || status === "blocked";
}

function isTerminalPackage(status: string): boolean {
  return status === "passed" || status === "failed" || status === "blocked";
}

function progress(
  totalSkills: number,
  passedSkills: number,
  status: string,
): number {
  if (status === "passed") return 100;
  if (status === "failed" || totalSkills <= 0) return 0;
  return Math.max(5, Math.floor((passedSkills / totalSkills) * 90));
}
