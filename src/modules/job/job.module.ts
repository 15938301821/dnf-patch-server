import { Module } from "@nestjs/common";
import { FactoryModule } from "../factory/factory.module.js";
import { ProfessionModule } from "../profession/profession.module.js";
import { ProjectModule } from "../project/project.module.js";
import { RunModule } from "../run/run.module.js";
import { JobController, PatchTaskController } from "./job.controller.js";
import { JobReaperService } from "./job-reaper.service.js";
import { JobRepository } from "./job.repository.js";
import { JobService } from "./job.service.js";
import { PatchTaskRepository } from "./patch-task.repository.js";
import { PatchTaskService } from "./patch-task.service.js";

@Module({
  imports: [FactoryModule, ProfessionModule, ProjectModule, RunModule],
  controllers: [PatchTaskController, JobController],
  providers: [
    JobRepository,
    JobService,
    JobReaperService,
    PatchTaskRepository,
    PatchTaskService,
  ],
  exports: [JobService],
})
export class JobModule {}
