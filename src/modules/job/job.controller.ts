import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  claimJobSchema,
  completeJobSchema,
  heartbeatJobSchema,
  type ClaimJobInput,
  type CompleteJobInput,
  type HeartbeatJobInput,
  type JobView,
} from "./job.contracts.js";
import { JobService } from "./job.service.js";

@Controller("internal/jobs")
@UseGuards(WorkerTokenGuard)
export class JobController {
  constructor(private readonly jobs: JobService) {}

  @Post("claim")
  claim(
    @Body(new ZodValidationPipe(claimJobSchema)) input: ClaimJobInput,
  ): Promise<JobView | undefined> {
    return this.jobs.claim(input);
  }

  @Post(":id/heartbeat")
  async heartbeat(
    @Param("id") jobId: string,
    @Body(new ZodValidationPipe(heartbeatJobSchema)) input: HeartbeatJobInput,
  ): Promise<{ status: "renewed" }> {
    await this.jobs.heartbeat(jobId, input);
    return { status: "renewed" };
  }

  @Post(":id/complete")
  async complete(
    @Param("id") jobId: string,
    @Body(new ZodValidationPipe(completeJobSchema)) input: CompleteJobInput,
  ): Promise<{ status: "accepted" }> {
    await this.jobs.complete(jobId, input);
    return { status: "accepted" };
  }
}
