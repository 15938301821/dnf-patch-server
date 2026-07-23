/**
 * @fileoverview 暴露基于冻结 Run 策略的帧不变量 Guardrail HTTP 路由；不负责声明式 Job payload 决策、
 * 数据库查询细节或图片/NPK 本机处理。
 * @module modules/guardrail/controller
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：ApiAuthGuard 先认证普通业务请求，ZodValidationPipe 解析 frameGuardrailSchema，随后本
 * Controller 委托 FrameGuardrailService；Service 读取 Run 的冻结 Factory 并持久化决策。
 * 输入输出：输入是候选帧与来源帧的哈希、几何和 alpha 证据；输出是脱敏 FrameGuardrailResult，
 * 不返回源帧字节、对象路径、Factory 数据库行或 Worker 命令。
 * 副作用：Controller 自身不读写数据库；下游 Service 可能读取 Run/Factory 并插入 Guardrail 决策。
 * 安全边界：认证成功不替代 Run/策略绑定校验。缺少冻结 v2 策略、策略摘要不匹配或帧证据不一致时
 * 必须由下游 fail-closed，不能按资源名或视觉猜测放行。
 */
import { Body, Controller, Post } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  frameGuardrailSchema,
  type FrameGuardrailInput,
  type FrameGuardrailResult,
} from "./frame-guardrail.contracts.js";
import { FrameGuardrailService } from "./frame-guardrail.service.js";

/** HTTP 路由适配层，只校验 DTO 并委托领域 Service。 */
@Controller("guardrails")
export class GuardrailController {
  /** @param frames 帧不变量领域 Service，负责冻结策略绑定与审计决策。 */
  constructor(private readonly frames: FrameGuardrailService) {}

  /**
   * 比较候选帧与来源帧的哈希、几何、锚点和 alpha 不变量。
   * @param input body 中经严格 frameGuardrailSchema 校验的来源与候选证据。
   * @returns 已持久化的 FrameGuardrailResult；allow 不代表候选包兼容、全技能覆盖或部署已完成。
   * @throws Service 映射 Run 不存在、冻结策略不可用/不匹配等稳定业务错误。
   */
  @Post("frame-invariants")
  evaluateFrame(
    @Body(new ZodValidationPipe(frameGuardrailSchema))
    input: FrameGuardrailInput,
  ): Promise<FrameGuardrailResult> {
    return this.frames.evaluate(input);
  }
}
