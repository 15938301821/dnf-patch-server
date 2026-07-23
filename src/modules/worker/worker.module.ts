/**
 * @fileoverview 装配受 WorkerTokenGuard 保护的 Worker 内部路由和状态 Service；不注册 Job Handler、
 * 本机执行器、工具路径或对象存储客户端。
 * @module modules/worker/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；Job/Run 领域通过导出的 WorkerService 查询新 Job 所需的可用能力。
 * 输入输出：只声明 Nest 依赖图，不解析 Worker token 或返回任务数据。
 * 副作用：启动时注册内部 Controller 和 Service；没有立即写入 Worker/Job 数据。
 * 安全边界：WorkerModule 不把服务器变成执行面；跨模块只能使用 WorkerService 的受限能力查询，不能
 * 从 Module 层获取 Worker 进程、本机路径或任意调度权限。
 */
import { Module } from "@nestjs/common";
import { WorkerController } from "./worker.controller.js";
import { WorkerService } from "./worker.service.js";

@Module({
  controllers: [WorkerController],
  providers: [WorkerService],
  exports: [WorkerService],
})
/** Worker 注册领域的 Nest 边界，只导出受控的 WorkerService。 */
export class WorkerModule {}
