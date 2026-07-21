/**
 * @fileoverview 验证浏览器任务状态不会隐藏失败或安全阻断终态。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端任务状态直接需求）
 */
import { describe, expect, it } from "vitest";
import { mapPatchTaskStatus } from "./patch-task-status.js";

describe("mapPatchTaskStatus", () => {
  it("preserves failed and blocked terminal states", () => {
    expect(mapPatchTaskStatus("failed", "queued")).toBe("failed");
    expect(mapPatchTaskStatus("blocked", "queued")).toBe("blocked");
    expect(mapPatchTaskStatus("running", "blocked")).toBe("blocked");
    expect(mapPatchTaskStatus("failed", "blocked")).toBe("failed");
  });

  it("maps active and successful task states", () => {
    expect(mapPatchTaskStatus("queued", "queued")).toBe("queued");
    expect(mapPatchTaskStatus("running", "queued")).toBe("running");
    expect(mapPatchTaskStatus("passed", "passed")).toBe("passed");
  });
});
