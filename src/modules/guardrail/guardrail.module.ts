/**
 * @fileoverview 装配声明式 Job 与帧不变量 Guardrail 的 Controller 和 Service；不执行 Worker、本机图片工具
 * 或数据库迁移。
 * @module modules/guardrail/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；Run 等领域模块通过导出的 GuardrailService 和
 * FrameGuardrailService 调用受控决策逻辑。
 * 输入输出：本文件只定义 Nest 依赖图，不解析 DTO 或返回决策数据。
 * 副作用：应用启动时注册一个 HTTP Controller 与两个 provider；没有直接数据库或外部 I/O。
 * 安全边界：Module 只导出领域 Service，不能在装配层绕过冻结策略、递归 payload 检查或帧证据校验。
 */
import { Module } from "@nestjs/common";
import { FrameGuardrailService } from "./frame-guardrail.service.js";
import { GuardrailController } from "./guardrail.controller.js";
import { GuardrailService } from "./guardrail.service.js";

@Module({
  controllers: [GuardrailController],
  providers: [GuardrailService, FrameGuardrailService],
  exports: [GuardrailService, FrameGuardrailService],
})
/** Guardrail 领域的依赖注入边界，不承载状态机或资源执行能力。 */
export class GuardrailModule {}
