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
export class JobService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly config: ConfigService<Environment, true>,
  ) {}

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

  async complete(jobId: string, input: CompleteJobInput): Promise<void> {
    const result = await this.jobs.complete(jobId, input);
    if (result.status === "protocol-upgrade-required") {
      throw new ConflictException({
        code: "WORKER_PROTOCOL_UPGRADE_REQUIRED",
        message: "重试后的任务必须提交 claim 返回的 leaseId。",
      });
    }
    if (result.status !== "accepted") {
      throw new ConflictException({
        code: "JOB_COMPLETION_CONFLICT",
        message: "任务已完成或租约不属于当前 Worker。",
      });
    }
  }

  async reapExpired(): Promise<void> {
    await this.jobs.reapExpired(
      this.config.getOrThrow("WORKER_REAPER_BATCH_SIZE", { infer: true }),
    );
  }

  private leaseSeconds(): number {
    return this.config.getOrThrow("WORKER_LEASE_SECONDS", { infer: true });
  }
}
