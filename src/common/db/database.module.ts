/**
 * @fileoverview 装配全局 DatabaseService，向纵向模块提供同一 MySQL/Drizzle 连接入口；不定义表、
 * 执行 migration、开启业务 transaction 或实现 Repository 查询。
 * @module common/db
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module，各 Service/Repository 注入 DatabaseService。输入输出仅为
 * Nest 依赖注入元数据；连接池构造和关闭由 DatabaseService 生命周期负责。
 * 安全边界：Module 不导出连接 URL或驱动原始响应，不能替代各领域 transaction、row lock 与
 * 所有权校验，也不会自动执行 drizzle migration。
 */
import { Global, Module } from "@nestjs/common";
import { DatabaseService } from "./database.service.js";

/** 全局数据库依赖装配单元；Module 自身不承载查询或业务逻辑。 */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
