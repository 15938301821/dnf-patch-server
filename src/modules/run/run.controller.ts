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
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createRunSchema,
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
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createRunSchema)) input: CreateRunInput,
  ): Promise<RunView> {
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Idempotency-Key 请求头必填且不能超过 128 个字符。",
      });
    }
    return this.runs.create(input, idempotencyKey);
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<RunView> {
    return this.runs.get(id);
  }

  @Get(":id/events")
  events(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(runEventQuerySchema)) query: RunEventQuery,
  ): Promise<RunEventView[]> {
    return this.runs.events(id, query);
  }
}
