/**
 * @fileoverview 装配 Factory 的 HTTP 路由、持久化边界和业务 Service；不实现 Factory 校验、数据库查询或
 * Run 创建逻辑。
 * @module modules/factory/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；Nest 注入 FactoryRepository 和 FactoryService，并把
 * FactoryService 导出给需要读取冻结策略的其他领域模块。
 * 输入输出：本文件只声明依赖图，不解析 HTTP DTO 或返回业务数据。
 * 副作用：Nest 启动时注册 provider 与路由；没有数据库写入、网络请求或本机工具副作用。
 * 安全边界：Module 不能承载业务规则，跨模块只能使用导出的 Service，不能绕过 Repository 直接读取
 * Factory 表或在装配层创建第二套执行路径。
 */
import { Module } from "@nestjs/common";
import { FactoryController } from "./factory.controller.js";
import { FactoryRepository } from "./factory.repository.js";
import { FactoryService } from "./factory.service.js";

@Module({
  controllers: [FactoryController],
  providers: [FactoryRepository, FactoryService],
  exports: [FactoryService],
})
/** Factory 领域的 Nest 依赖注入边界；只导出公开 Service。 */
export class FactoryModule {}
