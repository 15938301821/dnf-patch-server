/**
 * @fileoverview 定义结构化主题技能生产 Job V2 冻结包；不执行模型、图片或本机工具。
 * @module job
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A（对应当前前后端结构化主题直接需求）
 */
import { z } from "zod";
import {
  boundedJsonRecordSchema,
  clientIdSchema,
  sha256Schema,
} from "../../common/contracts/index.js";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import {
  professionPromptDefinitionSchema,
  skillThemePromptSchema,
  themeDefinitionSchema,
  type ProfessionPromptDefinition,
  type SkillThemePrompt,
  type StyleBuildContext,
  type ThemeDefinition,
} from "../profession/profession.contracts.js";
import { declarativeParametersSchema } from "../guardrail/guardrail.contracts.js";

const uniqueSkillIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: "selectedSkillIds 不能包含重复项。",
  });

const frozenSourceEntriesSchema = z
  .array(
    z
      .object({
        sourceInventoryEntryId: z.uuid(),
        sourceMetadataSha256: sha256Schema,
      })
      .strict(),
  )
  .min(1)
  .max(500)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.sourceInventoryEntryId)).size ===
      entries.length,
    { message: "冻结技能源不能包含重复 Inventory Entry。" },
  );

const frozenStyleSkillSchema = z
  .object({
    skillId: z.uuid(),
    professionPrompt: professionPromptDefinitionSchema,
    professionPromptSha256: sha256Schema,
    skillThemePrompt: skillThemePromptSchema,
    promptSha256: sha256Schema,
    sourceEvidence: z
      .object({
        sourceRunId: z.uuid(),
        sourceInventoryId: z.uuid(),
        sourceFrameManifestArtifactId: z.uuid(),
        sourceEntries: frozenSourceEntriesSchema,
      })
      .strict(),
  })
  .strict();

export const styleSkillPromptPackageV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    themeDefinition: themeDefinitionSchema,
    skills: z.array(frozenStyleSkillSchema).min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const skillIds = value.skills.map((skill) => skill.skillId);
    if (new Set(skillIds).size !== skillIds.length) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "冻结包不能包含重复技能。",
      });
    }
    value.skills.forEach((skill, index) => {
      if (skill.skillThemePrompt.skillId !== skill.skillId) {
        context.addIssue({
          code: "custom",
          path: ["skills", index, "skillThemePrompt", "skillId"],
          message: "技能主题 Prompt 必须属于当前冻结技能。",
        });
      }
      if (
        sha256JcsV1(skill.professionPrompt) !==
        skill.professionPromptSha256.toUpperCase()
      ) {
        context.addIssue({
          code: "custom",
          path: ["skills", index, "professionPromptSha256"],
          message: "职业 Prompt 哈希与冻结内容不一致。",
        });
      }
      const composition = createStyleSkillPromptComposition(
        value.themeDefinition,
        skill,
      );
      if (sha256JcsV1(composition) !== skill.promptSha256.toUpperCase()) {
        context.addIssue({
          code: "custom",
          path: ["skills", index, "promptSha256"],
          message: "逐技能 Prompt 哈希与冻结组合不一致。",
        });
      }
    });
  });

const styleSkillProductionParametersV2Schema = z
  .object({
    workflow: z.literal("style-skill-production-v2"),
    professionId: z.uuid(),
    styleId: z.uuid(),
    selectedSkillIds: uniqueSkillIdsSchema,
    promptPackage: styleSkillPromptPackageV2Schema,
    promptPackageSha256: sha256Schema,
    toolProfiles: z.tuple([z.literal("aseprite-cli")]),
    deploymentAuthorized: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    const frozenSkillIds = value.promptPackage.skills.map(
      (skill) => skill.skillId,
    );
    if (
      JSON.stringify(frozenSkillIds) !== JSON.stringify(value.selectedSkillIds)
    ) {
      context.addIssue({
        code: "custom",
        path: ["promptPackage", "skills"],
        message: "冻结技能顺序必须与 selectedSkillIds 完全一致。",
      });
    }
    if (
      sha256JcsV1(value.promptPackage) !==
      value.promptPackageSha256.toUpperCase()
    ) {
      context.addIssue({
        code: "custom",
        path: ["promptPackageSha256"],
        message: "主题 Prompt 包哈希与冻结内容不一致。",
      });
    }
  });

export const styleSkillProductionJobPayloadV2Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: clientIdSchema,
    parameters: styleSkillProductionParametersV2Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!boundedJsonRecordSchema.safeParse(value).success) {
      context.addIssue({
        code: "custom",
        message: "主题技能生产 Job 不能超过声明式 JSON 预算。",
      });
    }
    if (!declarativeParametersSchema.safeParse(value.parameters).success) {
      context.addIssue({
        code: "custom",
        path: ["parameters"],
        message: "主题技能生产 Job 包含不安全的非声明式字段。",
      });
    }
  });

export type StyleSkillPromptPackageV2 = z.infer<
  typeof styleSkillPromptPackageV2Schema
>;
export type StyleSkillProductionJobPayloadV2 = z.infer<
  typeof styleSkillProductionJobPayloadV2Schema
>;

/** 从已通过 Service 门禁的上下文生成唯一有序冻结包，并在返回前重新执行完整运行时校验。 */
export function createStyleSkillProductionJobPayload(
  context: StyleBuildContext,
  profileId: string,
): StyleSkillProductionJobPayloadV2 {
  const skillsById = new Map(context.skills.map((skill) => [skill.id, skill]));
  const themePromptsBySkillId = new Map(
    context.style.skillPrompts.map((prompt) => [prompt.skillId, prompt]),
  );
  const skills = context.style.selectedSkillIds.map((skillId) => {
    const skill = skillsById.get(skillId);
    const skillThemePrompt = themePromptsBySkillId.get(skillId);
    if (!skill || !skillThemePrompt) {
      throw new Error("STYLE_SKILL_FREEZE_CONTEXT_MISSING");
    }
    const frozenSkill = {
      skillId,
      professionPrompt: skill.professionPrompt,
      professionPromptSha256: skill.professionPromptSha256.toUpperCase(),
      skillThemePrompt,
      sourceEvidence: {
        sourceRunId: skill.sourceRunId,
        sourceInventoryId: skill.sourceInventoryId,
        sourceFrameManifestArtifactId: skill.sourceFrameManifestArtifactId,
        sourceEntries: skill.sourceEntries.map((source) => ({
          sourceInventoryEntryId: source.sourceInventoryEntryId,
          sourceMetadataSha256: source.sourceMetadataSha256.toUpperCase(),
        })),
      },
    };
    return {
      ...frozenSkill,
      promptSha256: sha256JcsV1(
        createStyleSkillPromptComposition(
          context.style.themeDefinition,
          frozenSkill,
        ),
      ),
    };
  });
  const promptPackage = {
    schemaVersion: 2 as const,
    themeDefinition: context.style.themeDefinition,
    skills,
  };
  return styleSkillProductionJobPayloadV2Schema.parse({
    schemaVersion: 1,
    profileId,
    parameters: {
      workflow: "style-skill-production-v2",
      professionId: context.profession.id,
      styleId: context.style.id,
      selectedSkillIds: context.style.selectedSkillIds,
      promptPackage,
      promptPackageSha256: sha256JcsV1(promptPackage),
      toolProfiles: ["aseprite-cli"],
      deploymentAuthorized: false,
    },
  });
}

/** 返回写入逐技能审计哈希的精确 Prompt 组合，不包含可变执行状态。 */
export function createStyleSkillPromptComposition(
  themeDefinition: ThemeDefinition,
  skill: {
    professionPrompt: ProfessionPromptDefinition;
    professionPromptSha256: string;
    skillThemePrompt: SkillThemePrompt;
  },
): {
  schemaVersion: 2;
  themeDefinition: ThemeDefinition;
  professionPrompt: ProfessionPromptDefinition;
  professionPromptSha256: string;
  skillThemePrompt: SkillThemePrompt;
} {
  return {
    schemaVersion: 2,
    themeDefinition,
    professionPrompt: skill.professionPrompt,
    professionPromptSha256: skill.professionPromptSha256.toUpperCase(),
    skillThemePrompt: skill.skillThemePrompt,
  };
}
