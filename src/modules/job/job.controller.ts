import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
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
import {
  createPatchTaskSchema,
  reportPatchTaskPackageSchema,
  reportPatchTaskSkillProductionSchema,
  type CreatePatchTaskInput,
  type PatchTaskView,
  type ReportPatchTaskPackageInput,
  type ReportPatchTaskSkillProductionInput,
} from "./patch-task.contracts.js";
import { PatchTaskService } from "./patch-task.service.js";

@Controller("jobs")
export class PatchTaskController {
  constructor(private readonly patchTasks: PatchTaskService) {}

  @Get()
  list(): Promise<{ data: PatchTaskView[] }> {
    return this.patchTasks.list().then((data) => ({ data }));
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createPatchTaskSchema))
    input: CreatePatchTaskInput,
  ): Promise<{ data: PatchTaskView }> {
    return this.patchTasks.create(input).then((data) => ({ data }));
  }

  @Get(":id/artifact")
  async artifact(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const artifact = await this.patchTasks.findArtifact(id);
    response
      .status(200)
      .type("application/json")
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${downloadFileName(artifact.artifactName)}"`,
      )
      .send(JSON.stringify({ data: artifact }, null, 2));
  }
}

function downloadFileName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
  return normalized.length > 0 ? normalized : "patch-task-artifact.json";
}

@Controller("internal/jobs")
@UseGuards(WorkerTokenGuard)
export class JobController {
  constructor(
    private readonly jobs: JobService,
    private readonly patchTasks: PatchTaskService,
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
