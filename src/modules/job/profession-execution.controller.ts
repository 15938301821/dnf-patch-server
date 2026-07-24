/**
 * @fileoverview 暴露 Worker 租约绑定的固定 Profession 单技能参考图执行入口；不接受 Prompt、模型、
 * endpoint、对象 key、工具路径或任意执行参数，也不返回图片字节和服务端存储定位。
 * @module modules/job/profession-execution-controller
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：仓库外 Worker 以 `X-Worker-Token` 调用内部路由；WorkerTokenGuard 在 Controller 前验证
 * 共享机器凭据，ZodValidationPipe 校验 DTO，ProfessionExecutionService 再以数据库 lease fencing
 * 决定是否允许固定模型出站或对象恢复。
 * 输入输出：输入仅含 path jobId 与当前 workerId/leaseId/attempt/skillId；输出是再次经过严格 schema
 * 校验的脱敏证据 ViewModel。副作用全部位于 Service/Repository，不由本 HTTP 适配层直接执行。
 * 安全边界：共享 Worker token 认证不等于拥有目标 Job；Worker、唯一 lease 编号、attempt 和 skill 归属
 * 必须继续由事务门禁 fail-closed。passed 只证明参考 PNG 已持久化，不证明适配、打包、兼容或部署。
 */
import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  professionSkillExecutionViewSchema,
  requestProfessionSkillExecutionSchema,
  type ProfessionSkillExecutionView,
  type RequestProfessionSkillExecutionInput,
} from "./profession-execution.contracts.js";
import { ProfessionExecutionService } from "./profession-execution.service.js";

@Controller("internal/jobs")
@UseGuards(WorkerTokenGuard)
/** Worker 内部固定 Profession 模型步骤的 HTTP 适配层，不承载执行状态机。 */
export class ProfessionExecutionController {
  /** @param executions 编排固定模型调用、私有对象持久化和原子证据终态的领域 Service。 */
  constructor(private readonly executions: ProfessionExecutionService) {}

  /**
   * 创建或幂等读取当前 attempt 的单技能参考图执行。
   *
   * @param jobId URL path 中已按 UUID schema 校验的 Profession Job 标识。
   * @param input body 中严格四字段 fencing DTO；不能选择 Prompt、模型、阶段或存储位置。
   * @returns `in-progress` 或已持久化 PNG 的脱敏证据；响应再次严格校验，额外字段会 fail-closed。
   * @throws Service 映射 lease、技能、完整性、模型与对象持久化的稳定业务异常。
   */
  @Post(":id/profession-skill-executions")
  async executeSkill(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(requestProfessionSkillExecutionSchema))
    input: RequestProfessionSkillExecutionInput,
  ): Promise<ProfessionSkillExecutionView> {
    return professionSkillExecutionViewSchema.parse(
      await this.executions.executeSkill(jobId, input),
    );
  }
}
