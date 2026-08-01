/**
 * @fileoverview 查询浏览器制作任务详情所需的脱敏数据库投影；不修改 Run/Job、不签发对象 URL，
 * 也不返回 Prompt、Worker 租约、对象 key、模型原始响应或用户凭据。
 * @module modules/job/patch-task-detail-repository-support
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan /memories/session/plan.md - 制作任务详情与模型吞吐监控
 *
 * 调用关系：PatchTaskRepository 把已校验的 Run ID 和浏览器用户 ID 传入；本文件先用二者联合
 * 校验任务所有权，再读取同 Run 的技能、模型阶段和调用审计，最后委托纯映射函数生成 ViewModel。
 * 输入来自 Controller path 与 Access Token 解析结果，输出供浏览器详情页消费。副作用仅为只读查询。
 * 安全边界：有效登录不等于拥有目标 Run；首个查询必须同时约束 ownerUserId，失败后禁止继续读取
 * 技能或模型信息。后续查询只消费已通过所有权检查的同一 runId，且不把内部关联 ID 放入响应。
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { professionSkillFrameTargets } from "../../common/db/profession-frame-target-schema.js";
import { professionSkillModelExecutions } from "../../common/db/profession-model-execution-schema.js";
import {
  artifacts,
  jobAttempts,
  jobs,
  modelCalls,
  runs,
} from "../../common/db/schema.js";
import {
  professionSkills,
  professions,
  professionStyles,
  professionStyleSkills,
  styleSkillProductions,
} from "../../common/db/studio-schema.js";
import { stylePackages } from "../../common/db/style-package-schema.js";
import type { PatchTaskDetailView } from "./patch-task.contracts.js";
import {
  buildPatchTaskDetail,
  type PatchTaskDetailExecutionRecord,
  type PatchTaskDetailJobRecord,
  type PatchTaskDetailSkillRecord,
  type PatchTaskDetailTargetFrameRecord,
} from "./patch-task-detail.js";
import type { PatchTaskDetailModelCallRecord } from "./patch-task-model-throughput.js";

/**
 * 读取当前浏览器用户拥有的一项制作任务详情。
 *
 * @param connection Job 模块注入的数据库连接；本方法只读且不持有行锁。
 * @param runId Controller path 中已通过 UUID schema 校验的任务标识。
 * @param ownerUserId 由浏览器 Access Token 解析的稳定用户 ID，不能由请求 body 提供。
 * @returns 任务存在且归属匹配时返回脱敏详情；不存在或跨用户访问统一返回 undefined。
 */
export async function findPatchTaskDetail(
  connection: DatabaseService,
  runId: string,
  ownerUserId: string,
): Promise<PatchTaskDetailView | undefined> {
  // 第一步：所有权与任务主题在同一查询中确认；失败后不能读取该 Run 的任何技能或模型审计。
  const [task] = await connection.database
    .select({
      id: runs.id,
      professionName: professions.name,
      styleName: professionStyles.name,
      runStatus: runs.status,
      packageStatus: stylePackages.status,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
      finishedAt: runs.finishedAt,
      artifactName: artifacts.logicalName,
      packageArtifactId: stylePackages.packageArtifactId,
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
    .where(and(eq(runs.id, runId), eq(runs.ownerUserId, ownerUserId)))
    .limit(1);
  if (!task) return undefined;

  // 第二步：所有权已确认后并行读取同 Run 的有限投影；集合顺序和状态含义由纯映射层收口。
  const [skills, executions, calls, jobRecords, targetFrames] =
    await Promise.all([
      readSkills(connection, runId),
      readExecutions(connection, runId),
      readModelCalls(connection, runId),
      readJobRecords(connection, runId),
      readTargetFrames(connection, runId),
    ]);
  return buildPatchTaskDetail({
    task,
    skills,
    executions,
    modelCalls: calls,
    jobs: jobRecords,
    targetFrames,
  });
}

/** 读取风格冻结顺序中的技能名称和生产状态，不读取结构化 Prompt。 */
async function readSkills(
  connection: DatabaseService,
  runId: string,
): Promise<PatchTaskDetailSkillRecord[]> {
  return connection.database
    .select({
      skillId: styleSkillProductions.skillId,
      displayName: professionSkills.displayName,
      ordinal: professionStyleSkills.ordinal,
      status: styleSkillProductions.status,
      attempt: styleSkillProductions.attempt,
      errorCode: styleSkillProductions.errorCode,
    })
    .from(styleSkillProductions)
    .innerJoin(
      professionSkills,
      and(
        eq(professionSkills.professionId, styleSkillProductions.professionId),
        eq(professionSkills.id, styleSkillProductions.skillId),
      ),
    )
    .innerJoin(
      professionStyleSkills,
      and(
        eq(
          professionStyleSkills.professionId,
          styleSkillProductions.professionId,
        ),
        eq(professionStyleSkills.styleId, styleSkillProductions.styleId),
        eq(professionStyleSkills.skillId, styleSkillProductions.skillId),
      ),
    )
    .where(eq(styleSkillProductions.runId, runId))
    .orderBy(asc(professionStyleSkills.ordinal));
}

/** 读取固定模型阶段及输出媒体类型；Artifact ID 只用于计算预览可用性，不进入响应。 */
async function readExecutions(
  connection: DatabaseService,
  runId: string,
): Promise<PatchTaskDetailExecutionRecord[]> {
  return connection.database
    .select({
      skillId: professionSkillModelExecutions.skillId,
      attempt: professionSkillModelExecutions.attempt,
      stage: professionSkillModelExecutions.stage,
      status: professionSkillModelExecutions.status,
      outputArtifactId: professionSkillModelExecutions.outputArtifactId,
      outputMediaType: artifacts.mediaType,
    })
    .from(professionSkillModelExecutions)
    .leftJoin(
      artifacts,
      and(
        eq(artifacts.runId, professionSkillModelExecutions.runId),
        eq(artifacts.id, professionSkillModelExecutions.outputArtifactId),
      ),
    )
    .where(eq(professionSkillModelExecutions.runId, runId));
}

/**
 * 读取当前 Run 的 Job 与当前 attempt 错误。
 * attempt=0 时 LEFT JOIN 必须保留 Job 行，使详情能区分“上游联动 blocked”和“Package 实际执行失败”。
 */
async function readJobRecords(
  connection: DatabaseService,
  runId: string,
): Promise<PatchTaskDetailJobRecord[]> {
  return connection.database
    .select({
      kind: jobs.kind,
      status: jobs.status,
      attempt: jobs.attemptCount,
      errorCode: jobAttempts.errorCode,
    })
    .from(jobs)
    .leftJoin(
      jobAttempts,
      and(
        eq(jobAttempts.jobId, jobs.id),
        eq(jobAttempts.attempt, jobs.attemptCount),
      ),
    )
    .where(eq(jobs.runId, runId));
}

/**
 * 按技能与 attempt 聚合 V6 帧准备证据。
 * target 行来自原子提交的 manifest；sourceFrameCount 只统计需要生成目标图且已登记 PNG 的帧，
 * 避免 Hidden/LINK 帧没有独立 PNG 时被误判为冻结失败。
 */
async function readTargetFrames(
  connection: DatabaseService,
  runId: string,
): Promise<PatchTaskDetailTargetFrameRecord[]> {
  const rows = await connection.database
    .select({
      skillId: professionSkillFrameTargets.skillId,
      attempt: professionSkillFrameTargets.attempt,
      targetFrameCount: sql<string>`count(${professionSkillFrameTargets.id})`,
      generationFrameCount: sql<string>`sum(case when ${professionSkillFrameTargets.targetPolicy} = 'generate-same-size' then 1 else 0 end)`,
      sourceFrameCount: sql<string>`sum(case when ${professionSkillFrameTargets.targetPolicy} = 'generate-same-size' and ${professionSkillFrameTargets.sourcePngArtifactId} is not null then 1 else 0 end)`,
    })
    .from(professionSkillFrameTargets)
    .where(eq(professionSkillFrameTargets.runId, runId))
    .groupBy(
      professionSkillFrameTargets.skillId,
      professionSkillFrameTargets.attempt,
    );
  return rows.map((row) => ({
    skillId: row.skillId,
    attempt: row.attempt,
    targetFrameCount: Number(row.targetFrameCount),
    generationFrameCount: Number(row.generationFrameCount),
    sourceFrameCount: Number(row.sourceFrameCount),
  }));
}

/** 读取模型调用的脱敏计量与时间，不读取请求/响应哈希、endpoint 或 Provider response ID。 */
async function readModelCalls(
  connection: DatabaseService,
  runId: string,
): Promise<PatchTaskDetailModelCallRecord[]> {
  return connection.database
    .select({
      id: modelCalls.id,
      role: modelCalls.role,
      model: modelCalls.model,
      status: modelCalls.status,
      modelEgressPerformed: modelCalls.modelEgressPerformed,
      inputTokens: modelCalls.inputTokens,
      outputTokens: modelCalls.outputTokens,
      totalTokens: modelCalls.totalTokens,
      providerLatencyMs: modelCalls.providerLatencyMs,
      createdAt: modelCalls.createdAt,
      finishedAt: modelCalls.finishedAt,
    })
    .from(modelCalls)
    .where(eq(modelCalls.runId, runId));
}
