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

/**
 * REST 统一认证入口。健康检查只公开服务可用性；Worker 与客户端使用不同令牌，
 * 防止 UI 凭据被用于领取或完成任务。
 */
@Injectable()
export class ApiAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") {
      return true;
    }
    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const path = requestPath(request);
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
    if (path.includes("/internal/")) {
      return this.requireToken(
        readHttpHeader(request, "x-worker-token") ?? "",
        this.config.getOrThrow("WORKER_SHARED_TOKEN", { infer: true }),
        "WORKER_AUTH_FAILED",
      );
    }
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
    throw new UnauthorizedException({
      code: "CLIENT_AUTH_FAILED",
      message: "身份验证失败。",
    });
  }

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
