/**
 * @fileoverview 装配全局 REST ApiAuthGuard 以及可显式复用的 Client/Worker Guard；不实现登录、
 * 令牌签发、领域授权或业务状态机。
 * @module common/security
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入全局 SecurityModule；Nest 通过 APP_GUARD 在每个 Controller 前调用
 * ApiAuthGuard，个别入口可注入导出的专用 Guard。输入输出是依赖注入元数据，无直接 I/O。
 * 安全边界：Module 装配不能替代 Service 所有权检查；三类 token 必须由 environment schema 保持
 * 独立，新增公开路由时必须在 ApiAuthGuard 中显式审查而非绕开全局门禁。
 */
import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiAuthGuard } from "./api-auth.guard.js";
import { ClientTokenGuard } from "./client-token.guard.js";
import { WorkerTokenGuard } from "./worker-token.guard.js";
import { AuthModule } from "../../modules/auth/auth.module.js";

/** 全局认证依赖装配单元；自身不承载认证算法或请求状态。 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [
    ClientTokenGuard,
    WorkerTokenGuard,
    ApiAuthGuard,
    { provide: APP_GUARD, useExisting: ApiAuthGuard },
  ],
  exports: [ClientTokenGuard, WorkerTokenGuard],
})
export class SecurityModule {}
