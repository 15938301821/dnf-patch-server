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

@Injectable()
export class WorkerTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Environment, true>) {}

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
