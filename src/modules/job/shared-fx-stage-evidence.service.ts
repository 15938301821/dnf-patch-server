/**
 * @fileoverview 映射共享特效阶段证据写入结果为稳定 HTTP 语义；不访问 Drizzle、对象存储或本机工具。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { SharedFxStageEvidenceRepository } from "./shared-fx-stage-evidence.repository.js";
import type {
  RecordSharedFxStageEvidenceInput,
  SharedFxStageEvidenceMutationResult,
  SharedFxStageEvidenceView,
} from "./shared-fx-stage-evidence.contracts.js";

interface SharedFxStageEvidencePort {
  record(
    jobId: string,
    input: RecordSharedFxStageEvidenceInput,
  ): Promise<SharedFxStageEvidenceMutationResult>;
}

@Injectable()
export class SharedFxStageEvidenceService {
  constructor(
    @Inject(SharedFxStageEvidenceRepository)
    private readonly evidence: SharedFxStageEvidencePort,
  ) {}

  /** 写入固定阶段证据，并以稳定错误码拒绝错误租约、Job 类型或 Artifact 归属。 */
  async record(
    jobId: string,
    input: RecordSharedFxStageEvidenceInput,
  ): Promise<SharedFxStageEvidenceView> {
    const result = await this.evidence.record(jobId, input);
    if (result.status === "accepted") return result.evidence;
    if (result.status === "protocol-upgrade-required") {
      throw new ConflictException({
        code: "WORKER_PROTOCOL_UPGRADE_REQUIRED",
        message: "重试后的任务必须提交 claim 返回的 leaseId。",
      });
    }
    if (result.status === "job-kind-mismatch") {
      throw new ConflictException({
        code: "SHARED_FX_JOB_REQUIRED",
        message: "当前 Job 不接受共享特效阶段证据。",
      });
    }
    if (result.status === "artifact-not-finalized") {
      throw new ConflictException({
        code: "SHARED_FX_EVIDENCE_ARTIFACT_REQUIRED",
        message: "阶段证据必须是当前租约已 finalize 的同 Job Artifact。",
      });
    }
    if (result.status === "stage-conflict") {
      throw new ConflictException({
        code: "SHARED_FX_STAGE_EVIDENCE_CONFLICT",
        message: "同一阶段已绑定其他 Artifact，不能替换。",
      });
    }
    throw new ConflictException({
      code: "JOB_LEASE_MISMATCH",
      message: "任务租约不存在、已过期或不属于当前 Worker。",
    });
  }
}
