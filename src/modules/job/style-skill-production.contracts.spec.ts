/**
 * @fileoverview 验证主题技能生产 V2 冻结包的内容绑定与预算；不创建 Run 或 Worker 任务。
 * @module job
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A（对应当前前后端结构化主题直接需求）
 */
import { describe, expect, it } from "vitest";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import { parseJobPayload } from "./job-payload-contracts.js";
import {
  createStyleSkillPromptComposition,
  type StyleSkillProductionJobPayloadV2,
} from "./style-skill-production.contracts.js";

const skillId = "11111111-1111-4111-8111-111111111111";

describe("style skill production V2 contract", () => {
  it("accepts a hash-bound structured prompt package", () => {
    const payload = validPayload();
    expect(parseJobPayload("profession", 1, payload)).toEqual(payload);
  });

  it("rejects profession prompt content changed after freezing", () => {
    const payload = validPayload();
    const skill = payload.parameters.promptPackage.skills[0];
    if (!skill) throw new Error("TEST_SKILL_REQUIRED");
    skill.professionPrompt.commonPrompt = "tampered";
    expect(() => parseJobPayload("profession", 1, payload)).toThrow();
  });

  it("rejects a payload over the 64 KiB declarative budget", () => {
    const payload = validPayload();
    const skill = payload.parameters.promptPackage.skills[0];
    if (!skill) throw new Error("TEST_SKILL_REQUIRED");
    skill.professionPrompt.commonPrompt = "x".repeat(65_536);
    skill.professionPromptSha256 = sha256JcsV1(skill.professionPrompt);
    skill.promptSha256 = sha256JcsV1(
      createStyleSkillPromptComposition(
        payload.parameters.promptPackage.themeDefinition,
        skill,
      ),
    );
    payload.parameters.promptPackageSha256 = sha256JcsV1(
      payload.parameters.promptPackage,
    );
    expect(() => parseJobPayload("profession", 1, payload)).toThrow();
  });
});

function validPayload(): StyleSkillProductionJobPayloadV2 {
  const themeDefinition = {
    schemaVersion: 1 as const,
    goal: "统一暗蓝剑气主题",
    baseStyle: "深钴蓝剑气",
    colorAnchors: [{ name: "主色", value: "#123456" }],
    materialRules: "保留清晰剑气边缘",
    particleRules: "粒子跟随原动画节奏",
    layeringRules: "不改变源帧层级语义",
    constraints: "保持源几何与锚点",
    acceptanceCriteria: "逐帧轮廓可辨识",
    exclusions: "不新增角色本体效果",
  };
  const skill = {
    skillId,
    professionPrompt: {
      schemaVersion: 1 as const,
      stableSemantics: "保留技能身份",
      commonPrompt: "保持角色与武器轮廓",
      sourceConstraints: "只处理核验帧",
      stageAcceptance: "逐帧通过来源约束",
    },
    professionPromptSha256: "",
    skillThemePrompt: {
      skillId,
      themePrompt: "暗蓝月牙剑气",
      changes: "替换剑气材质与粒子颜色",
      acceptanceCriteria: "动作时间轴与原技能一致",
      exclusions: "不修改命中范围",
    },
    promptSha256: "",
    sourceEvidence: {
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      sourceInventoryId: "66666666-6666-4666-8666-666666666666",
      sourceFrameManifestArtifactId: "33333333-3333-4333-8333-333333333333",
      sourceEntries: [
        {
          sourceInventoryEntryId: "77777777-7777-4777-8777-777777777777",
          sourceMetadataSha256: "B".repeat(64),
        },
      ],
    },
  };
  skill.professionPromptSha256 = sha256JcsV1(skill.professionPrompt);
  skill.promptSha256 = sha256JcsV1(
    createStyleSkillPromptComposition(themeDefinition, skill),
  );
  const promptPackage = {
    schemaVersion: 2 as const,
    themeDefinition,
    skills: [skill],
  };
  return {
    schemaVersion: 1,
    profileId: "profile-v2",
    parameters: {
      workflow: "style-skill-production-v2",
      professionId: "44444444-4444-4444-8444-444444444444",
      styleId: "55555555-5555-4555-8555-555555555555",
      selectedSkillIds: [skillId],
      promptPackage,
      promptPackageSha256: sha256JcsV1(promptPackage),
      toolProfiles: ["aseprite-cli"],
      deploymentAuthorized: false,
    },
  };
}
