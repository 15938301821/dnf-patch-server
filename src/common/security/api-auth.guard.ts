import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { Environment } from "../../config/environment.js";
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
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path;
    if (request.method === "GET" && path.endsWith("/health")) {
      return true;
    }
    if (path.includes("/internal/")) {
      return this.requireToken(
        request.header("x-worker-token") ?? "",
        this.config.getOrThrow("WORKER_SHARED_TOKEN", { infer: true }),
        "WORKER_AUTH_FAILED",
      );
    }
    const bearer = request
      .header("authorization")
      ?.match(/^Bearer\s+(.+)$/iu)?.[1];
    return this.requireToken(
      bearer ?? "",
      this.config.getOrThrow("CLIENT_SHARED_TOKEN", { infer: true }),
      "CLIENT_AUTH_FAILED",
    );
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
