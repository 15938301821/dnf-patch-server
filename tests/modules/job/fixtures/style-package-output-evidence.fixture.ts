/**
 * @fileoverview 构造 Package context Repository 测试使用的 Profession projects/validation Artifact；
 * 不模拟 production、upload session、对象存储或 Package 输出合同。
 * @module modules/job/style-package-output-evidence-fixture
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - creative-stable-frame 生产证据同步
 *
 * 调用关系：style-package-context.repository.spec 按技能与角色调用本函数，再从 Artifact 构造
 * finalized upload session。输入是固定测试身份和 generation，输出数据库 Artifact 投影。
 * 副作用：无。安全边界：默认 generation 是当前 V4/quality V4；历史质量只能由拒绝测试显式选择。
 */
import type { ArtifactFixture } from "./style-package-context.repository.spec-support.js";

/** 测试证据代际；历史值只用于验证新 Package context 失败关闭。 */
export type StylePackageEvidenceGeneration =
  | "current-v4"
  | "historical-quality-v3"
  | "historical-v3";

/** 构造一个 projects 或 validation Artifact，并严格绑定所选代际的 kind 与 quality 版本。 */
export function createStylePackageOutputArtifact(input: {
  runId: string;
  skillId: string;
  producingJobId: string;
  attempt: number;
  id: string;
  shaCharacter: string;
  role: "projects" | "validation";
  projectsArtifactId?: string;
  projectsShaCharacter?: string;
  generation?: StylePackageEvidenceGeneration;
}): ArtifactFixture {
  const generation = input.generation ?? "current-v4";
  const base = {
    schemaVersion: generation === "historical-v3" ? 3 : 4,
    jobId: input.producingJobId,
    attempt: input.attempt,
    skillId: input.skillId,
    source: {
      runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      inventoryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      sourceSha256: "A".repeat(64),
      frameManifestArtifactId: "12345678-1234-4234-8234-123456789abc",
      frameManifestSha256: "B".repeat(64),
      frameManifestToolSha256: "C".repeat(64),
    },
    engineerPlan: {
      artifactId: "23456789-2345-4345-8345-23456789abcd",
      sha256: "D".repeat(64),
    },
    referenceImage: {
      imageAttemptId: "3456789a-3456-4456-8456-3456789abcde",
      artifactId: "456789ab-4567-4567-8567-456789abcdef",
      sha256: "E".repeat(64),
    },
    referenceTransferQuality:
      generation === "current-v4"
        ? currentQuality()
        : generation === "historical-quality-v3"
          ? historicalQualityV3()
          : historicalQuality(),
    aseprite: {
      profileId: "aseprite-cli",
      binarySha256: "F".repeat(64),
      adapterSha256: "0".repeat(64),
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
  const roleKind =
    input.role === "projects"
      ? `profession-creative-projects-${generation === "historical-v3" ? "v3" : "v4"}`
      : `profession-creative-validation-${generation === "historical-v3" ? "v3" : "v4"}`;
  const provenance =
    input.role === "projects"
      ? { ...base, kind: roleKind }
      : {
          ...base,
          kind: roleKind,
          asepriteProjects: {
            artifactId: input.projectsArtifactId,
            sha256: input.projectsShaCharacter?.repeat(64),
          },
        };
  return {
    id: input.id,
    runId: input.runId,
    storageKey: `artifacts/${input.id}`,
    logicalName:
      input.role === "projects"
        ? "profession-aseprite-projects.zip"
        : "profession-aseprite-validation.zip",
    mediaType: "application/zip",
    byteLength: 1_024,
    sha256: input.shaCharacter.repeat(64),
    provenance,
  };
}

function currentQuality(): Record<string, unknown> {
  return {
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
  };
}

function historicalQuality(): Record<string, unknown> {
  const quality = historicalQualityV3();
  delete quality.strongEdgeRatio;
  delete quality.periodicStripeRatio;
  quality.schemaVersion = 2;
  return quality;
}

function historicalQualityV3(): Record<string, unknown> {
  const quality = currentQuality();
  delete quality.maximumWhiteLineRatio;
  delete quality.maximumDxt1BoundaryJumpRatio;
  quality.schemaVersion = 3;
  return quality;
}
