/**
 * @fileoverview 将 Run、主题包和技能计数映射为浏览器任务状态与进度，不修改数据库状态。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端任务状态直接需求）
 */
import type { PatchTaskStatus } from "./patch-task.contracts.js";

/** 保留安全阻断终态，避免前端把被拒绝的任务误显示为仍在排队。 */
export function mapPatchTaskStatus(
  runStatus: string,
  packageStatus: string,
): PatchTaskStatus {
  if (runStatus === "failed" || packageStatus === "failed") return "failed";
  if (runStatus === "blocked" || packageStatus === "blocked") {
    return "blocked";
  }
  // 历史或并发数据中 Run 已通过但 package 未通过时必须失败关闭，不能继续显示排队中。
  if (runStatus === "passed" && packageStatus !== "passed") return "blocked";
  if (runStatus === "passed" && packageStatus === "passed") return "passed";
  if (runStatus === "running" || packageStatus === "building") {
    return "running";
  }
  return "queued";
}

/**
 * 将逐技能完成度限制在 90%，只有 Run 与最终 package 均 passed 才展示 100%。
 * @param totalSkills 冻结任务中的技能总数。
 * @param passedSkills 已持久化完整双 Artifact 证据的技能数。
 * @param runStatus 当前 Run 状态。
 * @param packageStatus 最终 package 聚合状态。
 * @returns 0 到 100 的整数进度；缺少最终包证据时最多为 90。
 */
export function mapPatchTaskProgress(
  totalSkills: number,
  passedSkills: number,
  runStatus: string,
  packageStatus: string,
): number {
  if (runStatus === "passed" && packageStatus === "passed") return 100;
  if (runStatus === "failed" || totalSkills <= 0) return 0;
  return Math.max(5, Math.floor((passedSkills / totalSkills) * 90));
}
