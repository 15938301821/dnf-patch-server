/**
 * @fileoverview 暴露 Run 创建、读取和权威事件恢复的普通 HTTP 路由；不直接访问 Drizzle、不领取 Job、
 * 不推送 WebSocket、不执行 Worker 或模型调用。
 * @module modules/run/controller
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：全局 ApiAuthGuard 先认证业务请求，ZodValidationPipe 校验 path/body/query，本 Controller
 * 独立解析 Idempotency-Key，再委托 RunService 执行 Factory/Project/Snapshot/Guardrail/事务逻辑。
 * 输入输出：输入是严格 Run DTO、服务器 id、分页 query 和请求头幂等键；输出是脱敏 Run/Event ViewModel，
 * 不返回 Job payload、lease、Worker token、模型密钥、对象 URL 或数据库行。
 * 副作用：Controller 自身不写数据库；create 经 Service 可能原子创建 Run、决策、Job、权威事件与 outbox。
 * 安全边界：HTTP 认证不替代 Project/Snapshot/Factory/策略校验；Idempotency-Key 必须有效且 Service 必须
 * 比较完整服务器请求指纹，不能只因 key 字符串相同就重放不同请求。
 */
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
/** Run REST 适配层，只处理协议边界，不能绕过 Service 的事务和 Guardrail 规则。 */
export class RunController {
  /** @param runs Run 领域 Service，负责创建编排、幂等重放和权威事件读取。 */
  constructor(private readonly runs: RunService) {}

  /**
   * 创建或安全重放一个 Run。
   * @param idempotencyKey 原始 HTTP 头；在方法内先按受限 schema 解析，不能信任 unknown 值。
   * @param input 经 createRunSchema 严格解析的 Run DTO。
   * @returns 新建或语义完全相同的已存在 RunView；不代表 Job 已被 Worker 领取或生产已完成。
   * @throws IDEMPOTENCY_KEY_INVALID 或 Service 映射的 Project/Factory/策略/Guardrail/幂等业务错误。
   */
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

  /**
   * 读取一个 Run 的公开状态摘要。
   * @param id 经 idSchema 校验的 Run id。
   * @returns RunView；状态可为 queued/blocked 等，不含 Job attempt/lease 和 Artifact 内容。
   * @throws RUN_NOT_FOUND 当目标不存在时抛出。
   */
  @Get(":id")
  get(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<RunView> {
    return this.runs.get(id);
  }

  /**
   * 从指定 sequence 后恢复一个 Run 的权威事件。
   * @param id 经 idSchema 校验的 Run id。
   * @param query 经 runEventQuerySchema 限制的恢复起点与页大小。
   * @returns 严格按 sequence 递增的 RunEventView 列表；WebSocket 只是后续通知，不能替代此事实源。
   * @throws RUN_NOT_FOUND 当 Run 不存在时抛出。
   */
  @Get(":id/events")
  events(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Query(new ZodValidationPipe(runEventQuerySchema)) query: RunEventQuery,
  ): Promise<RunEventView[]> {
    return this.runs.events(id, query);
  }
}
