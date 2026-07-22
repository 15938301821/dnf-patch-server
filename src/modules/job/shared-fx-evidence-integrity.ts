/**
 * @fileoverview 校验共享特效 Job 的阶段证据集合是否可支持通过完成；不读写数据库或调用 Worker。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { sha256Schema } from "../../common/contracts/index.js";
import {
  sharedFxStages,
  sharedFxStageSchema,
  type SharedFxStage,
} from "./shared-fx.contracts.js";

export interface SharedFxStoredEvidence {
  stage: unknown;
  artifactId: string;
  artifactSha256: string;
  persistedArtifactSha256: string;
  uploadArtifactId: string | null;
  uploadFinalized: boolean;
}

export interface SharedFxCompletionEvidence {
  independentValidationArtifactId: string;
  independentValidationSha256: string;
}

/**
 * 只有固定六阶段均有一条、会话仍为 finalized 且 Artifact 哈希未漂移的证据时才返回独立验证 Artifact。
 * 当前 Worker 的 resultSha256 还必须与该 Artifact 的服务器来源哈希一致，避免把任意摘要写入 passed attempt。
 */
export function resolveSharedFxCompletionEvidence(
  expectedStages: readonly SharedFxStage[],
  resultSha256: string | undefined,
  evidence: readonly SharedFxStoredEvidence[],
): SharedFxCompletionEvidence | undefined {
  if (!hasFixedStagePlan(expectedStages)) return undefined;
  const result = sha256Schema.safeParse(resultSha256);
  if (!result.success || evidence.length !== sharedFxStages.length) {
    return undefined;
  }

  const evidenceByStage = new Map<SharedFxStage, SharedFxStoredEvidence>();
  for (const record of evidence) {
    const stage = sharedFxStageSchema.safeParse(record.stage);
    const artifactHash = sha256Schema.safeParse(record.artifactSha256);
    const persistedHash = sha256Schema.safeParse(
      record.persistedArtifactSha256,
    );
    if (
      !stage.success ||
      !artifactHash.success ||
      !persistedHash.success ||
      evidenceByStage.has(stage.data) ||
      !record.uploadFinalized ||
      record.uploadArtifactId !== record.artifactId ||
      artifactHash.data.toUpperCase() !== persistedHash.data.toUpperCase()
    ) {
      return undefined;
    }
    evidenceByStage.set(stage.data, record);
  }

  if (evidenceByStage.size !== sharedFxStages.length) return undefined;
  for (const stage of sharedFxStages) {
    if (!evidenceByStage.has(stage)) return undefined;
  }
  const independentValidation = evidenceByStage.get("independent-validation");
  if (
    !independentValidation ||
    independentValidation.artifactSha256.toUpperCase() !==
      result.data.toUpperCase()
  ) {
    return undefined;
  }
  return {
    independentValidationArtifactId: independentValidation.artifactId,
    independentValidationSha256:
      independentValidation.artifactSha256.toUpperCase(),
  };
}

function hasFixedStagePlan(expectedStages: readonly SharedFxStage[]): boolean {
  return (
    expectedStages.length === sharedFxStages.length &&
    expectedStages.every((stage, index) => stage === sharedFxStages[index])
  );
}
