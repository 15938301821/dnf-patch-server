/**
 * @fileoverview 验证浏览器登录必须持有客户端共享凭据，刷新只接受服务端签发的 HttpOnly token。
 * @module auth
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 会话需求）
 */
import { UnauthorizedException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AuthService } from "./auth.service.js";

const clientToken = "c".repeat(32);

describe("AuthService browser sessions", () => {
  const service = new AuthService(configService());

  it("requires the client shared token before issuing browser sessions", () => {
    expect(() =>
      service.login({ username: "studio", password: "wrong" }),
    ).toThrow(UnauthorizedException);

    const result = service.login({ username: "studio", password: clientToken });
    expect(result.session.accessToken).toMatch(/^session\./u);
    expect(result.refreshToken).toMatch(/^session\./u);
    expect(result.session.user.id).toMatch(/^browser\.[a-f0-9]{16}$/u);
    expect(result.session.user).toMatchObject({
      username: "studio",
    });
  });

  it("rotates a valid refresh token", () => {
    const first = service.login({ username: "studio", password: clientToken });
    const refreshed = service.refresh(first.refreshToken);

    expect(refreshed.session.accessToken).toMatch(/^session\./u);
    expect(refreshed.refreshToken).toMatch(/^session\./u);
    expect(refreshed.refreshToken).not.toBe(first.refreshToken);
  });
});

function configService(): ConstructorParameters<typeof AuthService>[0] {
  const config = {
    getOrThrow(): string {
      return clientToken;
    },
  };
  return config as unknown as ConstructorParameters<typeof AuthService>[0];
}
