/**
 * @fileoverview 验证浏览器会话 token 的签名、类型和过期行为，不连接数据库或读取凭据。
 * @module common/security
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 会话需求）
 */
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserSessionToken,
  userFromSession,
  verifyBrowserSessionToken,
} from "./browser-session.js";

const secret = "c".repeat(32);
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "studio",
  displayName: "Studio",
};

describe("browser session tokens", () => {
  it("verifies a matching token kind and returns a stable API user", () => {
    const token = createBrowserSessionToken(secret, user, "access", 60);
    const payload = verifyBrowserSessionToken(secret, token, "access");

    expect(payload).toBeDefined();
    if (!payload) return;
    expect(payload.subject).toBe(user.id);
    const sessionUser = userFromSession(payload);
    expect(sessionUser.id).toBe(user.id);
    expect(sessionUser).toMatchObject({
      username: "studio",
      displayName: "Studio",
    });
  });

  it("rejects tampered, wrong-kind, and expired tokens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:00:00Z"));
    const access = createBrowserSessionToken(secret, user, "access", 1);
    const refresh = createBrowserSessionToken(secret, user, "refresh", 60);

    expect(
      verifyBrowserSessionToken(secret, `${access}x`, "access"),
    ).toBeUndefined();
    expect(
      verifyBrowserSessionToken(secret, refresh, "access"),
    ).toBeUndefined();

    vi.setSystemTime(new Date("2026-07-21T00:00:02Z"));
    expect(verifyBrowserSessionToken(secret, access, "access")).toBeUndefined();
    vi.useRealTimers();
  });
});
