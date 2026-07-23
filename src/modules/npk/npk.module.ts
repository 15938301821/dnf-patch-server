/**
 * @fileoverview 装配普通与 Worker 两类 NPK Inventory 路由、数据访问和业务 Service，并导入 Run/Artifact
 * 的公开 Module 以验证跨领域归属；不执行扫描、工具调用、NPK 解包或对象存储传输。
 * @module modules/npk/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；普通 NpkController 与受 Worker token 保护的
 * NpkWorkerController 都调用 NpkService；职业/资源导入链路使用导出的 NpkService 查询冻结证据。
 * 输入输出：本文件只声明 Nest 依赖图，不解析 DTO、签发认证或返回 Inventory 数据。
 * 副作用：应用启动时注册 providers/controllers；没有即时数据库写入、游戏目录访问或工具进程。
 * 安全边界：跨模块只能使用 RunService/ArtifactService 的公开接口；Module 不能绕过 Worker lease、
 * finalized Artifact、路径规范化或事务校验，也不会把服务器变成 NPK 执行面。
 */
import { Module } from "@nestjs/common";
import { ArtifactModule } from "../artifact/artifact.module.js";
import { RunModule } from "../run/run.module.js";
import { NpkController } from "./npk.controller.js";
import { NpkRepository } from "./npk.repository.js";
import { NpkService } from "./npk.service.js";
import { NpkWorkerController } from "./npk-worker.controller.js";

@Module({
  imports: [ArtifactModule, RunModule],
  controllers: [NpkController, NpkWorkerController],
  providers: [NpkRepository, NpkService],
  exports: [NpkService],
})
/** NPK Inventory 领域的 Nest 依赖注入边界，只导出受控查询/创建 Service。 */
export class NpkModule {}
