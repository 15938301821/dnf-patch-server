/**
 * @fileoverview 验证 Worker 重复注册的禁用与能力白名单不变量，不连接数据库。
 * @module worker
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan JOB-001-SHARED-FX
 */
import { describe, expect, it } from "vitest";
import { validateWorkerReregistration } from "./worker-registration.js";

describe("validateWorkerReregistration", () => {
  const existing = {
    displayName: "Local Worker",
    capabilities: ["shared-fx" as const],
    disabled: false,
  };

  it("accepts an identical enabled registration", () => {
    expect(
      validateWorkerReregistration(existing, "Local Worker", ["shared-fx"]),
    ).toBe("accepted");
  });

  it("rejects a disabled worker", () => {
    expect(
      validateWorkerReregistration(
        { ...existing, disabled: true },
        "Local Worker",
        ["shared-fx"],
      ),
    ).toBe("disabled");
  });

  it("rejects capability or identity changes", () => {
    expect(
      validateWorkerReregistration(existing, "Renamed Worker", ["shared-fx"]),
    ).toBe("identity-conflict");
    expect(
      validateWorkerReregistration(existing, "Local Worker", ["inventory"]),
    ).toBe("identity-conflict");
  });
});
