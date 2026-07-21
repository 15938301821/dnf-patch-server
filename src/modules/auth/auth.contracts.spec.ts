/**
 * @fileoverview 验证登录兼容已有六位密码，同时保持新注册密码的最低强度要求。
 * @module auth
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan N/A（对应当前默认本地用户需求）
 */
import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema } from "./auth.contracts.js";

describe("auth credential contracts", () => {
  it("accepts a six-character existing password only for login", () => {
    expect(
      loginSchema.safeParse({ username: "admin", password: "123456" }).success,
    ).toBe(true);
    expect(
      registerSchema.safeParse({
        username: "admin",
        password: "123456",
        displayName: "Admin",
        registrationToken: "r".repeat(32),
      }).success,
    ).toBe(false);
  });
});
