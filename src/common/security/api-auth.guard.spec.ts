/**
 * @fileoverview 验证统一 REST 守卫同时支持服务共享令牌、浏览器短期 token 与 Worker token。
 * @module common/security
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 用最小 ExecutionContext 与 ConfigService stub 直接调用 Guard，不启动 Nest
 * 路由。输入 token 均为重复字符测试占位值，输出为布尔值或 UnauthorizedException；无数据库、
 * 网络或日志副作用。安全边界：证明认证域不会混用，但不证明领域所有权、真实 HTTPS、会话撤销
 * 或 Controller DTO 校验。
 */
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { createBrowserSessionToken } from "./browser-session.js";
import { ApiAuthGuard } from "./api-auth.guard.js";

/** 以下值仅满足长度门禁，不是可部署凭据。 */
const clientToken = "c".repeat(32);
const workerToken = "w".repeat(32);
const sessionSecret = "s".repeat(32);

describe("ApiAuthGuard browser compatibility", () => {
  const guard = new ApiAuthGuard(configService(), authService());

  // 登录、注册和刷新必须能在尚无 access token 时进入各自 Controller 门禁。
  it("allows public login, registration, and refresh endpoints", async () => {
    await expect(
      guard.canActivate(context("POST", "/v1/auth/login")),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(context("POST", "/v1/auth/register")),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(context("POST", "/v1/auth/refresh")),
    ).resolves.toBe(true);
  });

  // 浏览器 token 泄露不能被用于领取或完成内部 Worker Job。
  it("allows active browser access tokens without accepting them for internal routes", async () => {
    const browserToken = createBrowserSessionToken(
      sessionSecret,
      {
        id: "11111111-1111-4111-8111-111111111111",
        username: "studio",
        displayName: "Studio",
      },
      "22222222-2222-4222-8222-222222222222",
      "access",
      60,
    );

    await expect(
      guard.canActivate(
        context("GET", "/v1/auth/me", {
          authorization: `Bearer ${browserToken}`,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(
        context("POST", "/v1/internal/jobs/claim", {
          authorization: `Bearer ${browserToken}`,
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // 保留现有 Client Bearer 与 Worker 专用 header 契约，同时确认二者使用不同入口。
  it("still accepts service and worker shared tokens through their original headers", async () => {
    await expect(
      guard.canActivate(
        context("GET", "/v1/professions", {
          authorization: `Bearer ${clientToken}`,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(
        context("POST", "/v1/internal/jobs/claim", {
          "x-worker-token": workerToken,
        }),
      ),
    ).resolves.toBe(true);
  });

  // 受保护业务路由没有任何凭据时必须在 Controller 前停止。
  it("rejects anonymous protected routes", async () => {
    await expect(
      guard.canActivate(context("GET", "/v1/professions")),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/** @returns 只模拟数据库会话活动检查；不证明真实会话撤销或 MySQL 状态。 */
function authService(): ConstructorParameters<typeof ApiAuthGuard>[1] {
  return {
    isBrowserAccessTokenActive: () => Promise.resolve(true),
  };
}

/** @returns 只替代配置读取的 stub；不证明环境解析或秘密管理正确。 */
function configService(): ConstructorParameters<typeof ApiAuthGuard>[0] {
  return {
    /** @returns 按 Guard 请求的配置键返回对应测试占位 token。 */
    getOrThrow(
      key:
        | "BROWSER_SESSION_SECRET"
        | "CLIENT_SHARED_TOKEN"
        | "WORKER_SHARED_TOKEN",
    ) {
      if (key === "BROWSER_SESSION_SECRET") return sessionSecret;
      return key === "CLIENT_SHARED_TOKEN" ? clientToken : workerToken;
    },
  } as ConstructorParameters<typeof ApiAuthGuard>[0];
}

/**
 * @param method 模拟 adapter 提供的 HTTP 方法。
 * @param path 模拟不含秘密的请求 URL。
 * @param headers 当前场景的候选认证 header。
 * @returns 仅实现 Guard 使用面的 ExecutionContext stub，不执行真实 Nest 生命周期。
 */
function context(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        url: path,
        headers,
      }),
    }),
  } as ExecutionContext;
}
