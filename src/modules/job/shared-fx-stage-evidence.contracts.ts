/**
 * @fileoverview 定义 Worker 回填共享特效阶段 Artifact 证据的严格输入和只读视图；不接收路径、工具或调用方哈希。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { z } from "zod";
import {
  sharedFxStageSchema,
  type SharedFxStage,
} from "./shared-fx.contracts.js";

/**
 * Artifact 已在独立 finalize 流程中被服务器重新读取并计算哈希；此接口只接受其 ID。
 * leaseId 强制存在，避免首次 attempt 的旧完成协议降低阶段证据归属强度。
 */
export const recordSharedFxStageEvidenceSchema = z
  .object({
    workerId: z.uuid(),
    leaseId: z.uuid(),
    attempt: z.number().int().min(1).max(10),
    stage: sharedFxStageSchema,
    artifactId: z.uuid(),
  })
  .strict();

export type RecordSharedFxStageEvidenceInput = z.infer<
  typeof recordSharedFxStageEvidenceSchema
>;

export interface SharedFxStageEvidenceView {
  jobId: string;
  stage: SharedFxStage;
  artifactId: string;
  artifactSha256: string;
  createdAtUtc: string;
}

export type SharedFxStageEvidenceMutationStatus =
  | "accepted"
  | "lease-mismatch"
  | "protocol-upgrade-required"
  | "job-kind-mismatch"
  | "artifact-not-finalized"
  | "stage-conflict";

export type SharedFxStageEvidenceMutationResult =
  | { status: "accepted"; evidence: SharedFxStageEvidenceView }
  | { status: Exclude<SharedFxStageEvidenceMutationStatus, "accepted"> };
