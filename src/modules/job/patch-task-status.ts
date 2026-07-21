/**
 * @fileoverview 将 Run 与主题包持久化状态映射为浏览器任务状态，不修改数据库状态。
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
  if (runStatus === "passed" && packageStatus === "passed") return "passed";
  if (runStatus === "running" || packageStatus === "building") {
    return "running";
  }
  return "queued";
}
