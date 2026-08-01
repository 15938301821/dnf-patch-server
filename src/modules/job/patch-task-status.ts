/**
 * @fileoverview 将 Run、主题包、旧版技能结果和 V6 逐帧证据映射为浏览器任务状态与进度，
 * 不读取或修改数据库，也不把源帧冻结误当成目标图或封包完成。
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

/** 计算进度所需的单技能脱敏证据；帧计数只描述当前 Profession attempt。 */
export interface PatchTaskProgressSkillEvidence {
  status: string;
  framePreparation?: {
    generationFrameCount: number;
    sourceFrameCount: number;
  };
}

/**
 * 按可审计子阶段计算 V6 进度，并为 V1-V5 保留原有通过技能公式。
 *
 * V6 每个技能的目标清单、源帧冻结、目标图生成和独立验证各占四分之一；源帧冻结按已登记
 * PNG 比例递增。Package 未通过时整体仍以 90% 为上限，避免源帧证据被误表述为最终产物。
 *
 * @param skills 同一 Run 的有序技能状态与可选 V6 当前 attempt 帧计数。
 * @param runStatus Run 聚合状态；failed 保持原有零进度语义。
 * @param packageStatus Package 聚合状态；只有与 Run 同时 passed 才返回 100%。
 * @returns 0..100 的整数；V6 缺少逐帧证据时回退旧公式，不根据任务名或错误码猜测。
 */
export function mapPatchTaskEvidenceProgress(
  skills: readonly PatchTaskProgressSkillEvidence[],
  runStatus: string,
  packageStatus: string,
): number {
  const passedSkills = skills.filter(
    (skill) => skill.status === "passed",
  ).length;
  if (!skills.some((skill) => skill.framePreparation)) {
    return mapPatchTaskProgress(
      skills.length,
      passedSkills,
      runStatus,
      packageStatus,
    );
  }
  if (runStatus === "passed" && packageStatus === "passed") return 100;
  if (runStatus === "failed" || skills.length === 0) return 0;
  const completion = skills.reduce((total, skill) => {
    if (skill.status === "passed") return total + 1;
    const frames = skill.framePreparation;
    if (!frames) return total;
    const sourceRatio =
      frames.generationFrameCount === 0
        ? 1
        : Math.min(
            1,
            Math.max(0, frames.sourceFrameCount / frames.generationFrameCount),
          );
    return total + (1 + sourceRatio) / 4;
  }, 0);
  return Math.max(5, Math.floor((completion / skills.length) * 90));
}
