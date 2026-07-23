/**
 * @fileoverview 提供内部 Worker API 的 X-Worker-Token Guard；不接受 Client/browser token，不校验
 * Worker 数据库注册、capabilities、Job lease 或 attempt 归属。
 * @module common/security
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：内部 Worker Controller 或全局 ApiAuthGuard 使用同一环境凭据边界；输入为专用 header
 * 与 WORKER_SHARED_TOKEN，输出为允许或 401。无数据库副作用。安全边界：共享 token 认证后，
 * Service/Repository 仍必须校验 Worker ID、能力和 lease fencing，错误凭据必须 fail-closed。
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

/** Worker 内部路由专用认证门禁；Guard 不代表当前 Worker 拥有目标 Job。 */
@Injectable()
export class WorkerTokenGuard implements CanActivate {
  /** @param config 提供已校验且独立于客户端凭据的 WORKER_SHARED_TOKEN。 */
  constructor(private readonly config: ConfigService<Environment, true>) {}

  /**
   * @param context Nest 当前 HTTP 上下文，候选值来自 `X-Worker-Token` header。
   * @returns 候选值与 Worker 环境秘密匹配时返回 true。
   * @throws UnauthorizedException 缺失、异长或异值时抛出 `WORKER_AUTH_FAILED`，不披露比较细节。
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const provided = readHttpHeader(request, "x-worker-token") ?? "";
    const expected = this.config.getOrThrow("WORKER_SHARED_TOKEN", {
      infer: true,
    });
    const left = Buffer.from(provided, "utf8");
    const right = Buffer.from(expected, "utf8");
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new UnauthorizedException({
        code: "WORKER_AUTH_FAILED",
        message: "Worker 身份验证失败。",
      });
    }
    return true;
  }
}
