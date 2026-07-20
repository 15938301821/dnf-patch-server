import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createRunSchema,
  idempotencyKeySchema,
  runEventQuerySchema,
  type CreateRunInput,
  type RunEventQuery,
  type RunEventView,
  type RunView,
} from "./run.contracts.js";
import { RunService } from "./run.service.js";

@Controller("runs")
export class RunController {
  constructor(private readonly runs: RunService) {}

  @Post()
  create(
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body(new ZodValidationPipe(createRunSchema)) input: CreateRunInput,
  ): Promise<RunView> {
    const parsed = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsed.success) {
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "Idempotency-Key 请求头缺失或格式无效。",
      });
    }
    return this.runs.create(input, parsed.data);
  }

  @Get(":id")
  get(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<RunView> {
    return this.runs.get(id);
  }

  @Get(":id/events")
  events(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Query(new ZodValidationPipe(runEventQuerySchema)) query: RunEventQuery,
  ): Promise<RunEventView[]> {
    return this.runs.events(id, query);
  }
}
