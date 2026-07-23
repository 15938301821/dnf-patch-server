/**
 * @fileoverview 装配公开 HealthController 与数据库探测 HealthService；不创建业务模块、迁移或后台修复任务。
 * @module modules/health/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module，Nest 将 HealthService 注入 HealthController。
 * 输入输出：只声明依赖图，不解析请求或返回 HealthView。
 * 副作用：应用启动时注册公开路由；没有数据库写入或网络外发。
 * 安全边界：Module 不把健康端点变成配置诊断或管理接口，业务能力仍由各领域模块独立判断。
 */
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
/** Health 领域的最小装配边界，不导出数据库或应用配置。 */
export class HealthModule {}
