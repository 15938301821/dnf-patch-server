/**
 * @fileoverview 验证浏览器会话 token 的签名、类型和过期行为，不连接数据库或读取凭据。
 * @module common/security
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接调用会话纯函数，第二个场景用 fake timer 替代系统时钟。输入为占位秘密与
 * 内存用户，输出为 token/payload；无数据库、HTTP 或持久化副作用。安全边界：覆盖完整性、用途
 * 和期限，但不证明 HTTPS 传输、数据库用户仍启用、会话撤销或跨用户资源隔离。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserSessionToken,
  userFromSession,
  verifyBrowserSessionToken,
} from "./browser-session.js";

/** 测试秘密仅满足长度，不是部署值，也不会写入快照。 */
const secret = "c".repeat(32);
/** 模拟数据库已认证用户的稳定主体与展示快照。 */
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "studio",
  displayName: "Studio",
};
const sessionId = "22222222-2222-4222-8222-222222222222";

describe("browser session tokens", () => {
  // 保护签发到认证上下文的主体映射，避免 displayName 被误用作用户 ID。
  it("verifies a matching token kind and returns a stable API user", () => {
    const token = createBrowserSessionToken(
      secret,
      user,
      sessionId,
      "access",
      60,
    );
    const payload = verifyBrowserSessionToken(secret, token, "access");

    expect(payload).toBeDefined();
    if (!payload) return;
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.subject).toBe(user.id);
    const sessionUser = userFromSession(payload);
    expect(sessionUser.id).toBe(user.id);
    expect(sessionUser).toMatchObject({
      username: "studio",
      displayName: "Studio",
    });
  });

  // fake timer 只替代 Date.now；篡改、refresh 冒充 access 和到期都必须无异常地拒绝。
  it("rejects tampered, wrong-kind, and expired tokens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:00:00Z"));
    const access = createBrowserSessionToken(
      secret,
      user,
      sessionId,
      "access",
      1,
    );
    const refresh = createBrowserSessionToken(
      secret,
      user,
      sessionId,
      "refresh",
      60,
    );

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
