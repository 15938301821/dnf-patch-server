/**
 * @fileoverview 解析浏览器任务中一个技能的固定 reference-image-v1 PNG Artifact；不签发 URL、
 * 读取图片正文或允许调用方提交 Artifact ID，也不修改模型执行与技能生产状态。
 * @module modules/job/patch-task-reference-image-repository-support
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan /memories/session/plan.md - 制作任务详情与模型吞吐监控
 *
 * 调用关系：PatchTaskService 经 Repository 调用本查询，输入为 Controller 已校验的 Run/skill UUID
 * 与 Access Token 解析出的用户 ID；返回内部可用于 ArtifactService 二次归属检查的图片元数据。
 * 副作用只有一次只读数据库查询。安全边界：浏览器认证不能替代 Run 所有权，旧 attempt、非固定
 * stage、非 passed 执行、跨 Run Artifact 或非 PNG 媒体类型都必须返回 undefined，禁止对象存储签名。
 */
import { and, eq } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { professionSkillModelExecutions } from "../../common/db/profession-model-execution-schema.js";
import { artifacts, imageAttempts, runs } from "../../common/db/schema.js";
import { styleSkillProductions } from "../../common/db/studio-schema.js";
import type { PatchTaskReferenceImageView } from "./patch-task.contracts.js";
import { professionReferenceImageStage } from "./profession-model-execution.js";

/**
 * 查找当前用户任务中技能当前 attempt 的 passed 参考图。
 *
 * @param connection Job 模块数据库连接，本方法不启动事务或锁定历史证据。
 * @param runId 浏览器 path 中已验证的任务 UUID。
 * @param skillId 浏览器 path 中已验证的技能 UUID，不是 Artifact ID。
 * @param ownerUserId 从浏览器 Access Token 解析的稳定用户 ID。
 * @returns 所有权和证据链完整时返回 PNG 元数据，否则返回 undefined 且调用方不得签名 URL。
 */
export async function findPatchTaskReferenceImage(
  connection: DatabaseService,
  runId: string,
  skillId: string,
  ownerUserId: string,
): Promise<PatchTaskReferenceImageView | undefined> {
  const rows = await connection.database
    .select({
      artifactId: artifacts.id,
      skillId: styleSkillProductions.skillId,
      artifactName: artifacts.logicalName,
      mediaType: artifacts.mediaType,
      byteLength: artifacts.byteLength,
      sha256: artifacts.sha256,
    })
    .from(styleSkillProductions)
    .innerJoin(runs, eq(runs.id, styleSkillProductions.runId))
    .innerJoin(
      professionSkillModelExecutions,
      and(
        eq(professionSkillModelExecutions.runId, styleSkillProductions.runId),
        eq(
          professionSkillModelExecutions.skillId,
          styleSkillProductions.skillId,
        ),
        eq(professionSkillModelExecutions.jobId, styleSkillProductions.jobId),
        eq(
          professionSkillModelExecutions.attempt,
          styleSkillProductions.attempt,
        ),
      ),
    )
    .innerJoin(
      imageAttempts,
      and(
        eq(imageAttempts.runId, professionSkillModelExecutions.runId),
        eq(imageAttempts.id, professionSkillModelExecutions.imageAttemptId),
        eq(
          imageAttempts.modelCallId,
          professionSkillModelExecutions.modelCallId,
        ),
        eq(
          imageAttempts.outputArtifactId,
          professionSkillModelExecutions.outputArtifactId,
        ),
      ),
    )
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.runId, professionSkillModelExecutions.runId),
        eq(artifacts.id, professionSkillModelExecutions.outputArtifactId),
        eq(artifacts.sha256, professionSkillModelExecutions.outputSha256),
        eq(
          artifacts.byteLength,
          professionSkillModelExecutions.outputByteLength,
        ),
      ),
    )
    .where(
      and(
        eq(styleSkillProductions.runId, runId),
        eq(styleSkillProductions.skillId, skillId),
        eq(runs.ownerUserId, ownerUserId),
        eq(professionSkillModelExecutions.stage, professionReferenceImageStage),
        eq(professionSkillModelExecutions.status, "passed"),
        eq(artifacts.mediaType, "image/png"),
      ),
    )
    .limit(2);
  const image = rows.length === 1 ? rows[0] : undefined;
  return image?.mediaType === "image/png"
    ? { ...image, mediaType: "image/png" }
    : undefined;
}
