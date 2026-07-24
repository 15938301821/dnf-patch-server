/**
 * @fileoverview 验证结构化职业主题契约、草稿语义与送审完整性；不连接数据库。
 * @module profession
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan N/A（对应当前结构化风格表单直接需求）
 */
import { describe, expect, it } from "vitest";
import {
  evaluateStyleContentCompleteness,
  importProfessionSkillCatalogSchema,
  saveProfessionStyleSchema,
  stylePromptPackageMaxBytes,
  type SaveProfessionStyleInput,
} from "./profession.contracts.js";

const skillId = "11111111-1111-4111-8111-111111111111";

describe("profession style contracts", () => {
  it("accepts an empty-skill private draft", () => {
    const input = draft();
    expect(saveProfessionStyleSchema.parse(input)).toEqual(input);
    expect(evaluateStyleContentCompleteness(input)).toMatchObject({
      complete: false,
      reasons: ["theme-incomplete", "skills-required"],
    });
  });

  it("accepts a complete structured style", () => {
    const input = completeStyle();
    expect(saveProfessionStyleSchema.parse(input)).toEqual(input);
    expect(evaluateStyleContentCompleteness(input)).toEqual({
      complete: true,
      incompleteSkillIds: [],
      reasons: [],
    });
  });

  it("rejects prompt rows outside the selected skill set", () => {
    const input = draft();
    input.skillPrompts = [emptySkillPrompt(skillId)];
    expect(saveProfessionStyleSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a frozen style package over 48 KiB", () => {
    const input = completeStyle();
    const prompt = input.skillPrompts[0];
    if (!prompt) throw new Error("TEST_PROMPT_REQUIRED");
    prompt.themePrompt = "x".repeat(stylePromptPackageMaxBytes);
    expect(saveProfessionStyleSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicate Inventory Entries in a skill source", () => {
    const source = {
      sourceInventoryEntryId: skillId,
      sourceMetadataSha256: "B".repeat(64),
    };
    expect(
      importProfessionSkillCatalogSchema.safeParse({
        workflowProjectId: "22222222-2222-4222-8222-222222222222",
        catalogSnapshotId: "33333333-3333-4333-8333-333333333333",
        sourceRunId: "44444444-4444-4444-8444-444444444444",
        skills: [
          {
            stableKey: "momentaryslash",
            displayName: "momentaryslash",
            sourceScope: "entire-inventory",
            sourceInventoryId: "55555555-5555-4555-8555-555555555555",
            sourceEntries: [source, source],
            sourceFrameManifestArtifactId:
              "66666666-6666-4666-8666-666666666666",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

function draft(): SaveProfessionStyleInput {
  return {
    name: "主题草稿",
    description: "",
    themeDefinition: {
      schemaVersion: 1,
      goal: "",
      baseStyle: "",
      colorAnchors: [],
      materialRules: "",
      particleRules: "",
      layeringRules: "",
      constraints: "",
      acceptanceCriteria: "",
      exclusions: "",
    },
    selectedSkillIds: [],
    skillPrompts: [],
  };
}

function completeStyle(): SaveProfessionStyleInput {
  const input = draft();
  input.themeDefinition = {
    schemaVersion: 1,
    goal: "保持职业动作并追加冷蓝主题。",
    baseStyle: "icy cobalt-blue energy",
    colorAnchors: [{ name: "冰蓝主光", value: "#1A8FFF" }],
    materialRules: "白色刃核配合冰蓝外辉光。",
    particleRules: "粒子稀疏且方向明确。",
    layeringRules: "裂纹在后，剑刃居中，辉光在前。",
    constraints: "保持源帧几何与锚点。",
    acceptanceCriteria: "动作轮廓保持可读。",
    exclusions: "排除暖色和无关 UI。",
  };
  input.selectedSkillIds = [skillId];
  input.skillPrompts = [
    {
      skillId,
      themePrompt: "horizontal dimensional rift",
      changes: "追加冰蓝次元裂隙。",
      acceptanceCriteria: "主切线保持可读。",
      exclusions: "排除粒子遮挡。",
    },
  ];
  return input;
}

function emptySkillPrompt(
  selectedSkillId: string,
): SaveProfessionStyleInput["skillPrompts"][number] {
  return {
    skillId: selectedSkillId,
    themePrompt: "",
    changes: "",
    acceptanceCriteria: "",
    exclusions: "",
  };
}
