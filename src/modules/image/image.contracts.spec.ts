/**
 * @fileoverview 验证 Image Attempt 状态与输出证据的绑定边界，不连接数据库。
 * @module image
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan N/A（服务端证据完整性收紧）
 */
import { describe, expect, it } from "vitest";
import { createImageAttemptSchema } from "./image.contracts.js";

const base = {
  promptSha256: "A".repeat(64),
  inputSnapshotSha256: "B".repeat(64),
  generationConfigSha256: "C".repeat(64),
  adapterIdentity: "runtime-adapter",
  directRuntimeUseAllowed: false,
};
const outputArtifactId = "11111111-1111-4111-8111-111111111111";

describe("createImageAttemptSchema", () => {
  it("requires output evidence for generated and adapted attempts", () => {
    for (const status of ["generated", "adapted"] as const) {
      expect(
        createImageAttemptSchema.safeParse({ ...base, status }).success,
      ).toBe(false);
      expect(
        createImageAttemptSchema.safeParse({
          ...base,
          status,
          outputArtifactId,
        }).success,
      ).toBe(true);
    }
  });

  it("keeps planned attempts valid before an output exists", () => {
    expect(
      createImageAttemptSchema.safeParse({ ...base, status: "planned" })
        .success,
    ).toBe(true);
  });
});
