/**
 * @fileoverview 读取浏览器制作任务列表及其 V6 当前 attempt 帧进度；不归档任务、不读取对象正文、
 * 不返回 Worker/lease/Artifact 定位，也不改变 Run、Job 或生产状态。
 * @module modules/job/patch-task-list-repository-support
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - 用户直接要求修复 V6 真实任务审计展示
 *
 * 调用关系：PatchTaskRepository.list 传入浏览器 Access Token 已解析的稳定用户 ID，本文件先按
 * ownerUserId 读取可见 Run，再只为这些 Run 聚合技能和当前 Profession attempt 的帧计数。
 * 输出是脱敏 PatchTask ViewModel，副作用仅为只读 MySQL 查询。
 * 安全边界：第二次查询只能消费首查询已通过所有权约束的 Run ID；历史 attempt、对象 key、Worker
 * 身份和错误正文不得进入列表。目标清单与源 PNG 只贡献阶段进度，不证明目标图、封包或部署完成。
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { professionSkillFrameTargets } from "../../common/db/profession-frame-target-schema.js";
import { artifacts, jobs, runs } from "../../common/db/schema.js";
import {
  professions,
  professionStyles,
  styleSkillProductions,
} from "../../common/db/studio-schema.js";
import { stylePackages } from "../../common/db/style-package-schema.js";
import type { PatchTaskView } from "./patch-task.contracts.js";
import {
  mapPatchTaskEvidenceProgress,
  mapPatchTaskStatus,
  type PatchTaskProgressSkillEvidence,
} from "./patch-task-status.js";

/**
 * 读取当前用户未归档的制作任务列表。
 * @param connection Job 模块数据库连接；本函数只读且不持有行锁。
 * @param ownerUserId 浏览器认证上下文中的稳定用户 ID，不能由 query/body 提供。
 * @returns 按创建时间排序的脱敏任务；V6 进度只统计当前 Profession attempt。
 */
export async function findPatchTasks(
  connection: DatabaseService,
  ownerUserId: string,
): Promise<PatchTaskView[]> {
  // 第一步：先限定用户所有权与归档状态，后续禁止查询不在本集合内的 Run。
  const rows = await connection.database
    .select({
      id: runs.id,
      professionName: professions.name,
      styleName: professionStyles.name,
      runStatus: runs.status,
      packageStatus: stylePackages.status,
      createdAt: runs.createdAt,
      packageArtifactId: stylePackages.packageArtifactId,
      artifactName: artifacts.logicalName,
    })
    .from(stylePackages)
    .innerJoin(runs, eq(runs.id, stylePackages.runId))
    .innerJoin(professions, eq(professions.id, stylePackages.professionId))
    .innerJoin(professionStyles, eq(professionStyles.id, stylePackages.styleId))
    .leftJoin(
      artifacts,
      and(
        eq(artifacts.runId, stylePackages.runId),
        eq(artifacts.id, stylePackages.packageArtifactId),
      ),
    )
    .where(and(eq(runs.ownerUserId, ownerUserId), isNull(runs.archivedAt)))
    .orderBy(asc(runs.createdAt));
  if (rows.length === 0) return [];

  // 第二步：一次聚合全部可见 Run，按 Job.attemptCount 排除重领前的历史帧证据。
  const evidence = await readProgressEvidence(
    connection,
    rows.map((row) => row.id),
  );
  const evidenceByRun = groupEvidenceByRun(evidence);
  return rows.map((row) => ({
    id: row.id,
    professionName: row.professionName,
    styleName: row.styleName,
    status: mapPatchTaskStatus(row.runStatus, row.packageStatus),
    progress: mapPatchTaskEvidenceProgress(
      evidenceByRun.get(row.id) ?? [],
      row.runStatus,
      row.packageStatus,
    ),
    createdAt: row.createdAt.toISOString(),
    ...(row.artifactName ? { artifactName: row.artifactName } : {}),
    artifactAvailable: row.packageArtifactId !== null,
  }));
}

interface PatchTaskProgressEvidenceRow extends PatchTaskProgressSkillEvidence {
  runId: string;
}

/** 按 Run 分桶只读证据，避免 Renderer 自行关联技能与帧表。 */
function groupEvidenceByRun(
  rows: readonly PatchTaskProgressEvidenceRow[],
): Map<string, PatchTaskProgressSkillEvidence[]> {
  const grouped = new Map<string, PatchTaskProgressSkillEvidence[]>();
  for (const row of rows) {
    const current = grouped.get(row.runId) ?? [];
    current.push({
      status: row.status,
      ...(row.framePreparation
        ? { framePreparation: row.framePreparation }
        : {}),
    });
    grouped.set(row.runId, current);
  }
  return grouped;
}

/** 聚合每个技能当前 attempt 的 V6 帧计数；无 target 行的 V1-V5 技能仅返回生产状态。 */
async function readProgressEvidence(
  connection: DatabaseService,
  runIds: readonly string[],
): Promise<PatchTaskProgressEvidenceRow[]> {
  const rows = await connection.database
    .select({
      runId: styleSkillProductions.runId,
      status: styleSkillProductions.status,
      targetFrameCount: sql<string>`count(${professionSkillFrameTargets.id})`,
      generationFrameCount: sql<string>`sum(case when ${professionSkillFrameTargets.targetPolicy} = 'generate-same-size' then 1 else 0 end)`,
      sourceFrameCount: sql<string>`sum(case when ${professionSkillFrameTargets.targetPolicy} = 'generate-same-size' and ${professionSkillFrameTargets.sourcePngArtifactId} is not null then 1 else 0 end)`,
    })
    .from(styleSkillProductions)
    .innerJoin(
      jobs,
      and(
        eq(jobs.runId, styleSkillProductions.runId),
        eq(jobs.kind, "profession"),
      ),
    )
    .leftJoin(
      professionSkillFrameTargets,
      and(
        eq(professionSkillFrameTargets.runId, styleSkillProductions.runId),
        eq(professionSkillFrameTargets.skillId, styleSkillProductions.skillId),
        eq(professionSkillFrameTargets.attempt, jobs.attemptCount),
      ),
    )
    .where(inArray(styleSkillProductions.runId, [...runIds]))
    .groupBy(
      styleSkillProductions.runId,
      styleSkillProductions.skillId,
      styleSkillProductions.status,
    );
  return rows.map((row) => {
    const targetFrameCount = Number(row.targetFrameCount);
    return {
      runId: row.runId,
      status: row.status,
      ...(targetFrameCount > 0
        ? {
            framePreparation: {
              generationFrameCount: Number(row.generationFrameCount),
              sourceFrameCount: Number(row.sourceFrameCount),
            },
          }
        : {}),
    };
  });
}
