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
import { randomUUID } from "node:crypto";
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
import { hashPassword, verifyPassword } from "./password.js";

const accessTtlSeconds = 15 * 60;
const refreshTtlSeconds = 7 * 24 * 60 * 60;

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    @Inject(AuthRepository) private readonly users: AuthRepository,
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
    return this.issueSession(user);
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
    return this.issueSession(user);
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
    if (!payload || !user) {
      throw new UnauthorizedException({
        code: "REFRESH_TOKEN_INVALID",
        message: "会话已失效，请重新登录。",
      });
    }
    return this.issueSession(user);
  }

  async requireBrowserUser(
    authorization: string | undefined,
  ): Promise<SessionUser> {
    const token = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
    const payload = token
      ? verifyBrowserSessionToken(this.sessionSecret(), token, "access")
      : undefined;
    const user = payload
      ? await this.users.findById(payload.subject)
      : undefined;
    if (!payload || !user) throw loginFailed();
    return toSessionUser(user);
  }

  currentUser(authorization: string | undefined): Promise<SessionUser> {
    return this.requireBrowserUser(authorization);
  }

  private issueSession(user: AuthUserRecord): {
    session: AuthSession;
    refreshToken: string;
  } {
    return {
      session: this.sessionFor(user),
      refreshToken: createBrowserSessionToken(
        this.sessionSecret(),
        user,
        "refresh",
        refreshTtlSeconds,
      ),
    };
  }

  private sessionFor(user: AuthUserRecord): AuthSession {
    const accessToken = createBrowserSessionToken(
      this.sessionSecret(),
      user,
      "access",
      accessTtlSeconds,
    );
    const verified = verifyBrowserSessionToken(
      this.sessionSecret(),
      accessToken,
      "access",
    );
    if (!verified) throw new Error("BROWSER_SESSION_SIGNING_FAILED");
    return {
      accessToken,
      user: userFromSession(verified),
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
