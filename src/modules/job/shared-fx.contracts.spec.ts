/**
 * @fileoverview 验证共享特效冻结 Job 的来源、策略、阶段和安全不变量；不连接数据库或调用 Worker。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { describe, expect, it } from "vitest";
import {
  createSharedFxJobPayload,
  hasSharedFxPayloadBinding,
  sharedFxJobPayloadV1Schema,
} from "./shared-fx.contracts.js";

const context = {
  profileId: "shared-fx-profile",
  policyId: "shared-fx-policy",
  policySha256: "A".repeat(64),
  snapshot: {
    id: "11111111-1111-4111-8111-111111111111",
    rootRulesSha256: "B".repeat(64),
    manifestSha256: "C".repeat(64),
    promptTreeSha256: "D".repeat(64),
    toolCatalogSha256: "E".repeat(64),
  },
};

describe("sharedFxJobPayloadV1Schema", () => {
  it("freezes source, policy, staged evidence and immutable safety defaults", () => {
    const payload = createSharedFxJobPayload(context);

    expect(payload).toMatchObject({
      schemaVersion: 1,
      profileId: context.profileId,
      parameters: {
        workflow: "shared-fx-v1",
        sourceSnapshot: {
          snapshotId: context.snapshot.id,
          manifestSha256: context.snapshot.manifestSha256,
        },
        policy: {
          policyId: context.policyId,
          policySha256: context.policySha256,
        },
        stages: [
          "inventory",
          "material",
          "aseprite",
          "runtime",
          "npk",
          "independent-validation",
        ],
        invariants: {
          unapprovedPixelChangesAllowed: false,
          geometryChangesAllowed: false,
          anchorChangesAllowed: false,
          alphaErasureAllowed: false,
        },
        review: {
          independentValidationRequired: true,
          manualReviewRequired: true,
          deploymentAuthorized: false,
          deploymentPerformed: false,
          fullSkillCoverageProven: false,
          clientCompatibilityProven: false,
        },
      },
    });
    expect(hasSharedFxPayloadBinding(payload, context)).toBe(true);
  });

  it("fails closed for a missing manifest or a changed source hash", () => {
    expect(() =>
      createSharedFxJobPayload({
        ...context,
        snapshot: {
          id: context.snapshot.id,
          rootRulesSha256: context.snapshot.rootRulesSha256,
          promptTreeSha256: context.snapshot.promptTreeSha256,
          toolCatalogSha256: context.snapshot.toolCatalogSha256,
        },
      }),
    ).toThrow("SHARED_FX_MANIFEST_REQUIRED");

    const payload = createSharedFxJobPayload(context);
    const changed = {
      ...payload,
      parameters: {
        ...payload.parameters,
        sourceSnapshot: {
          ...payload.parameters.sourceSnapshot,
          manifestSha256: "F".repeat(64),
        },
      },
    };
    expect(sharedFxJobPayloadV1Schema.safeParse(changed).success).toBe(true);
    expect(hasSharedFxPayloadBinding(changed, context)).toBe(false);
  });

  it("rejects path and deployment fields outside the frozen contract", () => {
    const payload = createSharedFxJobPayload(context);
    expect(
      sharedFxJobPayloadV1Schema.safeParse({
        ...payload,
        parameters: {
          ...payload.parameters,
          sourcePath: "C:\\Games\\DNF",
        },
      }).success,
    ).toBe(false);
    expect(
      sharedFxJobPayloadV1Schema.safeParse({
        ...payload,
        parameters: {
          ...payload.parameters,
          review: {
            ...payload.parameters.review,
            deploymentAuthorized: true,
          },
        },
      }).success,
    ).toBe(false);
  });
});
