/**
 * @fileoverview 装配 Project 的 HTTP 路由、数据访问和业务 Service，并导入 FactoryModule 以验证
 * Project 关联的 Factory；不创建 Snapshot 内容、Run、Job 或 Worker。
 * @module modules/project/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；ProjectService 通过 FactoryModule 导出的 FactoryService 校验
 * Factory，Run 等领域模块通过本 Module 导出的 ProjectService 查询 Project/Snapshot。
 * 输入输出：只声明 Nest 依赖图，不解析 HTTP DTO 或返回业务数据。
 * 副作用：应用启动注册 controller/provider；没有即时数据库写入或外部 I/O。
 * 安全边界：跨模块只依赖 FactoryService，不能导入 FactoryRepository 或在 Module 装配层绕过 Factory
 * 与 Snapshot 的业务校验。
 */
import { Module } from "@nestjs/common";
import { FactoryModule } from "../factory/factory.module.js";
import { ProjectController } from "./project.controller.js";
import { ProjectRepository } from "./project.repository.js";
import { ProjectService } from "./project.service.js";

@Module({
  imports: [FactoryModule],
  controllers: [ProjectController],
  providers: [ProjectRepository, ProjectService],
  exports: [ProjectService],
})
/** Project 领域的 Nest 依赖注入边界，只导出面向其他模块的 ProjectService。 */
export class ProjectModule {}
