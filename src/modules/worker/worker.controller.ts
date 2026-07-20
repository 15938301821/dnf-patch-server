import {
  Body,
  ConflictException,
  Controller,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  registerWorkerSchema,
  type RegisterWorkerInput,
  type WorkerView,
} from "./worker.contracts.js";
import { WorkerService } from "./worker.service.js";

@Controller("internal/workers")
@UseGuards(WorkerTokenGuard)
export class WorkerController {
  constructor(private readonly workers: WorkerService) {}

  @Post("register")
  register(
    @Body(new ZodValidationPipe(registerWorkerSchema))
    input: RegisterWorkerInput,
  ): Promise<WorkerView> {
    return this.workers.register(input);
  }

  @Post(":id/heartbeat")
  async heartbeat(@Param("id") id: string): Promise<{ status: "available" }> {
    if (!(await this.workers.heartbeat(id))) {
      throw new ConflictException({
        code: "WORKER_NOT_AVAILABLE",
        message: "Worker 不存在或已禁用。",
      });
    }
    return { status: "available" };
  }

  @Post(":id/disable")
  async disable(@Param("id") id: string): Promise<{ status: "disabled" }> {
    await this.workers.disable(id);
    return { status: "disabled" };
  }
}
