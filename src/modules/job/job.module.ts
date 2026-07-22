import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FactoryModule } from "../factory/factory.module.js";
import { ProfessionModule } from "../profession/profession.module.js";
import { ProjectModule } from "../project/project.module.js";
import { RunModule } from "../run/run.module.js";
import { WorkerModule } from "../worker/worker.module.js";
import { JobController, PatchTaskController } from "./job.controller.js";
import { JobReaperService } from "./job-reaper.service.js";
import { JobRepository } from "./job.repository.js";
import { JobService } from "./job.service.js";
import { PatchTaskRepository } from "./patch-task.repository.js";
import { PatchTaskService } from "./patch-task.service.js";
import { SharedFxTaskController } from "./shared-fx-task.controller.js";
import { SharedFxTaskService } from "./shared-fx-task.service.js";
import { SharedFxStageEvidenceRepository } from "./shared-fx-stage-evidence.repository.js";
import { SharedFxStageEvidenceService } from "./shared-fx-stage-evidence.service.js";

@Module({
  imports: [
    AuthModule,
    FactoryModule,
    ProfessionModule,
    ProjectModule,
    RunModule,
    WorkerModule,
  ],
  controllers: [PatchTaskController, JobController, SharedFxTaskController],
  providers: [
    JobRepository,
    JobService,
    JobReaperService,
    PatchTaskRepository,
    PatchTaskService,
    SharedFxStageEvidenceRepository,
    SharedFxStageEvidenceService,
    SharedFxTaskService,
  ],
  exports: [JobService],
})
export class JobModule {}
