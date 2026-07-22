/**
 * @fileoverview 验证共享特效阶段证据输入只接受固定阶段、Artifact ID 与精确租约；不连接数据库。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { describe, expect, it } from "vitest";
import { recordSharedFxStageEvidenceSchema } from "./shared-fx-stage-evidence.contracts.js";

const input = {
  workerId: "11111111-1111-4111-8111-111111111111",
  leaseId: "22222222-2222-4222-8222-222222222222",
  attempt: 1,
  stage: "independent-validation",
  artifactId: "33333333-3333-4333-8333-333333333333",
};

describe("recordSharedFxStageEvidenceSchema", () => {
  it("accepts a fixed stage bound to an Artifact and exact lease", () => {
    expect(recordSharedFxStageEvidenceSchema.parse(input)).toEqual(input);
  });

  it("rejects caller-supplied paths, hashes and unregistered stages", () => {
    expect(
      recordSharedFxStageEvidenceSchema.safeParse({
        ...input,
        sourcePath: "C:\\Games\\DNF",
      }).success,
    ).toBe(false);
    expect(
      recordSharedFxStageEvidenceSchema.safeParse({
        ...input,
        artifactSha256: "A".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      recordSharedFxStageEvidenceSchema.safeParse({
        ...input,
        stage: "publish",
      }).success,
    ).toBe(false);
  });
});
