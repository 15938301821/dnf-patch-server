/**
 * @fileoverview 装配认证 HTTP 路由、用户/会话持久化边界和认证业务 Service；不实现令牌签发算法、密码
 * 哈希、请求 Guard 或跨领域所有权检查。
 * @module modules/auth/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；AuthController 通过 AuthService 注册、登录、刷新或注销，
 * ApiAuthGuard 和其他需要稳定用户身份的领域模块使用导出的 AuthService 进行认证/解析。
 * 输入输出：本文件只声明 Nest 依赖图，不解析用户名/密码 DTO，不直接返回 access/refresh token。
 * 副作用：应用启动时注册 controller/provider；没有立即写入用户或会话，真实副作用发生在 Service/Repository。
 * 安全边界：Module 不将密码、refresh token、数据库 Repository 或内部哈希/会话行导出给其他模块；
 * 认证成功也不替代 Project、Run、模型配置等领域资源的所有权校验。
 */
import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthSessionRepository } from "./auth-session.repository.js";

@Module({
  controllers: [AuthController],
  providers: [AuthRepository, AuthSessionRepository, AuthService],
  exports: [AuthService],
})
/** Auth 领域的 Nest 依赖注入边界，只向其他模块公开受控 AuthService。 */
export class AuthModule {}
