/**
 * @fileoverview 验证统一 REST 守卫同时支持服务共享令牌、浏览器短期 token 与 Worker token。
 * @module common/security
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 会话需求）
 */
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { createBrowserSessionToken } from "./browser-session.js";
import { ApiAuthGuard } from "./api-auth.guard.js";

const clientToken = "c".repeat(32);
const workerToken = "w".repeat(32);
const sessionSecret = "s".repeat(32);

describe("ApiAuthGuard browser compatibility", () => {
  const guard = new ApiAuthGuard(configService());

  it("allows public login, registration, and refresh endpoints", () => {
    expect(guard.canActivate(context("POST", "/v1/auth/login"))).toBe(true);
    expect(guard.canActivate(context("POST", "/v1/auth/register"))).toBe(true);
    expect(guard.canActivate(context("POST", "/v1/auth/refresh"))).toBe(true);
  });

  it("allows browser access tokens without accepting them for internal routes", () => {
    const browserToken = createBrowserSessionToken(
      sessionSecret,
      {
        id: "11111111-1111-4111-8111-111111111111",
        username: "studio",
        displayName: "Studio",
      },
      "access",
      60,
    );

    expect(
      guard.canActivate(
        context("GET", "/v1/auth/me", {
          authorization: `Bearer ${browserToken}`,
        }),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        context("POST", "/v1/internal/jobs/claim", {
          authorization: `Bearer ${browserToken}`,
        }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it("still accepts service and worker shared tokens through their original headers", () => {
    expect(
      guard.canActivate(
        context("GET", "/v1/professions", {
          authorization: `Bearer ${clientToken}`,
        }),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        context("POST", "/v1/internal/jobs/claim", {
          "x-worker-token": workerToken,
        }),
      ),
    ).toBe(true);
  });

  it("rejects anonymous protected routes", () => {
    expect(() => guard.canActivate(context("GET", "/v1/professions"))).toThrow(
      UnauthorizedException,
    );
  });
});

function configService(): ConstructorParameters<typeof ApiAuthGuard>[0] {
  return {
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
