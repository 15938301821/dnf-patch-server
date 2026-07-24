/**
 * @fileoverview 将 Worker Job 领取、续租、完成和过期回收编排为稳定 HTTP 业务语义；不处理 HTTP DTO、
 * 直接操作 Drizzle、执行 Worker 工具或发送 WebSocket。
 * @module modules/job/service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：JobController 调用 claim/heartbeat/complete；JobReaperService 调用 reapExpired。Service 委托
 * JobRepository 执行行锁、数据库时间、attempt、Run 汇总和权威事件事务，并把有限返回状态映射为稳定冲突码。
 * 输入输出：输入是已校验 Worker id、leaseId、Job id 和完成结果；输出是 JobView/无值或稳定 Conflict，
 * 不返回 Worker token、本机路径、命令、Artifact 字节、模型密钥或数据库行。
 * 副作用：claim/heartbeat/complete/reapExpired 可在 Repository 中更新 Job、attempt、Worker 心跳、Run、
 * event/outbox；本类不创建新 Worker、Run 或执行内容。
 * 安全边界：Worker token 认证后仍需精确 lease fencing；协议升级、共享特效完整证据和人工审核冲突均必须
 * fail-closed。无可领取 Job 返回 undefined 不是错误；完整性失败不能把损坏 payload 下发给 Worker。
 */
import { ConflictException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../config/environment.js";
import type {
  ClaimJobInput,
  CompleteJobInput,
  HeartbeatJobInput,
  JobView,
} from "./job.contracts.js";
import { JobRepository } from "./job.repository.js";

@Injectable()
/** Job 生命周期业务层，向 Controller 隐藏数据库事务状态与错误枚举。 */
export class JobService {
  /**
   * @param jobs Job 事务/查询 Repository，负责数据库时间与状态原子性。
   * @param config 已校验运行配置，提供 lease 秒数和 reaper 批量上限。
   */
  constructor(
    private readonly jobs: JobRepository,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  /**
   * 为 Worker 领取一条兼容且可派发的 Job。
   * @param input 已按 claimJobSchema 校验的 Worker id。
   * @returns JobView，或没有可领取候选时返回 undefined；返回的 leaseId 必须用于后续重试 attempt 的 mutation。
   * @throws JOB_INTEGRITY_FAILED 当持久化 payload/Factory 契约不再完整时抛出，Repository 已隔离该 Job。
   */
  async claim(input: ClaimJobInput): Promise<JobView | undefined> {
    const result = await this.jobs.claim(input, this.leaseSeconds());
    if (!result) return undefined;
    if ("integrityFailure" in result) {
      throw new ConflictException({
        code: "JOB_INTEGRITY_FAILED",
        message: "任务数据完整性校验失败，未向 Worker 下发。",
      });
    }
    return result.job;
  }

  /**
   * 为当前 Worker 的有效 Job attempt 续租。
   * @param jobId 已校验 Job id。
   * @param input 已校验 Worker id 和可选 leaseId。
   * @returns 无返回值；成功时 Repository 延长数据库时间派生的 expiresAt。
   * @throws WORKER_PROTOCOL_UPGRADE_REQUIRED 或 JOB_LEASE_MISMATCH，当旧协议/旧 token/过期/他人 lease 不能修改时。
   */
  async heartbeat(jobId: string, input: HeartbeatJobInput): Promise<void> {
    const status = await this.jobs.heartbeat(jobId, input, this.leaseSeconds());
    if (status === "protocol-upgrade-required") {
      throw new ConflictException({
        code: "WORKER_PROTOCOL_UPGRADE_REQUIRED",
        message: "重试后的任务必须提交 claim 返回的 leaseId。",
      });
    }
    if (status !== "accepted") {
      throw new ConflictException({
        code: "JOB_LEASE_MISMATCH",
        message: "任务租约不存在、已过期或不属于当前 Worker。",
      });
    }
  }

  /**
   * 提交当前 Worker 的 Job 终态及结果/错误证据。
   * @param jobId 已校验 Job id。
   * @param input 已校验 Worker、lease、终态和结果 SHA-256 或稳定错误码。
   * @returns 无返回值；Repository 原子更新 Job、attempt，必要时终结 Run 并写权威事件/outbox。
   * @throws WORKER_PROTOCOL_UPGRADE_REQUIRED、SHARED_FX_EVIDENCE_INCOMPLETE、SHARED_FX_REVIEW_CONFLICT 或
   * JOB_COMPLETION_CONFLICT，当 lease/证据/审核不变量不成立时，且不应写入终态。
   */
  async complete(jobId: string, input: CompleteJobInput): Promise<void> {
    const result = await this.jobs.complete(jobId, input);
    if (result.status === "protocol-upgrade-required") {
      throw new ConflictException({
        code: "WORKER_PROTOCOL_UPGRADE_REQUIRED",
        message: "重试后的任务必须提交 claim 返回的 leaseId。",
      });
    }
    if (result.status === "shared-fx-evidence-incomplete") {
      throw new ConflictException({
        code: "SHARED_FX_EVIDENCE_INCOMPLETE",
        message: "共享特效任务缺少当前租约的完整阶段证据。",
      });
    }
    if (result.status === "shared-fx-review-conflict") {
      throw new ConflictException({
        code: "SHARED_FX_REVIEW_CONFLICT",
        message: "共享特效任务已有不匹配的人工审核记录。",
      });
    }
    if (result.status === "profession-evidence-incomplete") {
      throw new ConflictException({
        code: "PROFESSION_EVIDENCE_INCOMPLETE",
        message: "职业任务尚未形成全部冻结技能的完整生产证据。",
      });
    }
    if (result.status !== "accepted") {
      throw new ConflictException({
        code: "JOB_COMPLETION_CONFLICT",
        message: "任务已完成或租约不属于当前 Worker。",
      });
    }
  }

  /**
   * 使用受配置限制的批量大小回收过期 Job lease。
   * @returns 无返回值；Repository 决定未耗尽任务重排、耗尽任务失败及可能的 Run 聚合。
   * @sideEffect 可能更新 Job/attempt/Run/权威事件/outbox；不会执行或删除 Worker/Artifact。
   */
  async reapExpired(): Promise<void> {
    await this.jobs.reapExpired(
      this.config.getOrThrow("WORKER_REAPER_BATCH_SIZE", { infer: true }),
    );
  }

  /**
   * 读取已校验环境中的 lease 时长。
   * @returns Worker lease 的秒数；配置缺失/无效在环境启动校验阶段应已 fail-closed。
   */
  private leaseSeconds(): number {
    return this.config.getOrThrow("WORKER_LEASE_SECONDS", { infer: true });
  }
}
