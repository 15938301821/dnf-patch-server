/**
 * @fileoverview 暴露共享特效模板的浏览器创建接口；不接受 Worker、路径、工具或来源哈希。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
} from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { AuthService } from "../auth/auth.service.js";
import { idempotencyKeySchema } from "../run/run.contracts.js";
import {
  createSharedFxTaskSchema,
  type CreateSharedFxTaskInput,
  type SharedFxTaskView,
} from "./shared-fx-task.contracts.js";
import { SharedFxTaskService } from "./shared-fx-task.service.js";

@Controller("shared-fx/tasks")
export class SharedFxTaskController {
  constructor(
    private readonly sharedFxTasks: SharedFxTaskService,
    private readonly auth: AuthService,
  ) {}

  /**
   * 使用稳定浏览器身份创建共享特效 Run；共享客户端令牌不能单独提供任务所有权。
   */
  @Post()
  async create(
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Headers("authorization") authorization: string | undefined,
    @Body(new ZodValidationPipe(createSharedFxTaskSchema))
    input: CreateSharedFxTaskInput,
  ): Promise<{ data: SharedFxTaskView }> {
    const parsed = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsed.success) {
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "Idempotency-Key 请求头缺失或格式无效。",
      });
    }
    const user = await this.auth.requireBrowserUser(authorization);
    return {
      data: await this.sharedFxTasks.create(input, parsed.data, user.id),
    };
  }
}
