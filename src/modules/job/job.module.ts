import { Module } from "@nestjs/common";
import { JobController } from "./job.controller.js";
import { JobReaperService } from "./job-reaper.service.js";
import { JobRepository } from "./job.repository.js";
import { JobService } from "./job.service.js";

@Module({
  controllers: [JobController],
  providers: [JobRepository, JobService, JobReaperService],
  exports: [JobService],
})
export class JobModule {}
