/**
 * @fileoverview 定义共享特效 Job 的冻结声明式契约；不声明 NPK/IMG 路径、工具命令或部署操作。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { z } from "zod";
import {
  boundedJsonRecordSchema,
  clientIdSchema,
  sha256Schema,
} from "../../common/contracts/index.js";
import { declarativeParametersSchema } from "../guardrail/guardrail.contracts.js";

export const sharedFxStages = [
  "inventory",
  "material",
  "aseprite",
  "runtime",
  "npk",
  "independent-validation",
] as const;

export const sharedFxStageSchema = z.enum(sharedFxStages);

const sharedFxStagePlanSchema = z.tuple([
  z.literal("inventory"),
  z.literal("material"),
  z.literal("aseprite"),
  z.literal("runtime"),
  z.literal("npk"),
  z.literal("independent-validation"),
]);

const sharedFxSnapshotEvidenceSchema = z
  .object({
    snapshotId: z.uuid(),
    rootRulesSha256: sha256Schema,
    manifestSha256: sha256Schema,
    promptTreeSha256: sha256Schema,
    toolCatalogSha256: sha256Schema,
  })
  .strict();

const sharedFxPolicyEvidenceSchema = z
  .object({
    policyId: clientIdSchema,
    policySha256: sha256Schema,
  })
  .strict();

const sharedFxInvariantsSchema = z
  .object({
    unapprovedPixelChangesAllowed: z.literal(false),
    geometryChangesAllowed: z.literal(false),
    anchorChangesAllowed: z.literal(false),
    alphaErasureAllowed: z.literal(false),
  })
  .strict();

const sharedFxReviewRequirementsSchema = z
  .object({
    requiredEvidenceStages: sharedFxStagePlanSchema,
    independentValidationRequired: z.literal(true),
    manualReviewRequired: z.literal(true),
    deploymentAuthorized: z.literal(false),
    deploymentPerformed: z.literal(false),
    fullSkillCoverageProven: z.literal(false),
    clientCompatibilityProven: z.literal(false),
  })
  .strict();

const sharedFxParametersSchema = z
  .object({
    workflow: z.literal("shared-fx-v1"),
    sourceSnapshot: sharedFxSnapshotEvidenceSchema,
    policy: sharedFxPolicyEvidenceSchema,
    stages: sharedFxStagePlanSchema,
    invariants: sharedFxInvariantsSchema,
    review: sharedFxReviewRequirementsSchema,
  })
  .strict();

export const sharedFxJobPayloadV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: clientIdSchema,
    parameters: sharedFxParametersSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!boundedJsonRecordSchema.safeParse(value).success) {
      context.addIssue({
        code: "custom",
        message: "共享特效 Job 不能超过声明式 JSON 预算。",
      });
    }
    if (!declarativeParametersSchema.safeParse(value.parameters).success) {
      context.addIssue({
        code: "custom",
        path: ["parameters"],
        message: "共享特效 Job 包含不安全的非声明式字段。",
      });
    }
  });

export type SharedFxJobPayloadV1 = z.infer<typeof sharedFxJobPayloadV1Schema>;
export type SharedFxStage = z.infer<typeof sharedFxStageSchema>;

export interface SharedFxPayloadContext {
  profileId: string;
  policyId: string;
  policySha256: string;
  snapshot: {
    id: string;
    rootRulesSha256: string;
    manifestSha256?: string | undefined;
    promptTreeSha256: string;
    toolCatalogSha256: string;
  };
}

/**
 * 根据已读取的 Project Snapshot 与 Factory v2 策略构建固定的共享特效声明式 Job。
 * 缺少 manifest 哈希时拒绝构建，避免把未核验的资源映射交给 Worker。
 */
export function createSharedFxJobPayload(
  context: SharedFxPayloadContext,
): SharedFxJobPayloadV1 {
  if (!context.snapshot.manifestSha256) {
    throw new Error("SHARED_FX_MANIFEST_REQUIRED");
  }
  return sharedFxJobPayloadV1Schema.parse({
    schemaVersion: 1,
    profileId: context.profileId,
    parameters: {
      workflow: "shared-fx-v1",
      sourceSnapshot: {
        snapshotId: context.snapshot.id,
        rootRulesSha256: context.snapshot.rootRulesSha256,
        manifestSha256: context.snapshot.manifestSha256,
        promptTreeSha256: context.snapshot.promptTreeSha256,
        toolCatalogSha256: context.snapshot.toolCatalogSha256,
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
        requiredEvidenceStages: [
          "inventory",
          "material",
          "aseprite",
          "runtime",
          "npk",
          "independent-validation",
        ],
        independentValidationRequired: true,
        manualReviewRequired: true,
        deploymentAuthorized: false,
        deploymentPerformed: false,
        fullSkillCoverageProven: false,
        clientCompatibilityProven: false,
      },
    },
  });
}

/**
 * 复核 payload 是否仍绑定当前 Factory 策略与 Run 的 Snapshot。
 * 该比较在持久化前执行，使直接调用通用 Run API 也不能伪造来源哈希。
 */
export function hasSharedFxPayloadBinding(
  payload: unknown,
  context: SharedFxPayloadContext,
): boolean {
  if (!context.snapshot.manifestSha256) return false;
  const parsed = sharedFxJobPayloadV1Schema.safeParse(payload);
  if (!parsed.success) return false;
  const { parameters } = parsed.data;
  return (
    parsed.data.profileId === context.profileId &&
    parameters.policy.policyId === context.policyId &&
    parameters.policy.policySha256.toUpperCase() ===
      context.policySha256.toUpperCase() &&
    parameters.sourceSnapshot.snapshotId === context.snapshot.id &&
    parameters.sourceSnapshot.rootRulesSha256.toUpperCase() ===
      context.snapshot.rootRulesSha256.toUpperCase() &&
    parameters.sourceSnapshot.manifestSha256.toUpperCase() ===
      context.snapshot.manifestSha256.toUpperCase() &&
    parameters.sourceSnapshot.promptTreeSha256.toUpperCase() ===
      context.snapshot.promptTreeSha256.toUpperCase() &&
    parameters.sourceSnapshot.toolCatalogSha256.toUpperCase() ===
      context.snapshot.toolCatalogSha256.toUpperCase()
  );
}
