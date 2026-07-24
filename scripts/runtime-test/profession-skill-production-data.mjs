/**
 * @fileoverview 构造隔离 MySQL Profession 接收场景的 UUID、冻结 payload、provenance 与 passed DTO。
 * @module scripts/runtime-test/profession-skill-production-data
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：profession-skill-production-fixture 调用本模块后把返回值写入临时 MySQL。
 * 输入只有上层已创建的 source Run 和 Worker ID，输出是纯内存测试数据，无数据库或网络副作用。
 * 安全边界：这些值只用于隔离 runtime fixture，不证明模型、Artifact 正文、Aseprite、NPK、兼容或部署；
 * payload 与 provenance 必须复用生产 canonical hash 和严格契约，不能手写不稳定摘要。
 */
import { randomUUID } from "node:crypto";
import { sha256JcsV1, sha256Json } from "../../dist/common/utils/canonical.js";
import {
  createStyleSkillPromptComposition,
  styleSkillProductionJobPayloadV2Schema,
} from "../../dist/modules/job/style-skill-production.contracts.js";

/** 场景中各角色固定且彼此可辨识的测试摘要。 */
export const professionSkillProductionHashes = {
  source: "A".repeat(64),
  manifest: "B".repeat(64),
  manifestTool: "C".repeat(64),
  sourceEntry: "D".repeat(64),
  engineer: "E".repeat(64),
  reference: "F".repeat(64),
  projects: "3".repeat(64),
  validation: "4".repeat(64),
  binary: "1".repeat(64),
  adapter: "2".repeat(64),
};

/** 构造一套内部一致的接收 fixture 数据，不执行任何持久化。 */
export function createProfessionSkillProductionData(sourceRunId, workerId) {
  const ids = createIds();
  const payload = createPayload(ids, sourceRunId);
  const payloadSha256 = sha256Json(payload);
  const sourceProvenance = {
    schemaVersion: 1,
    kind: "source-frame-manifest",
    sourceSha256: professionSkillProductionHashes.source,
    toolSha256: professionSkillProductionHashes.manifestTool,
    jobPayloadSha256: payloadSha256,
    deploymentAuthorized: false,
  };
  const baseProvenance = createBaseProvenance(ids, sourceRunId);
  const projectsProvenance = {
    ...baseProvenance,
    kind: "profession-aseprite-projects-v1",
  };
  const validationProvenance = {
    ...baseProvenance,
    kind: "profession-aseprite-validation-v1",
    asepriteProjects: {
      artifactId: ids.projectsArtifactId,
      sha256: professionSkillProductionHashes.projects,
    },
  };
  return {
    ids,
    workerId,
    payload,
    payloadSha256,
    sourceProvenance,
    projectsProvenance,
    validationProvenance,
    passedReport: {
      workerId,
      leaseId: ids.leaseId,
      attempt: 2,
      skillId: ids.skillId,
      status: "passed",
      asepriteBinarySha256: professionSkillProductionHashes.binary,
      asepriteAdapterSha256: professionSkillProductionHashes.adapter,
      asepriteArtifactId: ids.projectsArtifactId,
      validationArtifactId: ids.validationArtifactId,
    },
  };
}

function createIds() {
  const keys = [
    "professionId",
    "styleId",
    "skillId",
    "sourceInventoryId",
    "sourceManifestArtifactId",
    "sourceEntryId",
    "runId",
    "jobId",
    "packageId",
    "attemptId",
    "leaseId",
    "productionId",
    "engineerModelCallId",
    "artistModelCallId",
    "engineerArtifactId",
    "referenceArtifactId",
    "imageAttemptId",
    "engineerExecutionId",
    "artistExecutionId",
    "projectsArtifactId",
    "validationArtifactId",
    "projectsUploadId",
    "validationUploadId",
  ];
  return Object.fromEntries(keys.map((key) => [key, randomUUID()]));
}

function createPayload(ids, sourceRunId) {
  const themeDefinition = {
    schemaVersion: 1,
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
    schemaVersion: 1,
    stableSemantics: "保留技能身份",
    commonPrompt: "保持角色与武器轮廓",
    sourceConstraints: "只处理核验帧",
    stageAcceptance: "逐帧通过来源约束",
  };
  const skillThemePrompt = {
    skillId: ids.skillId,
    themePrompt: "暗蓝月牙剑气",
    changes: "替换剑气材质",
    acceptanceCriteria: "时间轴一致",
    exclusions: "不修改命中范围",
  };
  const professionPromptSha256 = sha256JcsV1(professionPrompt);
  const skill = {
    skillId: ids.skillId,
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
      sourceRunId,
      sourceInventoryId: ids.sourceInventoryId,
      sourceFrameManifestArtifactId: ids.sourceManifestArtifactId,
      sourceEntries: [
        {
          sourceInventoryEntryId: ids.sourceEntryId,
          sourceMetadataSha256: professionSkillProductionHashes.sourceEntry,
        },
      ],
    },
  };
  const promptPackage = {
    schemaVersion: 2,
    themeDefinition,
    skills: [skill],
  };
  return styleSkillProductionJobPayloadV2Schema.parse({
    schemaVersion: 1,
    profileId: "aseprite-production-v1",
    parameters: {
      workflow: "style-skill-production-v2",
      professionId: ids.professionId,
      styleId: ids.styleId,
      selectedSkillIds: [ids.skillId],
      promptPackage,
      promptPackageSha256: sha256JcsV1(promptPackage),
      toolProfiles: ["aseprite-cli"],
      deploymentAuthorized: false,
    },
  });
}

function createBaseProvenance(ids, sourceRunId) {
  return {
    schemaVersion: 1,
    jobId: ids.jobId,
    attempt: 2,
    skillId: ids.skillId,
    source: {
      runId: sourceRunId,
      inventoryId: ids.sourceInventoryId,
      sourceSha256: professionSkillProductionHashes.source,
      frameManifestArtifactId: ids.sourceManifestArtifactId,
      frameManifestSha256: professionSkillProductionHashes.manifest,
      frameManifestToolSha256: professionSkillProductionHashes.manifestTool,
    },
    engineerPlan: {
      artifactId: ids.engineerArtifactId,
      sha256: professionSkillProductionHashes.engineer,
    },
    referenceImage: {
      imageAttemptId: ids.imageAttemptId,
      artifactId: ids.referenceArtifactId,
      sha256: professionSkillProductionHashes.reference,
    },
    aseprite: {
      profileId: "aseprite-cli",
      binarySha256: professionSkillProductionHashes.binary,
      adapterSha256: professionSkillProductionHashes.adapter,
    },
    safety: {
      referenceImageUsedForRuntimePixels: false,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
  };
}
