/**
 * @fileoverview 装配 Run 的 REST/Socket 适配、事务 Repository、Guardrail/Factory/Project 依赖及 outbox
 * dispatcher；不执行 Worker、本机工具、对象存储、模型代理或部署操作。
 * @module modules/run/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；RunService 使用 Guardrail/Factory/Project 的公开 Service 验证创建，
 * RunRepository 在事务内持久化状态，RunOutboxDispatcherService 提交后通过 RunGateway 广播事件；Job、
 * OpenAI、NPK、职业等领域使用导出的 RunService/Gateway。
 * 输入输出：本文件只声明 Nest 依赖图，不解析 DTO、运行事务或发出业务事件。
 * 副作用：应用启动注册 controllers/providers/dispatcher；没有直接创建 Run、Job、outbox 或网络调用。
 * 安全边界：跨模块只使用公开 Module/Service，装配层不能绕过 Factory v2、Guardrail、Project/Snapshot、
 * 事务性 outbox 或延迟 Job 派发补偿；Gateway 只通知，不能替代数据库权威状态。
 */
import { Module } from "@nestjs/common";
import { FactoryModule } from "../factory/factory.module.js";
import { GuardrailModule } from "../guardrail/guardrail.module.js";
import { ProjectModule } from "../project/project.module.js";
import { RunController } from "./run.controller.js";
import { RunGateway } from "./run.gateway.js";
import { RunOutboxDispatcherService } from "./run-outbox-dispatcher.service.js";
import { RunOutboxRepository } from "./run-outbox.repository.js";
import { RunRepository } from "./run.repository.js";
import { RunService } from "./run.service.js";

@Module({
  imports: [GuardrailModule, FactoryModule, ProjectModule],
  controllers: [RunController],
  providers: [
    RunRepository,
    RunService,
    RunGateway,
    RunOutboxRepository,
    RunOutboxDispatcherService,
  ],
  exports: [RunService, RunGateway],
})
/** Run 领域的 Nest 依赖注入边界，向其他模块只导出 RunService 与事件发布 Gateway。 */
export class RunModule {}
