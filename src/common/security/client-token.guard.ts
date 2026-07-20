import { timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { Environment } from "../../config/environment.js";

@Injectable()
export class ClientTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided =
      request.header("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
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

export function secureEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
