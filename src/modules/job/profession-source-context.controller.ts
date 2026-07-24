/**
 * @fileoverview 暴露 Worker 当前 lease 下的只读 Profession 单技能源上下文入口；不返回对象 key、
 * 下载 URL、Prompt、模型、官方目录、本机路径、命令或源帧正文。
 * @module modules/job/profession-source-context-controller
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：仓库外 Worker 通过 X-Worker-Token 调用；Guard 只验证机器共享凭据，Controller 再解析
 * path/body 并委托 Service，Service/Repository 才验证具体 lease 与冻结证据归属。
 * 输入输出：POST body 复用严格四字段 fencing DTO；响应再次通过严格 ViewModel schema，额外字段拒绝。
 * 副作用：本 HTTP 适配层没有数据库或外部 I/O；成功只表示源事实可读取，不表示 Worker 已有源像素。
 * 安全边界：共享 token 不等于目标 Job 所有权，且响应不得被扩大成历史 Artifact 下载权限。
 */
import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  requestProfessionSkillExecutionSchema,
  type RequestProfessionSkillExecutionInput,
} from "./profession-execution.contracts.js";
import {
  professionSkillSourceContextViewSchema,
  type ProfessionSkillSourceContextView,
} from "./profession-source-context.contracts.js";
import { ProfessionSourceContextService } from "./profession-source-context.service.js";

@Controller("internal/jobs")
@UseGuards(WorkerTokenGuard)
/** Worker 冻结技能源查询的 HTTP 路由适配层，不承载数据库证据状态机。 */
export class ProfessionSourceContextController {
  /** @param sources 负责 lease、payload、Inventory、Artifact 与 Entry 一致性检查的业务 Service。 */
  constructor(private readonly sources: ProfessionSourceContextService) {}

  /**
   * 返回当前 attempt 中一个技能的冻结官方源身份与 IMG 内部路径集合。
   * @param jobId URL path 中经 UUID schema 校验的 Profession Job 标识。
   * @param input body 中当前 workerId/leaseId/attempt/skillId；不能选择 Run、NPK、IMG 或工具。
   * @returns 严格脱敏源 ViewModel；响应中未知字段会 fail-closed。
   */
  @Post(":id/profession-skill-source-context")
  async getSkillSourceContext(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(requestProfessionSkillExecutionSchema))
    input: RequestProfessionSkillExecutionInput,
  ): Promise<ProfessionSkillSourceContextView> {
    return professionSkillSourceContextViewSchema.parse(
      await this.sources.getSkillSourceContext(jobId, input),
    );
  }
}
