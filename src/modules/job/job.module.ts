import { Module } from "@nestjs/common";
import { RunModule } from "../run/run.module.js";
import { JobController } from "./job.controller.js";
import { JobRepository } from "./job.repository.js";
import { JobService } from "./job.service.js";

@Module({
  imports: [RunModule],
  controllers: [JobController],
  providers: [JobRepository, JobService],
  exports: [JobService],
})
export class JobModule {}
