/**
 * @fileoverview 装配资源导入的浏览器接口、权威状态查询与受控 Run 创建依赖。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端资源导入业务直接需求）
 */
import { Module } from "@nestjs/common";
import { FactoryModule } from "../factory/factory.module.js";
import { NpkModule } from "../npk/npk.module.js";
import { ProjectModule } from "../project/project.module.js";
import { RunModule } from "../run/run.module.js";
import { WorkerModule } from "../worker/worker.module.js";
import { ResourceImportController } from "./resource-import.controller.js";
import { ResourceImportRepository } from "./resource-import.repository.js";
import { ResourceImportService } from "./resource-import.service.js";

@Module({
  imports: [FactoryModule, NpkModule, ProjectModule, RunModule, WorkerModule],
  controllers: [ResourceImportController],
  providers: [ResourceImportRepository, ResourceImportService],
})
export class ResourceImportModule {}
