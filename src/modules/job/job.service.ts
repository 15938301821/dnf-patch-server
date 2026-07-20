import { ConflictException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../config/environment.js";
import { RunGateway } from "../run/run.gateway.js";
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
    private readonly runGateway: RunGateway,
  ) {}

  async claim(input: ClaimJobInput): Promise<JobView | undefined> {
    const result = await this.jobs.claim(input, this.leaseSeconds());
    if (result?.runEvent) {
      this.runGateway.publishRunEvent(result.runEvent.runId, result.runEvent);
    }
    return result?.job;
  }

  async heartbeat(jobId: string, input: HeartbeatJobInput): Promise<void> {
    if (
      !(await this.jobs.heartbeat(jobId, input.workerId, this.leaseSeconds()))
    ) {
      throw new ConflictException({
        code: "JOB_LEASE_MISMATCH",
        message: "任务租约不存在、已过期或不属于当前 Worker。",
      });
    }
  }

  async complete(jobId: string, input: CompleteJobInput): Promise<void> {
    const result = await this.jobs.complete(jobId, input);
    if (!result.accepted) {
      throw new ConflictException({
        code: "JOB_COMPLETION_CONFLICT",
        message: "任务已完成或租约不属于当前 Worker。",
      });
    }
    if (result.runEvent) {
      this.runGateway.publishRunEvent(result.runEvent.runId, result.runEvent);
    }
  }

  private leaseSeconds(): number {
    return this.config.getOrThrow("WORKER_LEASE_SECONDS", { infer: true });
  }
}
