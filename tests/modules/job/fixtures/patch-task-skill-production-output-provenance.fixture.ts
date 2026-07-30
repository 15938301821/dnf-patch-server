/**
 * @fileoverview 构造 Profession passed 接收测试使用的当前 V4 与历史 V3 输出 provenance；
 * 不模拟数据库查询、上传 finalize 或对象正文校验。
 * @module modules/job/patch-task-skill-production-output-provenance-fixture
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - creative-stable-frame 生产证据同步
 *
 * 调用关系：事务 fixture 为四个输出角色调用当前构造器；旧代拒绝测试显式调用历史构造器。
 * 输入输出：使用固定测试 UUID 和哈希，返回可放入 upload session 与 Artifact JSON 的对象。
 * 副作用：无。安全边界：默认只能生成 schemaVersion 4 + quality V4；历史函数不能用于成功场景。
 */
import { skillProductionFixture } from "./patch-task-skill-production.fixture-ids.js";

/** 构造当前 projects V4 provenance，作为 passed 接收的质量事实源。 */
export function currentProjectsProvenance(): Record<string, unknown> {
  return {
    ...currentBaseOutputProvenance(),
    kind: "profession-creative-projects-v4",
  };
}

/** 构造当前 validation V4 provenance，并绑定同代 projects Artifact。 */
export function currentValidationProvenance(
  qualityOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...currentBaseOutputProvenance(qualityOverrides),
    kind: "profession-creative-validation-v4",
    asepriteProjects: {
      artifactId: skillProductionFixture.projectsArtifactId,
      sha256: "3".repeat(64),
    },
  };
}

/** 构造当前 source preview V4 provenance，并绑定同代 validation Artifact。 */
export function currentSourcePreviewProvenance(): Record<string, unknown> {
  return {
    ...currentBaseOutputProvenance(),
    kind: "profession-creative-source-frame-preview-v4",
    frame: comparisonFrame(),
    asepriteValidation: {
      artifactId: skillProductionFixture.validationArtifactId,
      sha256: "4".repeat(64),
    },
  };
}

/** 构造当前 result preview V4 provenance，并反向绑定同代 source preview。 */
export function currentResultPreviewProvenance(): Record<string, unknown> {
  return {
    ...currentBaseOutputProvenance(),
    kind: "profession-creative-result-preview-v4",
    frame: comparisonFrame(),
    asepriteValidation: {
      artifactId: skillProductionFixture.validationArtifactId,
      sha256: "4".repeat(64),
    },
    sourcePreview: {
      artifactId: skillProductionFixture.sourcePreviewArtifactId,
      sha256: "5".repeat(64),
    },
  };
}

/** 显式构造历史 projects V3/quality V2，仅用于证明新 passed 接收会失败。 */
export function historicalCreativeProjectsProvenance(): Record<
  string,
  unknown
> {
  return {
    ...sharedOutputEvidence(),
    schemaVersion: 3,
    kind: "profession-creative-projects-v3",
    referenceTransferQuality: {
      schemaVersion: 2,
      evaluatedFrameCount: 1,
      evaluatedPixelCount: 2,
      isolatedNoiseRatio: 0,
      continuousBandRatio: 0.8,
      brightCoreRatio: 0.1,
      edgeContrast: 64,
    },
  };
}

/** 构造旧 Run 的 V4 外壳 + quality V3；详情可读，但新 passed 接收必须拒绝。 */
export function historicalQualityV3ProjectsProvenance(): Record<
  string,
  unknown
> {
  return {
    ...sharedOutputEvidence(),
    schemaVersion: 4,
    kind: "profession-creative-projects-v4",
    referenceTransferQuality: {
      schemaVersion: 3,
      evaluatedFrameCount: 1,
      evaluatedPixelCount: 2,
      isolatedNoiseRatio: 0,
      continuousBandRatio: 0.8,
      brightCoreRatio: 0.1,
      edgeContrast: 64,
      strongEdgeRatio: 0.1,
      periodicStripeRatio: 0,
    },
  };
}

function currentBaseOutputProvenance(
  qualityOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...sharedOutputEvidence(),
    schemaVersion: 4,
    referenceTransferQuality: {
      schemaVersion: 4,
      evaluatedFrameCount: 1,
      evaluatedPixelCount: 2,
      isolatedNoiseRatio: 0,
      continuousBandRatio: 0.8,
      brightCoreRatio: 0.1,
      edgeContrast: 64,
      strongEdgeRatio: 0.1,
      periodicStripeRatio: 0,
      maximumWhiteLineRatio: 0,
      maximumDxt1BoundaryJumpRatio: 0,
      ...qualityOverrides,
    },
  };
}

function sharedOutputEvidence(): Record<string, unknown> {
  return {
    jobId: skillProductionFixture.jobId,
    attempt: 2,
    skillId: skillProductionFixture.skillId,
    source: {
      runId: skillProductionFixture.sourceRunId,
      inventoryId: skillProductionFixture.sourceInventoryId,
      sourceSha256: "A".repeat(64),
      frameManifestArtifactId: skillProductionFixture.sourceManifestArtifactId,
      frameManifestSha256: "B".repeat(64),
      frameManifestToolSha256: "C".repeat(64),
    },
    engineerPlan: {
      artifactId: skillProductionFixture.engineerArtifactId,
      sha256: "E".repeat(64),
    },
    referenceImage: {
      imageAttemptId: skillProductionFixture.imageAttemptId,
      artifactId: skillProductionFixture.referenceArtifactId,
      sha256: "F".repeat(64),
    },
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

function comparisonFrame(): Record<string, unknown> {
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
    decodedBgraSha256: "7".repeat(64),
  };
}
