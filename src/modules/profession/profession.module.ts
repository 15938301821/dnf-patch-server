/**
 * @fileoverview 装配职业目录、样式、技能、来源证据与生产工作流的 HTTP 路由、Repository 和 Service；
 * 不读取游戏目录、不执行 NPK/图片工具、不调用模型，也不把职业名称当作资源映射或全技能覆盖证明。
 * @module modules/profession/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；两个 Controller 委托 ProfessionService；Service 经 AuthModule
 * 获取稳定用户身份，使用 Project/Run/Npk 的公开 Service 复核归属、冻结条目证据和生产 Run，
 * 再通过 ProfessionRepository 持久化职业领域数据。
 * 输入输出：本文件只注册依赖图，不解析职业 DTO、读取资源字节、创建 Worker 进程或返回数据库行。
 * 副作用：应用启动时注册 provider/controller；没有立即写入职业记录、Artifact、Run 或对象存储。
 * 安全边界：跨模块只导入公开 Module/Service，不能直接访问其他领域 Repository；职业工作流仍须分别证明
 * 用户所有权、Run/Project、Artifact/NPK evidence 与 Worker capability，Module 装配本身不授予这些权限。
 */
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { NpkModule } from "../npk/npk.module.js";
import { ProjectModule } from "../project/project.module.js";
import { RunModule } from "../run/run.module.js";
import {
  ProfessionCatalogController,
  ProfessionController,
} from "./profession.controller.js";
import { ProfessionRepository } from "./profession.repository.js";
import { ProfessionService } from "./profession.service.js";

@Module({
  imports: [AuthModule, NpkModule, ProjectModule, RunModule],
  controllers: [ProfessionController, ProfessionCatalogController],
  providers: [ProfessionRepository, ProfessionService],
  exports: [ProfessionService],
})
/** 职业领域的 Nest 依赖注入边界，只对其他模块导出 ProfessionService。 */
export class ProfessionModule {}
