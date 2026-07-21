/**
 * @fileoverview 验证持久化用户注册、密码登录和刷新会话；不连接真实数据库或记录凭据。
 * @module auth
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 会话需求）
 */
import { UnauthorizedException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "./auth.service.js";
import type { AuthUserRecord } from "./auth.repository.js";
import { hashPassword } from "./password.js";

const sessionSecret = "s".repeat(32);
const registrationToken = "r".repeat(32);
const userId = "11111111-1111-4111-8111-111111111111";

describe("AuthService browser sessions", () => {
  let records: AuthUserRecord[];
  let service: AuthService;

  beforeEach(async () => {
    records = [
      {
        id: userId,
        username: "studio",
        displayName: "Studio",
        password: await hashPassword("correct-password"),
      },
    ];
    service = new AuthService(configService(), repository(records));
  });

  it("verifies the persisted password before issuing a stable user session", async () => {
    await expect(
      service.login({ username: "studio", password: "wrong-password" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const result = await service.login({
      username: "STUDIO",
      password: "correct-password",
    });
    expect(result.session.accessToken).toMatch(/^session\./u);
    expect(result.refreshToken).toMatch(/^session\./u);
    expect(result.session.user).toEqual({
      id: userId,
      username: "studio",
      displayName: "Studio",
    });
  });

  it("rotates a valid refresh token and rejects deleted users", async () => {
    const first = await service.login({
      username: "studio",
      password: "correct-password",
    });
    const refreshed = await service.refresh(first.refreshToken);

    expect(refreshed.session.accessToken).toMatch(/^session\./u);
    expect(refreshed.refreshToken).not.toBe(first.refreshToken);

    records.splice(0, records.length);
    await expect(service.refresh(refreshed.refreshToken)).rejects.toMatchObject(
      {
        response: { code: "REFRESH_TOKEN_INVALID" },
      },
    );
  });

  it("uses the deployment registration token only to create a user", async () => {
    await expect(
      service.register({
        username: "artist",
        displayName: "Artist",
        password: "artist-password",
        registrationToken: "x".repeat(32),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const registered = await service.register({
      username: "artist",
      displayName: "Artist",
      password: "artist-password",
      registrationToken,
    });
    expect(registered.session.user).toMatchObject({
      username: "artist",
      displayName: "Artist",
    });
    expect(records).toHaveLength(2);
  });
});

function configService(): ConstructorParameters<typeof AuthService>[0] {
  const values = {
    BROWSER_SESSION_SECRET: sessionSecret,
    USER_REGISTRATION_TOKEN: registrationToken,
  };
  return {
    get(key: keyof typeof values) {
      return values[key];
    },
    getOrThrow(key: keyof typeof values) {
      return values[key];
    },
  } as ConstructorParameters<typeof AuthService>[0];
}

function repository(
  records: AuthUserRecord[],
): ConstructorParameters<typeof AuthService>[1] {
  return {
    findByNormalizedUsername(normalizedUsername: string) {
      return Promise.resolve(
        records.find(
          (record) => record.username.toLowerCase() === normalizedUsername,
        ),
      );
    },
    findById(id: string) {
      return Promise.resolve(records.find((record) => record.id === id));
    },
    create(input: {
      id: string;
      username: string;
      displayName: string;
      password: AuthUserRecord["password"];
    }) {
      const record: AuthUserRecord = {
        id: input.id,
        username: input.username,
        displayName: input.displayName,
        password: input.password,
      };
      records.push(record);
      return Promise.resolve(record);
    },
  } as ConstructorParameters<typeof AuthService>[1];
}
