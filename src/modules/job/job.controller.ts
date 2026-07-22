import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
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
import { idempotencyKeySchema } from "../run/run.contracts.js";
import { AuthService } from "../auth/auth.service.js";
import {
  createPatchTaskSchema,
  reportPatchTaskPackageSchema,
  reportPatchTaskSkillProductionSchema,
  type CreatePatchTaskInput,
  type PatchTaskArtifactView,
  type PatchTaskView,
  type ReportPatchTaskPackageInput,
  type ReportPatchTaskSkillProductionInput,
} from "./patch-task.contracts.js";
import { PatchTaskService } from "./patch-task.service.js";
import {
  recordSharedFxStageEvidenceSchema,
  type RecordSharedFxStageEvidenceInput,
  type SharedFxStageEvidenceView,
} from "./shared-fx-stage-evidence.contracts.js";
import { SharedFxStageEvidenceService } from "./shared-fx-stage-evidence.service.js";

@Controller("jobs")
export class PatchTaskController {
  constructor(
    private readonly patchTasks: PatchTaskService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: PatchTaskView[] }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return { data: await this.patchTasks.list(user.id) };
  }

  @Post()
  create(
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Headers("authorization") authorization: string | undefined,
    @Body(new ZodValidationPipe(createPatchTaskSchema))
    input: CreatePatchTaskInput,
  ): Promise<{ data: PatchTaskView }> {
    const parsed = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsed.success) {
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "Idempotency-Key 请求头缺失或格式无效。",
      });
    }
    return this.auth
      .requireBrowserUser(authorization)
      .then((user) =>
        this.patchTasks
          .create(input, parsed.data, user.id)
          .then((data) => ({ data })),
      );
  }

  @Get(":id/artifact")
  async artifact(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: PatchTaskArtifactView }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return { data: await this.patchTasks.findArtifact(id, user.id) };
  }
}

@Controller("internal/jobs")
@UseGuards(WorkerTokenGuard)
export class JobController {
  constructor(
    private readonly jobs: JobService,
    private readonly patchTasks: PatchTaskService,
    private readonly sharedFxEvidence: SharedFxStageEvidenceService,
  ) {}

  @Post("claim")
  claim(
    @Body(new ZodValidationPipe(claimJobSchema)) input: ClaimJobInput,
  ): Promise<JobView | undefined> {
    return this.jobs.claim(input);
  }

  @Post(":id/heartbeat")
  async heartbeat(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(heartbeatJobSchema)) input: HeartbeatJobInput,
  ): Promise<{ status: "renewed" }> {
    await this.jobs.heartbeat(jobId, input);
    return { status: "renewed" };
  }

  @Post(":id/complete")
  async complete(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(completeJobSchema)) input: CompleteJobInput,
  ): Promise<{ status: "accepted" }> {
    await this.jobs.complete(jobId, input);
    return { status: "accepted" };
  }

  @Post(":id/shared-fx-stage-evidence")
  async recordSharedFxStageEvidence(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(recordSharedFxStageEvidenceSchema))
    input: RecordSharedFxStageEvidenceInput,
  ): Promise<{ status: "accepted"; data: SharedFxStageEvidenceView }> {
    return {
      status: "accepted",
      data: await this.sharedFxEvidence.record(jobId, input),
    };
  }

  @Post(":id/skill-production")
  async reportSkillProduction(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(reportPatchTaskSkillProductionSchema))
    input: ReportPatchTaskSkillProductionInput,
  ): Promise<{ status: "accepted" }> {
    await this.patchTasks.reportSkillProduction(jobId, input);
    return { status: "accepted" };
  }

  @Post(":id/package")
  async reportPackage(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(reportPatchTaskPackageSchema))
    input: ReportPatchTaskPackageInput,
  ): Promise<{ status: "accepted" }> {
    await this.patchTasks.reportPackage(jobId, input);
    return { status: "accepted" };
  }
}
