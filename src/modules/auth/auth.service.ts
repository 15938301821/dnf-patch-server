/**
 * @fileoverview 基于环境密钥签发浏览器会话 token；不保存密码、不访问用户表、不回显共享令牌。
 * @module auth
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 会话需求）
 */
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../config/environment.js";
import {
  createBrowserSessionToken,
  userFromSession,
  verifyBrowserSessionToken,
  type BrowserSessionPrincipal,
} from "../../common/security/browser-session.js";
import { secureEqual } from "../../common/security/client-token.guard.js";
import type { AuthSession, LoginInput, SessionUser } from "./auth.contracts.js";

const accessTtlSeconds = 15 * 60;
const refreshTtlSeconds = 7 * 24 * 60 * 60;

@Injectable()
export class AuthService {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  login(input: LoginInput): { session: AuthSession; refreshToken: string } {
    if (!secureEqual(input.password, this.secret())) {
      throw new UnauthorizedException({
        code: "LOGIN_FAILED",
        message: "用户名或密码无效。",
      });
    }
    const user: BrowserSessionPrincipal = {
      username: input.username,
      displayName: input.username,
    };
    return {
      session: this.sessionFor(user),
      refreshToken: createBrowserSessionToken(
        this.secret(),
        user,
        "refresh",
        refreshTtlSeconds,
      ),
    };
  }

  refresh(refreshToken: string | undefined): {
    session: AuthSession;
    refreshToken: string;
  } {
    const payload = refreshToken
      ? verifyBrowserSessionToken(this.secret(), refreshToken, "refresh")
      : undefined;
    if (!payload) {
      throw new UnauthorizedException({
        code: "REFRESH_TOKEN_INVALID",
        message: "会话已失效，请重新登录。",
      });
    }
    const user = userFromSession(payload);
    return {
      session: this.sessionFor(user),
      refreshToken: createBrowserSessionToken(
        this.secret(),
        user,
        "refresh",
        refreshTtlSeconds,
      ),
    };
  }

  currentUser(authorization: string | undefined): SessionUser {
    const token = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    const payload = token
      ? verifyBrowserSessionToken(this.secret(), token, "access")
      : undefined;
    if (payload) return userFromSession(payload);
    return {
      id: "service-client",
      username: "service-client",
      displayName: "服务客户端",
    };
  }

  private sessionFor(user: BrowserSessionPrincipal): AuthSession {
    const accessToken = createBrowserSessionToken(
      this.secret(),
      user,
      "access",
      accessTtlSeconds,
    );
    const verified = verifyBrowserSessionToken(
      this.secret(),
      accessToken,
      "access",
    );
    if (!verified) throw new Error("BROWSER_SESSION_SIGNING_FAILED");
    return {
      accessToken,
      user: userFromSession(verified),
    };
  }

  private secret(): string {
    return this.config.getOrThrow("CLIENT_SHARED_TOKEN", { infer: true });
  }
}
