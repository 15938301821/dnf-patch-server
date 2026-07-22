/**
 * @fileoverview 验证共享特效完成只接受完整、finalized 且哈希一致的六阶段证据；不连接数据库。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { describe, expect, it } from "vitest";
import { sharedFxStages } from "./shared-fx.contracts.js";
import {
  resolveSharedFxCompletionEvidence,
  type SharedFxStoredEvidence,
} from "./shared-fx-evidence-integrity.js";

const validationSha256 = "F".repeat(64);

describe("resolveSharedFxCompletionEvidence", () => {
  it("accepts exactly the finalized fixed-stage evidence set", () => {
    const result = resolveSharedFxCompletionEvidence(
      sharedFxStages,
      validationSha256,
      evidence(),
    );

    expect(result).toEqual({
      independentValidationArtifactId: "artifact-independent-validation",
      independentValidationSha256: validationSha256,
    });
  });

  it.each([
    {
      name: "a missing stage",
      records: evidence().filter((record) => record.stage !== "npk"),
      resultSha256: validationSha256,
    },
    {
      name: "an unfinalized upload session",
      records: evidence({
        runtime: { uploadFinalized: false },
      }),
      resultSha256: validationSha256,
    },
    {
      name: "a server Artifact hash mismatch",
      records: evidence({
        aseprite: { persistedArtifactSha256: "B".repeat(64) },
      }),
      resultSha256: validationSha256,
    },
    {
      name: "a result hash unrelated to independent validation",
      records: evidence(),
      resultSha256: "B".repeat(64),
    },
  ])("rejects $name", ({ records, resultSha256 }) => {
    expect(
      resolveSharedFxCompletionEvidence(sharedFxStages, resultSha256, records),
    ).toBeUndefined();
  });
});

function evidence(
  overrides: Partial<Record<string, Partial<SharedFxStoredEvidence>>> = {},
): SharedFxStoredEvidence[] {
  return sharedFxStages.map((stage) => {
    const artifactSha256 =
      stage === "independent-validation" ? validationSha256 : "A".repeat(64);
    return {
      stage,
      artifactId: `artifact-${stage}`,
      artifactSha256,
      persistedArtifactSha256: artifactSha256,
      uploadArtifactId: `artifact-${stage}`,
      uploadFinalized: true,
      ...overrides[stage],
    };
  });
}
