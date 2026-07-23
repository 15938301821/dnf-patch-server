/**
 * @fileoverview 暴露受 WorkerTokenGuard 保护的 Worker 注册、心跳与禁用内部路由；不领取 Job、不接收
 * 任意命令、路径、脚本、模型密钥或对象字节。
 * @module modules/worker/controller
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：ApiAuthGuard 对 `/internal/` 路径要求 Worker token，WorkerTokenGuard 进一步保护本 Controller；
 * ZodValidationPipe 解析 id/body 后，WorkerService 在数据库中维护 Worker 状态与 capability 不变量。
 * 输入输出：输入是注册 DTO 或 path 中 Worker id；输出是脱敏 WorkerView 或有限 status，绝不回显 token、
 * lease、Job payload、本机工具配置或游戏目录。
 * 副作用：Controller 本身不读写数据库；下游 Service 可能注册/刷新/禁用一条 Worker 记录。
 * 安全边界：共享内部 token 只认证受控 Worker 通道，不把 URL id 自动绑定为独立身份；Service 仍必须对
 * 重复注册的显示名与 capabilities 保持不可变，并在禁用后拒绝重新注册。
 */
import {
  Body,
  ConflictException,
  Controller,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
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
/** Worker 内部 HTTP 适配层，不承担 Job 调度、lease 或本机执行。 */
export class WorkerController {
  /** @param workers Worker 状态领域 Service，负责注册一致性与心跳/禁用写入。 */
  constructor(private readonly workers: WorkerService) {}

  /**
   * 登记一个 Worker，或在身份/能力完全一致时刷新其心跳。
   * @param input 经 registerWorkerSchema 校验的稳定 UUID、显示名和 capability 白名单。
   * @returns 脱敏 WorkerView；返回成功不证明 Worker 已领取 Job 或其本机工具链可用。
   * @throws WORKER_DISABLED 或 WORKER_REGISTRATION_CONFLICT 当禁用/身份不变量不成立时抛出。
   */
  @Post("register")
  register(
    @Body(new ZodValidationPipe(registerWorkerSchema))
    input: RegisterWorkerInput,
  ): Promise<WorkerView> {
    return this.workers.register(input);
  }

  /**
   * 刷新一个已启用 Worker 的最后心跳时间。
   * @param id 经 idSchema 校验的 Worker 标识。
   * @returns 有限 `available` 状态；它只表示本次数据库更新命中，不证明能力仍可执行。
   * @throws WORKER_NOT_AVAILABLE 当记录不存在或已经禁用时抛出。
   */
  @Post(":id/heartbeat")
  async heartbeat(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<{ status: "available" }> {
    if (!(await this.workers.heartbeat(id))) {
      throw new ConflictException({
        code: "WORKER_NOT_AVAILABLE",
        message: "Worker 不存在或已禁用。",
      });
    }
    return { status: "available" };
  }

  /**
   * 单向禁用一个 Worker。
   * @param id 经 idSchema 校验的 Worker 标识。
   * @returns 固定 `disabled` 响应；调用后历史 Job lease 是否回收由 Job 领域的独立流程决定。
   */
  @Post(":id/disable")
  async disable(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<{ status: "disabled" }> {
    await this.workers.disable(id);
    return { status: "disabled" };
  }
}
