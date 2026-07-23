/**
 * @fileoverview 验证 Worker Inventory 输入必须携带精确租约与 Artifact，且不能自报 Run 归属。
 * @module npk
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - Worker Inventory 直接实施需求
 */
import { describe, expect, it } from "vitest";
import {
  createWorkerInventorySchema,
  type CreateWorkerInventoryInput,
} from "./npk.contracts.js";

describe("createWorkerInventorySchema", () => {
  it("accepts a bounded exact-lease inventory payload", () => {
    expect(createWorkerInventorySchema.safeParse(input()).success).toBe(true);
  });

  it.each([
    { leaseId: undefined },
    { inventoryArtifactId: undefined },
    { runId: "44444444-4444-4444-8444-444444444444" },
    { projectId: "55555555-5555-4555-8555-555555555555" },
  ])("rejects missing evidence or caller-owned scope %#", (override) => {
    expect(
      createWorkerInventorySchema.safeParse({ ...input(), ...override })
        .success,
    ).toBe(false);
  });
});

function input(): CreateWorkerInventoryInput {
  return {
    workerId: "11111111-1111-4111-8111-111111111111",
    leaseId: "22222222-2222-4222-8222-222222222222",
    attempt: 1,
    inventoryArtifactId: "33333333-3333-4333-8333-333333333333",
    sourceLabel: "verified-source",
    sourceLength: 1,
    sourceSha256: "A".repeat(64),
    entries: [
      {
        internalPath: "fx/frame.png",
        imgVersion: 1,
        frameCount: 1,
        metadataSha256: "B".repeat(64),
      },
    ],
  };
}
