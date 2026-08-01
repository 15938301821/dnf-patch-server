/**
 * @fileoverview 构造Profession V6单技能终态事务的自洽逐帧、manifest与四Artifact证据；
 * 不连接MySQL、不读取对象正文，也不证明真实Aseprite或252帧运行。
 * @module modules/job/patch-task-skill-production-v6-repository-fixture
 * @author AI生成
 * @created 2026-08-01
 * @relatedPlan N/A - 用户直接要求实现Profession V6
 *
 * 调用关系：V6 Repository spec选择单项漂移场景后调用本构造器，真实接收函数消费事务替身。
 * 安全边界：成功场景使用同一attempt的完整单帧集合；失败场景每次只改变一个证据维度。
 */
import { sha256Json } from "../../../../src/common/utils/canonical.js";
import type { ReportPatchTaskSkillProductionInput } from "../../../../src/modules/job/patch-task.contracts.js";
import type { StyleSkillProductionJobPayloadV3 } from "../../../../src/modules/job/style-skill-production.contracts.js";
import { createProfessionV6TargetSetSha256 } from "../../../../src/modules/job/profession-v6-target-set.js";
import {
  createSkillProductionTransactionHarness,
  type SkillProductionReportHarness,
} from "./patch-task-skill-production.repository-fixture-support.js";
import { skillProductionFixture } from "./patch-task-skill-production.fixture-ids.js";
import {
  sourceEvidenceRow,
  uploadRow,
  validPayload,
} from "./patch-task-skill-production.repository-fixture.js";

type V6PassedReport = Extract<
  ReportPatchTaskSkillProductionInput,
  { status: "passed"; productionContractVersion: 6 }
>;
export type V6SkillProductionScenario =
  | "accepted"
  | "frame-old-attempt"
  | "frame-not-passed"
  | "target-set-mismatch"
  | "preview-target-mismatch";

const targetManifestArtifactId = "41414141-4141-4141-8141-414141414141";
const targetArtifactId = "42424242-4242-4242-8242-424242424242";
const targetModelCallId = "43434343-4343-4343-8343-434343434343";
const targetImageAttemptId = "44444444-4343-4444-8444-444444444444";
const targetManifestSha256 = "D".repeat(64);
const targetSha256 = "E".repeat(64);
const sourceAlphaSha256 = "F".repeat(64);

/** 创建一个完整V6 passed事务或单项证据漂移场景。 */
export function createV6SkillProductionReportHarness(
  scenario: V6SkillProductionScenario = "accepted",
): SkillProductionReportHarness {
  const payload = validV6Payload();
  const targetSetSha256 = createProfessionV6TargetSetSha256(
    skillProductionFixture.skillId,
    [targetSetFrame()],
  );
  const input: V6PassedReport = {
    workerId: skillProductionFixture.workerId,
    leaseId: skillProductionFixture.leaseId,
    attempt: 2,
    skillId: skillProductionFixture.skillId,
    status: "passed",
    productionContractVersion: 6,
    asepriteBinarySha256: "1".repeat(64),
    asepriteAdapterSha256: "2".repeat(64),
    asepriteArtifactId: skillProductionFixture.projectsArtifactId,
    validationArtifactId: skillProductionFixture.validationArtifactId,
    sourcePreviewArtifactId: skillProductionFixture.sourcePreviewArtifactId,
    resultPreviewArtifactId: skillProductionFixture.resultPreviewArtifactId,
    targetFrameManifestArtifactId: targetManifestArtifactId,
    targetFrameManifestSha256: targetManifestSha256,
    targetSetSha256:
      scenario === "target-set-mismatch" ? "0".repeat(64) : targetSetSha256,
    targetFrameCount: 1,
  };
  return createSkillProductionTransactionHarness(
    rows(payload, input, scenario),
    input,
  );
}

function rows(
  payload: StyleSkillProductionJobPayloadV3,
  input: V6PassedReport,
  scenario: V6SkillProductionScenario,
): unknown[][] {
  const frame = frameTargetRow();
  if (scenario === "frame-old-attempt") frame.attempt = 1;
  if (scenario === "frame-not-passed") frame.generationStatus = "persisting";
  const sourcePreview = v6SourcePreviewProvenance(input);
  if (scenario === "preview-target-mismatch") {
    sourcePreview.targetFrame.artifactId =
      "45454545-4545-4545-8545-454545454545";
  }
  const resultPreview = v6ResultPreviewProvenance(input);
  return [
    [leasedJob(payload)],
    [{ value: skillProductionFixture.now }],
    [production(payload)],
    [sourceEvidenceRow()],
    [frame],
    [manifestArtifactRow()],
    [
      uploadRow(
        skillProductionFixture.projectsUploadId,
        skillProductionFixture.projectsArtifactId,
        "profession-aseprite-projects.zip",
        "3".repeat(64),
        v6ProjectsProvenance(input),
      ),
    ],
    [
      uploadRow(
        skillProductionFixture.validationUploadId,
        skillProductionFixture.validationArtifactId,
        "profession-aseprite-validation.zip",
        "4".repeat(64),
        v6ValidationProvenance(input),
      ),
    ],
    [provenanceRow(sourcePreview)],
    [
      uploadRow(
        skillProductionFixture.sourcePreviewUploadId,
        skillProductionFixture.sourcePreviewArtifactId,
        "profession-source-frame-preview.png",
        "5".repeat(64),
        sourcePreview,
        "image/png",
      ),
    ],
    [provenanceRow(resultPreview)],
    [
      uploadRow(
        skillProductionFixture.resultPreviewUploadId,
        skillProductionFixture.resultPreviewArtifactId,
        "profession-aseprite-result-preview.png",
        "6".repeat(64),
        resultPreview,
        "image/png",
      ),
    ],
  ];
}

function validV6Payload(): StyleSkillProductionJobPayloadV3 {
  const v5 = validPayload();
  return {
    schemaVersion: 2,
    profileId: "aseprite-production-v6",
    parameters: {
      ...v5.parameters,
      workflow: "style-skill-production-v3",
      targetFramePolicy: {
        schemaVersion: 1,
        dimensions: "source-frame-exact",
        alpha: "source-frame-exact",
        hiddenFrames: "preserve-source",
        linkFrames: "reuse-link-target",
        maximumTargetFrameCount: 2_048,
        maximumTargetPixelCount: 134_217_728,
      },
      toolProfiles: ["aseprite-cli-v6"],
    },
  };
}

function leasedJob(
  payload: StyleSkillProductionJobPayloadV3,
): Record<string, unknown> {
  return {
    id: skillProductionFixture.jobId,
    runId: skillProductionFixture.runId,
    kind: "profession",
    status: "leased",
    leaseOwnerId: skillProductionFixture.workerId,
    leaseId: skillProductionFixture.leaseId,
    leaseExpiresAt: new Date("2026-07-24T00:01:00.000Z"),
    attemptCount: 2,
    payload,
    payloadSha256: sha256Json(payload),
  };
}

function production(
  payload: StyleSkillProductionJobPayloadV3,
): Record<string, unknown> {
  const skill = payload.parameters.promptPackage.skills[0];
  if (!skill) throw new Error("TEST_SKILL_REQUIRED");
  return {
    id: "40404040-4040-4040-8040-404040404040",
    productionContractVersion: 6,
    professionId: skillProductionFixture.professionId,
    styleId: skillProductionFixture.styleId,
    skillId: skillProductionFixture.skillId,
    runId: skillProductionFixture.runId,
    jobId: null,
    sourceRunId: skillProductionFixture.sourceRunId,
    sourceFrameManifestArtifactId:
      skillProductionFixture.sourceManifestArtifactId,
    promptSha256: skill.promptSha256,
    status: "validating",
  };
}

function targetSetFrame(): {
  entryIndex: number;
  frameIndex: number;
  width: number;
  height: number;
  artifactId: string;
  modelCallId: string;
  imageAttemptId: string;
  byteLength: number;
  sha256: string;
  sourceAlphaSha256: string;
} {
  return {
    entryIndex: 0,
    frameIndex: 3,
    width: 16,
    height: 12,
    artifactId: targetArtifactId,
    modelCallId: targetModelCallId,
    imageAttemptId: targetImageAttemptId,
    byteLength: 256,
    sha256: targetSha256,
    sourceAlphaSha256,
  };
}

function frameTargetRow(): Record<string, unknown> {
  return {
    frameOrdinal: 0,
    generationOrdinal: 0,
    runId: skillProductionFixture.runId,
    jobId: skillProductionFixture.jobId,
    workerId: skillProductionFixture.workerId,
    leaseId: skillProductionFixture.leaseId,
    attempt: 2,
    skillId: skillProductionFixture.skillId,
    manifestArtifactId: targetManifestArtifactId,
    manifestSha256: targetManifestSha256,
    sourceRunId: skillProductionFixture.sourceRunId,
    sourceFrameManifestArtifactId:
      skillProductionFixture.sourceManifestArtifactId,
    targetPolicy: "generate-same-size",
    entryIndex: 0,
    frameIndex: 3,
    internalPath: "sprite/effect/a.img",
    width: 16,
    height: 12,
    canvasWidth: 32,
    canvasHeight: 24,
    x: 2,
    y: -1,
    sourceDecodedBgraSha256: "7".repeat(64),
    sourceAlphaSha256,
    generationStatus: "passed",
    generationModelCallId: targetModelCallId,
    generationImageAttemptId: targetImageAttemptId,
    targetPngArtifactId: targetArtifactId,
    targetPngSha256: targetSha256,
    targetPngByteLength: 256,
    targetNormalizationAlgorithm:
      "centered-exact-aspect-lanczos3-source-alpha-v1",
  };
}

function manifestArtifactRow(): Record<string, unknown> {
  return {
    id: targetManifestArtifactId,
    runId: skillProductionFixture.runId,
    mediaType: "application/json",
    byteLength: 512,
    sha256: targetManifestSha256,
  };
}

function v6Base(input: V6PassedReport): Record<string, unknown> {
  return {
    schemaVersion: 6,
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
    targetFrameManifest: {
      artifactId: targetManifestArtifactId,
      mediaType: "application/json",
      byteLength: 512,
      sha256: targetManifestSha256,
    },
    targetSet: {
      schemaVersion: 1,
      sha256: input.targetSetSha256,
      targetFrameCount: 1,
    },
    aseprite: {
      profileId: "aseprite-cli-v6",
      binarySha256: "1".repeat(64),
      adapterSha256: "2".repeat(64),
    },
    safety: {
      targetFramesUsedAsRuntimeRgbSource: true,
      sourceAlphaUsedAsRuntimeAlpha: true,
      hiddenSourcePixelsPreserved: true,
      linkFramesPreserved: true,
      dxt1LowLightSourceRgbPreserved: true,
      transparentRgbCleared: true,
      sourceGeometryPreserved: true,
      sourceAlphaPreserved: true,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
  };
}

function v6ProjectsProvenance(input: V6PassedReport): Record<string, unknown> {
  return { ...v6Base(input), kind: "profession-target-projects-v6" };
}

function v6ValidationProvenance(
  input: V6PassedReport,
): Record<string, unknown> {
  return {
    ...v6Base(input),
    kind: "profession-target-validation-v6",
    asepriteProjects: {
      artifactId: skillProductionFixture.projectsArtifactId,
      sha256: "3".repeat(64),
    },
  };
}

function v6SourcePreviewProvenance(input: V6PassedReport): {
  targetFrame: ReturnType<typeof previewTarget>;
  [key: string]: unknown;
} {
  return {
    ...v6Base(input),
    kind: "profession-target-source-frame-preview-v6",
    frame: comparisonFrame(),
    targetFrame: previewTarget(),
    asepriteValidation: {
      artifactId: skillProductionFixture.validationArtifactId,
      sha256: "4".repeat(64),
    },
  };
}

function v6ResultPreviewProvenance(
  input: V6PassedReport,
): Record<string, unknown> {
  return {
    ...v6Base(input),
    kind: "profession-target-result-preview-v6",
    frame: comparisonFrame(),
    targetFrame: previewTarget(),
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

function previewTarget(): {
  artifactId: string;
  modelCallId: string;
  imageAttemptId: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  sourceAlphaSha256: string;
  normalizationAlgorithm: string;
} {
  return {
    artifactId: targetArtifactId,
    modelCallId: targetModelCallId,
    imageAttemptId: targetImageAttemptId,
    mediaType: "image/png",
    byteLength: 256,
    sha256: targetSha256,
    sourceAlphaSha256,
    normalizationAlgorithm: "centered-exact-aspect-lanczos3-source-alpha-v1",
  };
}

function provenanceRow(
  provenance: Record<string, unknown>,
): Record<string, unknown> {
  return { artifactProvenance: provenance, sessionProvenance: provenance };
}
