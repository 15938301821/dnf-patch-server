/**
 * @fileoverview 构造浏览器 production 三证据预览测试使用的当前 V5 与历史 V3/V4
 * provenance；不模拟数据库查询、Run 所有权、上传 finalize 或短期下载授权。
 * @module modules/job/patch-task-production-preview-fixture
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - creative-stable-frame 生产证据同步
 *
 * 调用关系：预览 Repository 测试把本文件产物同时作为 upload session 与 Artifact provenance。
 * 输入是测试中的 Job/skill/Artifact 身份，输出严格同代的 validation、source 或 result JSON。
 * 副作用：无。安全边界：缺省值只生成 V5/quality V5；历史代际必须显式选择，不能被误用为
 * 当前 passed 或 Package 的证据。
 */

/** 浏览器预览测试允许构造的 creative 证据代际。 */
export type ProductionPreviewEvidenceGeneration =
  | "current-v5"
  | "historical-v4"
  | "historical-quality-v3"
  | "historical-v3";

/** 三项预览反向绑定所需的测试身份。 */
export interface ProductionPreviewEvidenceIdentity {
  jobId: string;
  skillId: string;
  validationArtifactId: string;
  sourceArtifactId: string;
}

interface GenerationContract {
  schemaVersion: 3 | 4 | 5;
  validationKind:
    | "profession-creative-validation-v3"
    | "profession-creative-validation-v4"
    | "profession-creative-validation-v5";
  sourceKind:
    | "profession-creative-source-frame-preview-v3"
    | "profession-creative-source-frame-preview-v4"
    | "profession-creative-source-frame-preview-v5";
  resultKind:
    | "profession-creative-result-preview-v3"
    | "profession-creative-result-preview-v4"
    | "profession-creative-result-preview-v5";
}

/** 构造 validation provenance；generation 缺省时始终返回当前 V5。 */
export function createCreativeValidationProvenance(
  identity: ProductionPreviewEvidenceIdentity,
  generation: ProductionPreviewEvidenceGeneration = "current-v5",
): Record<string, unknown> {
  const contract = generationContract(generation);
  return {
    ...creativeBaseProvenance(identity, generation),
    kind: contract.validationKind,
    asepriteProjects: {
      artifactId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sha256: "3".repeat(64),
    },
  };
}

/** 构造 source preview provenance；generation 缺省时始终返回当前 V5。 */
export function createCreativeSourcePreviewProvenance(
  identity: ProductionPreviewEvidenceIdentity,
  generation: ProductionPreviewEvidenceGeneration = "current-v5",
): Record<string, unknown> {
  const contract = generationContract(generation);
  return {
    ...creativeBaseProvenance(identity, generation),
    kind: contract.sourceKind,
    frame: productionPreviewComparisonFrame(),
    asepriteValidation: {
      artifactId: identity.validationArtifactId,
      sha256: "4".repeat(64),
    },
  };
}

/** 构造 result preview provenance，并允许单个测试显式制造帧漂移。 */
export function createCreativeResultPreviewProvenance(
  identity: ProductionPreviewEvidenceIdentity,
  options: {
    generation?: ProductionPreviewEvidenceGeneration;
    frameOverrides?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const generation = options.generation ?? "current-v5";
  const contract = generationContract(generation);
  return {
    ...creativeBaseProvenance(identity, generation),
    kind: contract.resultKind,
    frame: {
      ...productionPreviewComparisonFrame(),
      ...options.frameOverrides,
    },
    asepriteValidation: {
      artifactId: identity.validationArtifactId,
      sha256: "4".repeat(64),
    },
    sourcePreview: {
      artifactId: identity.sourceArtifactId,
      sha256: "5".repeat(64),
    },
  };
}

/** 当前新 Run 对浏览器公开的 stable-frame quality V5。 */
export function currentStableFrameQualityEvidence(): Record<string, unknown> {
  return {
    ...historicalStableFrameQualityV4Evidence(),
    schemaVersion: 5,
    sourceTopologyCorrelation: 0.8,
  };
}

/** 历史 creative V3 Run 对浏览器公开的 stable-frame quality V2。 */
export function historicalStableFrameQualityEvidence(): Record<
  string,
  unknown
> {
  return {
    schemaVersion: 2,
    evaluatedFrameCount: 1,
    evaluatedPixelCount: 2,
    isolatedNoiseRatio: 0,
    continuousBandRatio: 0.8,
    brightCoreRatio: 0.1,
    edgeContrast: 64,
  };
}

/** 旧 V4 Run 对浏览器公开的 stable-frame quality V3。 */
export function historicalStableFrameQualityV3Evidence(): Record<
  string,
  unknown
> {
  return {
    ...historicalStableFrameQualityEvidence(),
    schemaVersion: 3,
    strongEdgeRatio: 0.1,
    periodicStripeRatio: 0,
  };
}

/** 完整历史 V4 Run 对浏览器公开的 stable-frame quality V4。 */
export function historicalStableFrameQualityV4Evidence(): Record<
  string,
  unknown
> {
  return {
    ...historicalStableFrameQualityV3Evidence(),
    schemaVersion: 4,
    maximumWhiteLineRatio: 0,
    maximumDxt1BoundaryJumpRatio: 0,
  };
}

/** 浏览器可见的帧身份，不含 Worker 内部 decoded BGRA 摘要。 */
export function productionPreviewPublicFrame(): Record<string, unknown> {
  return {
    entryIndex: 0,
    frameIndex: 3,
    internalPath: "sprite/effect/a.img",
    width: 16,
    height: 12,
    canvasWidth: 32,
    canvasHeight: 24,
    x: 2,
    y: -1,
  };
}

function creativeBaseProvenance(
  identity: ProductionPreviewEvidenceIdentity,
  generation: ProductionPreviewEvidenceGeneration,
): Record<string, unknown> {
  const contract = generationContract(generation);
  return {
    schemaVersion: contract.schemaVersion,
    jobId: identity.jobId,
    attempt: 2,
    skillId: identity.skillId,
    source: {
      runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      inventoryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sourceSha256: "A".repeat(64),
      frameManifestArtifactId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      frameManifestSha256: "B".repeat(64),
      frameManifestToolSha256: "C".repeat(64),
    },
    engineerPlan: {
      artifactId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      sha256: "D".repeat(64),
    },
    referenceImage: {
      imageAttemptId: "10101010-1010-4010-8010-101010101010",
      artifactId: "11111111-1111-4111-8111-111111111112",
      sha256: "E".repeat(64),
    },
    referenceTransferQuality: qualityForGeneration(generation),
    aseprite: {
      profileId: "aseprite-cli",
      binarySha256: "1".repeat(64),
      adapterSha256: "2".repeat(64),
    },
    safety: {
      referenceImageUsedAsRuntimeRgbSource: false,
      referenceImageUsedAsStyleAndComposition: true,
      creativeVisibleRgbReconstruction: true,
      referenceImageDirectPixelReplacement: false,
      referenceTransferQualityPassed: true,
      sourceGeometryPreserved: true,
      sourceAlphaPreserved: true,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
  };
}

function qualityForGeneration(
  generation: ProductionPreviewEvidenceGeneration,
): Record<string, unknown> {
  switch (generation) {
    case "current-v5":
      return currentStableFrameQualityEvidence();
    case "historical-v4":
      return historicalStableFrameQualityV4Evidence();
    case "historical-quality-v3":
      return historicalStableFrameQualityV3Evidence();
    case "historical-v3":
      return historicalStableFrameQualityEvidence();
  }
}

function productionPreviewComparisonFrame(): Record<string, unknown> {
  return {
    ...productionPreviewPublicFrame(),
    decodedBgraSha256: "7".repeat(64),
  };
}

function generationContract(
  generation: ProductionPreviewEvidenceGeneration,
): GenerationContract {
  switch (generation) {
    case "current-v5":
      return {
        schemaVersion: 5,
        validationKind: "profession-creative-validation-v5",
        sourceKind: "profession-creative-source-frame-preview-v5",
        resultKind: "profession-creative-result-preview-v5",
      };
    case "historical-v4":
    case "historical-quality-v3":
      return {
        schemaVersion: 4,
        validationKind: "profession-creative-validation-v4",
        sourceKind: "profession-creative-source-frame-preview-v4",
        resultKind: "profession-creative-result-preview-v4",
      };
    case "historical-v3":
      return {
        schemaVersion: 3,
        validationKind: "profession-creative-validation-v3",
        sourceKind: "profession-creative-source-frame-preview-v3",
        resultKind: "profession-creative-result-preview-v3",
      };
  }
}
