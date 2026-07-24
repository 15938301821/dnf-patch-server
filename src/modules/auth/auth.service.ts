/**
 * @fileoverview 验证持久化用户密码并签发浏览器会话；注册令牌仅用于开户，不作为用户身份。
 * @module auth
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 会话需求）
 */
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { isMysqlDuplicateEntry } from "../../common/db/mysql-errors.js";
import type { Environment } from "../../config/environment.js";
import {
  createBrowserSessionToken,
  userFromSession,
  verifyBrowserSessionToken,
} from "../../common/security/browser-session.js";
import { secureEqual } from "../../common/security/client-token.guard.js";
import type {
  AuthSession,
  LoginInput,
  RegisterInput,
  SessionUser,
} from "./auth.contracts.js";
import { AuthRepository, type AuthUserRecord } from "./auth.repository.js";
import { AuthSessionRepository } from "./auth-session.repository.js";
import { hashPassword, verifyPassword } from "./password.js";

const accessTtlSeconds = 15 * 60;
const refreshTtlSeconds = 7 * 24 * 60 * 60;

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    @Inject(AuthRepository) private readonly users: AuthRepository,
    @Inject(AuthSessionRepository)
    private readonly sessions: AuthSessionRepository,
  ) {}

  async register(
    input: RegisterInput,
  ): Promise<{ session: AuthSession; refreshToken: string }> {
    const registrationToken = this.config.get("USER_REGISTRATION_TOKEN", {
      infer: true,
    });
    if (!registrationToken) {
      throw new ForbiddenException({
        code: "USER_REGISTRATION_DISABLED",
        message: "服务端未启用用户注册。",
      });
    }
    if (!secureEqual(input.registrationToken, registrationToken)) {
      throw new UnauthorizedException({
        code: "USER_REGISTRATION_FAILED",
        message: "注册凭据无效。",
      });
    }
    const password = await hashPassword(input.password);
    let user: AuthUserRecord;
    try {
      user = await this.users.create({
        id: randomUUID(),
        username: input.username,
        normalizedUsername: normalizeUsername(input.username),
        displayName: input.displayName,
        password,
      });
    } catch (error) {
      if (isMysqlDuplicateEntry(error)) {
        throw new ConflictException({
          code: "USERNAME_ALREADY_REGISTERED",
          message: "该账号已注册。",
        });
      }
      throw error;
    }
    return this.issueNewSession(user);
  }

  async login(
    input: LoginInput,
  ): Promise<{ session: AuthSession; refreshToken: string }> {
    const user = await this.users.findByNormalizedUsername(
      normalizeUsername(input.username),
    );
    if (!user || !(await verifyPassword(input.password, user.password))) {
      throw loginFailed();
    }
    return this.issueNewSession(user);
  }

  async refresh(refreshToken: string | undefined): Promise<{
    session: AuthSession;
    refreshToken: string;
  }> {
    const payload = refreshToken
      ? verifyBrowserSessionToken(this.sessionSecret(), refreshToken, "refresh")
      : undefined;
    const user = payload
      ? await this.users.findById(payload.subject)
      : undefined;
    if (!refreshToken || !payload || !user) {
      throw refreshTokenInvalid();
    }
    const next = this.createSessionTokens(user, payload.sessionId);
    const rotated = await this.sessions.rotate({
      sessionId: payload.sessionId,
      userId: user.id,
      currentRefreshTokenSha256: tokenSha256(refreshToken),
      refreshTokenSha256: tokenSha256(next.refreshToken),
      expiresAt: next.refreshExpiresAt,
    });
    if (!rotated) throw refreshTokenInvalid();
    return { session: next.session, refreshToken: next.refreshToken };
  }

  async requireBrowserUser(
    authorization: string | undefined,
  ): Promise<SessionUser> {
    const token = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    const payload = token
      ? verifyBrowserSessionToken(this.sessionSecret(), token, "access")
      : undefined;
    const active = payload
      ? await this.sessions.isActive(payload.sessionId, payload.subject)
      : false;
    const user =
      payload && active
        ? await this.users.findById(payload.subject)
        : undefined;
    if (!payload || !user) throw loginFailed();
    return toSessionUser(user);
  }

  /**
   * 供全局 Guard 检查已验签 Access Token 对应的服务端会话是否仍活动。
   * @param token Authorization Bearer 中提取的候选 Token，不含 `Bearer` 前缀。
   * @returns 签名、用途、期限和数据库 session 均有效时为 true；不返回用户或会话行。
   */
  async isBrowserAccessTokenActive(token: string): Promise<boolean> {
    const payload = verifyBrowserSessionToken(
      this.sessionSecret(),
      token,
      "access",
    );
    return payload
      ? this.sessions.isActive(payload.sessionId, payload.subject)
      : false;
  }

  /**
   * 撤销当前浏览器 Access Token 所属的服务端会话。
   * @param authorization Controller 收到的 Bearer header；不能用共享 Client token 代替用户会话。
   * @returns 撤销写入完成后结算；后续 Access/Refresh 请求均会 fail-closed。
   */
  async logout(authorization: string | undefined): Promise<void> {
    const token = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    const payload = token
      ? verifyBrowserSessionToken(this.sessionSecret(), token, "access")
      : undefined;
    if (
      !payload ||
      !(await this.sessions.revoke(payload.sessionId, payload.subject))
    ) {
      throw loginFailed();
    }
  }

  currentUser(authorization: string | undefined): Promise<SessionUser> {
    return this.requireBrowserUser(authorization);
  }

  private async issueNewSession(user: AuthUserRecord): Promise<{
    session: AuthSession;
    refreshToken: string;
  }> {
    const sessionId = randomUUID();
    const result = this.createSessionTokens(user, sessionId);
    await this.sessions.replace({
      sessionId,
      userId: user.id,
      refreshTokenSha256: tokenSha256(result.refreshToken),
      expiresAt: result.refreshExpiresAt,
    });
    return { session: result.session, refreshToken: result.refreshToken };
  }

  /** 为同一 sessionId 签发用途隔离的 Access/Refresh Token，并返回 Refresh 的精确期限。 */
  private createSessionTokens(
    user: AuthUserRecord,
    sessionId: string,
  ): {
    session: AuthSession;
    refreshToken: string;
    refreshExpiresAt: Date;
  } {
    const accessToken = createBrowserSessionToken(
      this.sessionSecret(),
      user,
      sessionId,
      "access",
      accessTtlSeconds,
    );
    const refreshToken = createBrowserSessionToken(
      this.sessionSecret(),
      user,
      sessionId,
      "refresh",
      refreshTtlSeconds,
    );
    const verified = verifyBrowserSessionToken(
      this.sessionSecret(),
      accessToken,
      "access",
    );
    const verifiedRefresh = verifyBrowserSessionToken(
      this.sessionSecret(),
      refreshToken,
      "refresh",
    );
    if (!verified || !verifiedRefresh) {
      throw new Error("BROWSER_SESSION_SIGNING_FAILED");
    }
    return {
      session: {
        accessToken,
        user: userFromSession(verified),
      },
      refreshToken,
      refreshExpiresAt: new Date(verifiedRefresh.expiresAt * 1_000),
    };
  }

  private sessionSecret(): string {
    return this.config.getOrThrow("BROWSER_SESSION_SECRET", { infer: true });
  }
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function toSessionUser(user: AuthUserRecord): SessionUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
  };
}

function loginFailed(): UnauthorizedException {
  return new UnauthorizedException({
    code: "LOGIN_FAILED",
    message: "用户名或密码无效。",
  });
}

/** 把 Refresh Token 单向绑定到数据库会话；摘要不返回给 Controller 或日志。 */
function tokenSha256(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").toUpperCase();
}

/** @returns Refresh Token 缺失、重放、过期、撤销或用户不存在时使用的统一脱敏异常。 */
function refreshTokenInvalid(): UnauthorizedException {
  return new UnauthorizedException({
    code: "REFRESH_TOKEN_INVALID",
    message: "会话已失效，请重新登录。",
  });
}
