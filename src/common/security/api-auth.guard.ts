/**
 * @fileoverview 实现全局 REST 认证 Guard，按公开、内部 Worker 与普通业务路由选择独立凭据；
 * 不判断 Project/Run/Artifact 等领域资源所有权，也不签发浏览器会话。
 * @module common/security
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：SecurityModule 将 ApiAuthGuard 注册为 APP_GUARD，Nest 在 Controller 前调用
 * canActivate；下游 Controller 仍需 DTO 校验，Service 仍需稳定用户与资源归属检查。输入是 HTTP
 * 方法、路径和认证 header，输出是允许或 UnauthorizedException。副作用仅为拒绝当前请求。
 * 安全边界：`/internal/` 只接受 X-Worker-Token；浏览器 access token 与 Client shared token 只
 * 适用于普通业务路由。认证成功不等于领域授权，缺失或错误凭据必须 fail-closed。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  readHttpHeader,
  requestPath,
  type HttpRequestLike,
} from "../http/http-request.js";
import type { Environment } from "../../config/environment.js";
import { verifyBrowserSessionToken } from "./browser-session.js";
import { secureEqual } from "./client-token.guard.js";

/** REST 统一认证门禁；Guard 指 Controller 执行前的认证检查，不替代领域所有权判断。 */
@Injectable()
export class ApiAuthGuard implements CanActivate {
  /** @param config 只提供 environmentSchema 已校验的三类认证秘密，Guard 不记录这些值。 */
  constructor(private readonly config: ConfigService<Environment, true>) {}

  /**
   * 按请求类型选择公开规则、Worker token 或普通客户端/浏览器 token。
   * @param context Nest 当前执行上下文；非 HTTP 上下文不由此 REST Guard 处理。
   * @returns 公开入口或匹配当前认证域的请求返回 true。
   * @throws UnauthorizedException 内部路由缺少 Worker token，或普通路由缺少有效 Bearer token 时抛出。
   */
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") {
      return true;
    }
    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const path = requestPath(request);
    // 步骤 1：CORS 预检、健康检查和会话建立入口公开；这些 Controller 自身不得返回配置秘密。
    if (request.method === "OPTIONS") {
      return true;
    }
    if (request.method === "GET" && path.endsWith("/health")) {
      return true;
    }
    if (
      request.method === "POST" &&
      (path.endsWith("/auth/login") ||
        path.endsWith("/auth/register") ||
        path.endsWith("/auth/refresh"))
    ) {
      return true;
    }
    // 步骤 2：内部路径只读取独立 Worker header，绝不回退接受浏览器或 Client token。
    if (path.includes("/internal/")) {
      return this.requireToken(
        readHttpHeader(request, "x-worker-token") ?? "",
        this.config.getOrThrow("WORKER_SHARED_TOKEN", { infer: true }),
        "WORKER_AUTH_FAILED",
      );
    }
    // 步骤 3：普通业务入口先兼容共享 Client token，再验证短期浏览器 access 会话。
    const bearer = readHttpHeader(request, "authorization")?.match(
      /^Bearer\s+(.+)$/iu,
    )?.[1];
    const expected = this.config.getOrThrow("CLIENT_SHARED_TOKEN", {
      infer: true,
    });
    if (secureEqual(bearer ?? "", expected)) return true;
    if (
      bearer &&
      verifyBrowserSessionToken(
        this.config.getOrThrow("BROWSER_SESSION_SECRET", { infer: true }),
        bearer,
        "access",
      ) !== undefined
    ) {
      return true;
    }
    // 步骤 4：所有候选认证都失败后只返回稳定错误码，不泄露哪段 token 或签名不匹配。
    throw new UnauthorizedException({
      code: "CLIENT_AUTH_FAILED",
      message: "身份验证失败。",
    });
  }

  /**
   * 恒定时间校验指定认证域的共享 token。
   * @param provided 从当前认证域 header 读取的候选值，缺失时为空字符串。
   * @param expected 启动时已校验的服务秘密；不得写入异常或日志。
   * @param code 当前认证域稳定失败码，供 Worker 与客户端分别处理。
   * @returns 匹配时恒为 true。
   * @throws UnauthorizedException 候选值长度或内容不匹配时抛出，不暴露比较细节。
   */
  private requireToken(provided: string, expected: string, code: string): true {
    if (!secureEqual(provided, expected)) {
      throw new UnauthorizedException({
        code,
        message: "身份验证失败。",
      });
    }
    return true;
  }
}
