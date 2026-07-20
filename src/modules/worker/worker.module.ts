import { Module } from "@nestjs/common";
import { WorkerController } from "./worker.controller.js";
import { WorkerService } from "./worker.service.js";

@Module({
  controllers: [WorkerController],
  providers: [WorkerService],
  exports: [WorkerService],
})
export class WorkerModule {}
