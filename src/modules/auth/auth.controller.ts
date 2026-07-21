/**
 * @fileoverview 暴露浏览器登录、刷新、当前用户和登出接口；Refresh Token 仅写入 HttpOnly Cookie。
 * @module auth
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 会话需求）
 */
import { Body, Controller, Get, Headers, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  loginSchema,
  type AuthSession,
  type LoginInput,
  type SessionUser,
} from "./auth.contracts.js";
import { AuthService } from "./auth.service.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  login(
    @Body(new ZodValidationPipe(loginSchema)) input: LoginInput,
    @Res({ passthrough: true }) response: FastifyReply,
  ): { data: AuthSession } {
    const result = this.auth.login(input);
    setRefreshCookie(response, result.refreshToken);
    return { data: result.session };
  }

  @Post("refresh")
  refresh(
    @Headers("cookie") cookie: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply,
  ): { data: AuthSession } {
    const result = this.auth.refresh(readCookie(cookie, "dnf_patch_refresh"));
    setRefreshCookie(response, result.refreshToken);
    return { data: result.session };
  }

  @Get("me")
  me(@Headers("authorization") authorization: string | undefined): {
    data: SessionUser;
  } {
    return { data: this.auth.currentUser(authorization) };
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) response: FastifyReply): { data: null } {
    void response.header(
      "Set-Cookie",
      "dnf_patch_refresh=; HttpOnly; SameSite=Lax; Path=/v1/auth/refresh; Max-Age=0",
    );
    return { data: null };
  }
}

function setRefreshCookie(response: FastifyReply, refreshToken: string): void {
  void response.header(
    "Set-Cookie",
    `dnf_patch_refresh=${refreshToken}; HttpOnly; SameSite=Lax; Path=/v1/auth/refresh; Max-Age=${String(7 * 24 * 60 * 60)}`,
  );
}

function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
