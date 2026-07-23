/**
 * @fileoverview 提供普通服务客户端共享 Bearer token Guard 与恒定时间字符串比较；不接受浏览器
 * 会话、不保护内部 Worker 路由，也不执行用户或资源所有权判断。
 * @module common/security
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：需要显式共享客户端认证的 Controller 可注入 ClientTokenGuard；ApiAuthGuard 复用
 * secureEqual。输入是 Authorization header 与已校验环境秘密，输出为允许或 401。无持久化副作用。
 * 安全边界：共享 token 只证明客户端持有服务秘密，不能作为稳定用户身份或租户所有权证据。
 */
import { timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readHttpHeader, type HttpRequestLike } from "../http/http-request.js";
import type { Environment } from "../../config/environment.js";

/** 普通客户端专用认证门禁；Guard 只在 Controller 前判断凭据。 */
@Injectable()
export class ClientTokenGuard implements CanActivate {
  /** @param config 提供已校验 CLIENT_SHARED_TOKEN，值不得进入日志或异常详情。 */
  constructor(private readonly config: ConfigService<Environment, true>) {}

  /**
   * @param context Nest 当前 HTTP 上下文，Authorization 应采用 Bearer 格式。
   * @returns 候选 token 与环境秘密匹配时返回 true。
   * @throws UnauthorizedException 缺失、长度或内容不匹配时抛出 `CLIENT_AUTH_FAILED`。
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const provided =
      readHttpHeader(request, "authorization")?.replace(/^Bearer\s+/iu, "") ??
      "";
    const expected = this.config.getOrThrow("CLIENT_SHARED_TOKEN", {
      infer: true,
    });
    if (!secureEqual(provided, expected)) {
      throw new UnauthorizedException({
        code: "CLIENT_AUTH_FAILED",
        message: "客户端身份验证失败。",
      });
    }
    return true;
  }
}

/**
 * 以恒定时间比较同长度 UTF-8 token，避免普通内容比较泄露前缀匹配时序。
 * @param provided 外部请求携带的未信任候选 token。
 * @param expected 进程环境中的预期秘密。
 * @returns 字节长度和内容均匹配时为 true；不记录任一输入。
 */
export function secureEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
