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
  registerSchema,
  type AuthSession,
  type LoginInput,
  type RegisterInput,
  type SessionUser,
} from "./auth.contracts.js";
import { AuthService } from "./auth.service.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  async login(
    @Body(new ZodValidationPipe(loginSchema)) input: LoginInput,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<{ data: AuthSession }> {
    const result = await this.auth.login(input);
    setRefreshCookie(response, result.refreshToken);
    return { data: result.session };
  }

  @Post("register")
  async register(
    @Body(new ZodValidationPipe(registerSchema)) input: RegisterInput,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<{ data: AuthSession }> {
    const result = await this.auth.register(input);
    setRefreshCookie(response, result.refreshToken);
    return { data: result.session };
  }

  @Post("refresh")
  async refresh(
    @Headers("cookie") cookie: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<{ data: AuthSession }> {
    const result = await this.auth.refresh(
      readCookie(cookie, "dnf_patch_refresh"),
    );
    setRefreshCookie(response, result.refreshToken);
    return { data: result.session };
  }

  @Get("me")
  async me(
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: SessionUser }> {
    return { data: await this.auth.currentUser(authorization) };
  }

  @Post("logout")
  async logout(
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<{ data: null }> {
    try {
      await this.auth.logout(authorization);
      return { data: null };
    } finally {
      clearRefreshCookie(response);
    }
  }
}

function setRefreshCookie(response: FastifyReply, refreshToken: string): void {
  void response.header(
    "Set-Cookie",
    `dnf_patch_refresh=${refreshToken}; HttpOnly; SameSite=Lax; Path=/v1/auth/refresh; Max-Age=${String(7 * 24 * 60 * 60)}`,
  );
}

/** 无论服务端撤销是否成功都让当前浏览器删除 Cookie；复制品仍由数据库会话状态拒绝。 */
function clearRefreshCookie(response: FastifyReply): void {
  void response.header(
    "Set-Cookie",
    "dnf_patch_refresh=; HttpOnly; SameSite=Lax; Path=/v1/auth/refresh; Max-Age=0",
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
