/**
 * @fileoverview 为 Profession 单技能输出接收测试构造冻结 Job、模型执行、来源与上传会话行；
 * 不连接 MySQL、不读取对象正文，也不作为生产代码或线协议使用。
 * @module modules/job/patch-task-skill-production-repository-fixture
 * 调用关系：相邻 Vitest 行为测试按具名场景创建最小 Drizzle transaction stub，再调用真实接收函数。
 * 输入是有限场景名，输出包含 passed DTO、数据库端口和写入观察值。副作用仅记录 mock 调用。
 * 安全边界：fixture 不证明真实 CHECK、复合外键或 row lock；场景必须保留当前 attempt、固定来源、
 * 双模型阶段和四个 finalized upload 的完整证据，不得用永远成功的 stub 绕过被测校验。
 */
import {
  sha256JcsV1,
  sha256Json,
} from "../../../../src/common/utils/canonical.js";
import type { ReportPatchTaskSkillProductionInput } from "../../../../src/modules/job/patch-task.contracts.js";
import {
  createStyleSkillPromptComposition,
  type StyleSkillProductionJobPayloadV2,
} from "../../../../src/modules/job/style-skill-production.contracts.js";
import {
  createSkillProductionTransactionHarness,
  type SkillProductionReportHarness,
} from "./patch-task-skill-production.repository-fixture-support.js";
import { skillProductionFixture } from "./patch-task-skill-production.fixture-ids.js";

export type { SkillProductionReportHarness } from "./patch-task-skill-production.repository-fixture-support.js";
export { skillProductionFixture };

type PassedReport = Extract<
  ReportPatchTaskSkillProductionInput,
  { status: "passed" }
>;

/** 接收事务测试允许改变的单一失败条件，其他证据保持有效以隔离被测分支。 */
export type SkillProductionReportScenario =
  | "accepted"
  | "old-attempt"
  | "artist-old-attempt"
  | "source-id-mismatch"
  | "projects-not-finalized"
  | "validation-projects-role"
  | "validation-quality-mismatch";

/**
 * 创建一个只改变单项证据的接收事务场景。
 * @param scenario accepted 或一个精确失败条件；未指定时构造完整当前-attempt 证据。
 * @returns 可传给真实接收函数的数据库端口、DTO 和 mock 观察器。
 */
export function createSkillProductionReportHarness(
  scenario: SkillProductionReportScenario = "accepted",
): SkillProductionReportHarness {
  const payload = validPayload();
  const input: PassedReport = {
    workerId: skillProductionFixture.workerId,
    leaseId: skillProductionFixture.leaseId,
    attempt: scenario === "old-attempt" ? 1 : 2,
    skillId: skillProductionFixture.skillId,
    status: "passed",
    asepriteBinarySha256: "1".repeat(64),
    asepriteAdapterSha256: "2".repeat(64),
    asepriteArtifactId: skillProductionFixture.projectsArtifactId,
    validationArtifactId: skillProductionFixture.validationArtifactId,
    sourcePreviewArtifactId: skillProductionFixture.sourcePreviewArtifactId,
    resultPreviewArtifactId: skillProductionFixture.resultPreviewArtifactId,
  };
  const rows =
    scenario === "old-attempt"
      ? [[leasedJob(payload)], [{ value: skillProductionFixture.now }]]
      : acceptedRows(payload, scenario);
  return createSkillProductionTransactionHarness(rows, input);
}

function acceptedRows(
  payload: StyleSkillProductionJobPayloadV2,
  scenario: SkillProductionReportScenario,
): unknown[][] {
  const artist = artistExecution(payload);
  if (scenario === "artist-old-attempt") artist.attempt = 1;
  const projects = projectsUploadRow();
  if (scenario === "projects-not-finalized") {
    projects.sessionStatus = "authorized";
  }
  const validation = validationUploadRow();
  if (scenario === "validation-projects-role") {
    validation.sessionProvenance = projectsProvenance();
    validation.artifactProvenance = projectsProvenance();
  }
  if (scenario === "validation-quality-mismatch") {
    const provenance = validationProvenance({ referenceSimilarity: 0.95 });
    validation.sessionProvenance = provenance;
    validation.artifactProvenance = provenance;
  }
  const source = sourceEvidenceRow();
  if (scenario === "source-id-mismatch") {
    source.manifestProvenance = {
      ...(source.manifestProvenance as Record<string, unknown>),
      sourceId: "another-source",
    };
  }
  return [
    [leasedJob(payload)],
    [{ value: skillProductionFixture.now }],
    [production(payload)],
    [engineerExecution(payload)],
    [artist],
    [source],
    [projects],
    [projects],
    [validation],
    [sourcePreviewUploadRow()],
    [sourcePreviewUploadRow()],
    [resultPreviewUploadRow()],
  ];
}

function leasedJob(
  payload: StyleSkillProductionJobPayloadV2,
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
  payload: StyleSkillProductionJobPayloadV2,
): Record<string, unknown> {
  const skill = requiredSkill(payload);
  return {
    id: "40404040-4040-4040-8040-404040404040",
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

function engineerExecution(
  payload: StyleSkillProductionJobPayloadV2,
): Record<string, unknown> {
  return modelExecution(payload, {
    id: "50505050-5050-4050-8050-505050505050",
    stage: "engineer-plan-v3",
    modelCallId: skillProductionFixture.engineerModelCallId,
    imageAttemptId: null,
    outputArtifactId: skillProductionFixture.engineerArtifactId,
    outputSha256: "E".repeat(64),
  });
}

function artistExecution(
  payload: StyleSkillProductionJobPayloadV2,
): Record<string, unknown> {
  return modelExecution(payload, {
    id: "60606060-6060-4060-8060-606060606060",
    stage: "reference-image-v3",
    modelCallId: skillProductionFixture.artistModelCallId,
    imageAttemptId: skillProductionFixture.imageAttemptId,
    outputArtifactId: skillProductionFixture.referenceArtifactId,
    outputSha256: "F".repeat(64),
  });
}

function modelExecution(
  payload: StyleSkillProductionJobPayloadV2,
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  return {
    runId: skillProductionFixture.runId,
    jobId: skillProductionFixture.jobId,
    workerId: skillProductionFixture.workerId,
    leaseId: skillProductionFixture.leaseId,
    attempt: 2,
    skillId: skillProductionFixture.skillId,
    promptSha256: requiredSkill(payload).promptSha256,
    sourceVisualArtifactId: skillProductionFixture.sourceVisualArtifactId,
    sourceVisualSha256: "8".repeat(64),
    sourceVisualFrameMapSha256: "9".repeat(64),
    status: "passed",
    outputByteLength: 128,
    errorCode: null,
    ...evidence,
  };
}

function sourceEvidenceRow(): Record<string, unknown> {
  return {
    runId: skillProductionFixture.sourceRunId,
    inventoryId: skillProductionFixture.sourceInventoryId,
    sourceId: "momentaryslash",
    sourceSha256: "A".repeat(64),
    manifestArtifactId: skillProductionFixture.sourceManifestArtifactId,
    manifestLogicalName: "source-frame-manifest.json",
    manifestMediaType: "application/json",
    manifestSha256: "B".repeat(64),
    manifestProvenance: {
      schemaVersion: 1,
      kind: "source-frame-manifest",
      sourceId: "momentaryslash",
      sourceSha256: "A".repeat(64),
      toolSha256: "C".repeat(64),
      jobPayloadSha256: "D".repeat(64),
      deploymentAuthorized: false,
    },
  };
}

function projectsUploadRow(): Record<string, unknown> {
  return uploadRow(
    skillProductionFixture.projectsUploadId,
    skillProductionFixture.projectsArtifactId,
    "projects.zip",
    "3".repeat(64),
    projectsProvenance(),
  );
}

function validationUploadRow(): Record<string, unknown> {
  return uploadRow(
    skillProductionFixture.validationUploadId,
    skillProductionFixture.validationArtifactId,
    "validation.zip",
    "4".repeat(64),
    validationProvenance(),
  );
}

function sourcePreviewUploadRow(): Record<string, unknown> {
  return uploadRow(
    skillProductionFixture.sourcePreviewUploadId,
    skillProductionFixture.sourcePreviewArtifactId,
    "profession-source-frame-preview.png",
    "5".repeat(64),
    sourcePreviewProvenance(),
    "image/png",
  );
}

function resultPreviewUploadRow(): Record<string, unknown> {
  return uploadRow(
    skillProductionFixture.resultPreviewUploadId,
    skillProductionFixture.resultPreviewArtifactId,
    "profession-aseprite-result-preview.png",
    "6".repeat(64),
    resultPreviewProvenance(),
    "image/png",
  );
}

function uploadRow(
  uploadId: string,
  artifactId: string,
  logicalName: string,
  sha256: string,
  provenance: Record<string, unknown>,
  mediaType = "application/zip",
): Record<string, unknown> {
  const objectKey = `artifacts/${artifactId}${mediaType === "image/png" ? ".png" : ".zip"}`;
  return {
    uploadId,
    sessionRunId: skillProductionFixture.runId,
    sessionJobId: skillProductionFixture.jobId,
    workerId: skillProductionFixture.workerId,
    leaseId: skillProductionFixture.leaseId,
    attempt: 2,
    objectKey,
    sessionLogicalName: logicalName,
    sessionMediaType: mediaType,
    expectedByteLength: 256,
    expectedSha256: sha256,
    sessionProvenance: provenance,
    sessionStatus: "finalized",
    sessionArtifactId: artifactId,
    finalizedAt: skillProductionFixture.now,
    objectDeletedAt: null,
    artifactId,
    artifactRunId: skillProductionFixture.runId,
    storageKey: objectKey,
    artifactLogicalName: logicalName,
    artifactMediaType: mediaType,
    artifactByteLength: 256,
    artifactSha256: sha256,
    artifactProvenance: provenance,
  };
}

function projectsProvenance(): Record<string, unknown> {
  return {
    ...baseOutputProvenance(),
    kind: "profession-reference-projects-v2",
  };
}

function validationProvenance(
  qualityOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...baseOutputProvenance(qualityOverrides),
    kind: "profession-reference-validation-v2",
    asepriteProjects: {
      artifactId: skillProductionFixture.projectsArtifactId,
      sha256: "3".repeat(64),
    },
  };
}

function sourcePreviewProvenance(): Record<string, unknown> {
  return {
    ...baseOutputProvenance(),
    kind: "profession-source-frame-preview-v2",
    frame: comparisonFrame(),
    asepriteValidation: {
      artifactId: skillProductionFixture.validationArtifactId,
      sha256: "4".repeat(64),
    },
  };
}

function resultPreviewProvenance(): Record<string, unknown> {
  return {
    ...baseOutputProvenance(),
    kind: "profession-reference-result-preview-v2",
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

function baseOutputProvenance(
  qualityOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 2,
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
    referenceTransferQuality: {
      schemaVersion: 1,
      evaluatedFrameCount: 1,
      evaluatedPixelCount: 2,
      referenceCoverage: 1,
      referenceSimilarity: 1,
      sourceEdgeEnergy: 10,
      runtimeEdgeEnergy: 20,
      edgeEnergyRatio: 2,
      ...qualityOverrides,
    },
    aseprite: {
      profileId: "aseprite-cli",
      binarySha256: "1".repeat(64),
      adapterSha256: "2".repeat(64),
    },
    safety: {
      referenceImageUsedAsRuntimeRgbSource: true,
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

function requiredSkill(
  payload: StyleSkillProductionJobPayloadV2,
): StyleSkillProductionJobPayloadV2["parameters"]["promptPackage"]["skills"][number] {
  const skill = payload.parameters.promptPackage.skills[0];
  if (!skill) throw new Error("TEST_SKILL_REQUIRED");
  return skill;
}

function validPayload(): StyleSkillProductionJobPayloadV2 {
  const themeDefinition = {
    schemaVersion: 1 as const,
    goal: "统一暗蓝剑气主题",
    baseStyle: "深钴蓝剑气",
    colorAnchors: [{ name: "主色", value: "#123456" }],
    materialRules: "保留清晰边缘",
    particleRules: "保持粒子节奏",
    layeringRules: "不改变层级",
    constraints: "保持源几何",
    acceptanceCriteria: "逐帧轮廓可辨识",
    exclusions: "不新增角色效果",
  };
  const professionPrompt = {
    schemaVersion: 1 as const,
    stableSemantics: "保留技能身份",
    commonPrompt: "保持角色与武器轮廓",
    sourceConstraints: "只处理核验帧",
    stageAcceptance: "逐帧通过来源约束",
  };
  const skillThemePrompt = {
    skillId: skillProductionFixture.skillId,
    themePrompt: "暗蓝月牙剑气",
    changes: "替换剑气材质",
    acceptanceCriteria: "时间轴一致",
    exclusions: "不修改命中范围",
  };
  const professionPromptSha256 = sha256JcsV1(professionPrompt);
  const skill = {
    skillId: skillProductionFixture.skillId,
    professionPrompt,
    professionPromptSha256,
    skillThemePrompt,
    promptSha256: sha256JcsV1(
      createStyleSkillPromptComposition(themeDefinition, {
        professionPrompt,
        professionPromptSha256,
        skillThemePrompt,
      }),
    ),
    sourceEvidence: {
      sourceRunId: skillProductionFixture.sourceRunId,
      sourceInventoryId: skillProductionFixture.sourceInventoryId,
      sourceFrameManifestArtifactId:
        skillProductionFixture.sourceManifestArtifactId,
      sourceEntries: [
        {
          sourceInventoryEntryId: "70707070-7070-4070-8070-707070707070",
          sourceMetadataSha256: "A".repeat(64),
        },
      ],
    },
  };
  const promptPackage = {
    schemaVersion: 2 as const,
    themeDefinition,
    skills: [skill],
  };
  return {
    schemaVersion: 1,
    profileId: "aseprite-production-v1",
    parameters: {
      workflow: "style-skill-production-v2",
      professionId: skillProductionFixture.professionId,
      styleId: skillProductionFixture.styleId,
      selectedSkillIds: [skillProductionFixture.skillId],
      promptPackage,
      promptPackageSha256: sha256JcsV1(promptPackage),
      toolProfiles: ["aseprite-cli"],
      deploymentAuthorized: false,
    },
  };
}
