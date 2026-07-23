/**
 * @fileoverview 验证共享 token 比较的相等、异长和异值分支；不启动 Guard/Nest，也不测量或证明
 * 操作系统级恒定时间特性。
 * @module common/security/tests
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接调用 secureEqual。输入为重复字符占位值，输出为布尔值；无 Mock、网络
 * 或秘密副作用。安全边界：测试保护比较结果，不证明 header 解析、路由认证域或资源所有权。
 */
import { describe, expect, it } from "vitest";
import { secureEqual } from "./client-token.guard.js";

describe("constant-time token comparison", () => {
  // 相同长度和内容是唯一接受条件。
  it("accepts identical values", () => {
    expect(secureEqual("a".repeat(32), "a".repeat(32))).toBe(true);
  });

  // 异长值不能传给 timingSafeEqual，异内容值必须稳定拒绝。
  it("rejects mismatched lengths and values", () => {
    expect(secureEqual("short", "a".repeat(32))).toBe(false);
    expect(secureEqual("b".repeat(32), "a".repeat(32))).toBe(false);
  });
});
