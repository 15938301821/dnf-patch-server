/**
 * @fileoverview 定义前端职业、技能、主题契约及 Worker 技能目录导入契约；不包含资源正文或执行参数。
 * @module profession
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import { z } from "zod";
import {
  clientIdSchema,
  safeDisplayNameSchema,
  sha256Schema,
} from "../../common/contracts/index.js";

export const publishStatusSchema = z.enum([
  "private",
  "pending",
  "published",
  "rejected",
]);
export const skillPromptStatusSchema = z.enum(["candidate", "reviewed"]);
export const skillMappingStatusSchema = z.enum(["unverified", "verified"]);
export const skillExecutionStatusSchema = z.enum(["draft-only", "build-ready"]);

export const createProfessionSchema = z
  .object({
    name: safeDisplayNameSchema,
    slug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  })
  .strict();

const promptSectionSchema = z.string().trim().max(8_000);

export const professionPromptDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    stableSemantics: promptSectionSchema.min(1),
    commonPrompt: promptSectionSchema.min(1),
    sourceConstraints: promptSectionSchema.min(1),
    stageAcceptance: promptSectionSchema.min(1),
  })
  .strict();

export const themeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    goal: promptSectionSchema,
    baseStyle: promptSectionSchema,
    colorAnchors: z
      .array(
        z
          .object({
            name: z.string().trim().max(60),
            value: z.string().regex(/^#[A-Fa-f0-9]{6}$/u),
          })
          .strict(),
      )
      .max(16),
    materialRules: promptSectionSchema,
    particleRules: promptSectionSchema,
    layeringRules: promptSectionSchema,
    constraints: promptSectionSchema,
    acceptanceCriteria: promptSectionSchema,
    exclusions: promptSectionSchema,
  })
  .strict();

export const skillThemePromptSchema = z
  .object({
    skillId: z.uuid(),
    themePrompt: promptSectionSchema,
    changes: promptSectionSchema,
    acceptanceCriteria: promptSectionSchema,
    exclusions: promptSectionSchema,
  })
  .strict();

const selectedSkillIdsSchema = z
  .array(z.uuid())
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: "selectedSkillIds 不能包含重复项。",
  });

const saveProfessionStyleBaseSchema = z
  .object({
    name: safeDisplayNameSchema,
    description: z.string().trim().max(2_000),
    themeDefinition: themeDefinitionSchema,
    selectedSkillIds: selectedSkillIdsSchema,
    skillPrompts: z.array(skillThemePromptSchema).max(500),
  })
  .strict();

type SaveProfessionStyleBase = z.infer<typeof saveProfessionStyleBaseSchema>;

export const stylePromptPackageMaxBytes = 48 * 1_024;

export const saveProfessionStyleSchema =
  saveProfessionStyleBaseSchema.superRefine((value, context) => {
    const promptSkillIds = value.skillPrompts.map((prompt) => prompt.skillId);
    if (new Set(promptSkillIds).size !== promptSkillIds.length) {
      context.addIssue({
        code: "custom",
        path: ["skillPrompts"],
        message: "skillPrompts 不能包含重复技能。",
      });
    }
    const selectedIds = new Set(value.selectedSkillIds);
    if (
      selectedIds.size !== promptSkillIds.length ||
      promptSkillIds.some((skillId) => !selectedIds.has(skillId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["skillPrompts"],
        message: "skillPrompts 必须与 selectedSkillIds 一一对应。",
      });
    }
    if (stylePromptPackageBytes(value) > stylePromptPackageMaxBytes) {
      context.addIssue({
        code: "custom",
        path: ["skillPrompts"],
        message: "主题 Prompt 包不能超过 48 KiB。",
      });
    }
  });

const importSkillSourceEntrySchema = z
  .object({
    sourceInventoryEntryId: z.uuid(),
    sourceMetadataSha256: sha256Schema,
  })
  .strict();

const importSkillSchema = z
  .object({
    stableKey: clientIdSchema,
    displayName: safeDisplayNameSchema,
    promptStatus: skillPromptStatusSchema.default("candidate"),
    sourceScope: z.literal("entire-inventory"),
    sourceInventoryId: z.uuid(),
    sourceEntries: z
      .array(importSkillSourceEntrySchema)
      .min(1)
      .max(500)
      .superRefine((entries, context) => {
        const entryIds = entries.map((entry) => entry.sourceInventoryEntryId);
        if (new Set(entryIds).size !== entryIds.length) {
          context.addIssue({
            code: "custom",
            message: "技能来源不能包含重复 Inventory Entry。",
          });
        }
      }),
    sourceFrameManifestArtifactId: z.uuid(),
    professionPrompt: professionPromptDefinitionSchema.optional(),
  })
  .strict();

/**
 * Worker 内部目录上下文绑定 DTO；只接受已登记的 Project/Snapshot 标识，不允许顺带声明技能映射。
 * Service 校验复合归属后会把职业现有技能降级为未核验，后续仍须经 skill-catalog 端点导入证据。
 */
export const bindProfessionCatalogContextSchema = z
  .object({
    workflowProjectId: z.uuid(),
    catalogSnapshotId: z.uuid(),
  })
  .strict();

export const importProfessionSkillCatalogSchema = z
  .object({
    workflowProjectId: z.uuid(),
    catalogSnapshotId: z.uuid(),
    sourceRunId: z.uuid(),
    skills: z
      .array(importSkillSchema)
      .min(1)
      .max(500)
      .superRefine((skills, context) => {
        const stableKeys = skills.map((skill) => skill.stableKey);
        if (new Set(stableKeys).size !== stableKeys.length) {
          context.addIssue({
            code: "custom",
            message: "技能目录不能包含重复 stableKey。",
          });
        }
      }),
  })
  .strict();

export type CreateProfessionInput = z.infer<typeof createProfessionSchema>;
export type SaveProfessionStyleInput = z.infer<
  typeof saveProfessionStyleSchema
>;
export type BindProfessionCatalogContextInput = z.infer<
  typeof bindProfessionCatalogContextSchema
>;
export type ImportProfessionSkillCatalogInput = z.infer<
  typeof importProfessionSkillCatalogSchema
>;
export type ImportProfessionSkillInput = z.infer<typeof importSkillSchema>;
export type ProfessionPromptDefinition = z.infer<
  typeof professionPromptDefinitionSchema
>;
export type ThemeDefinition = z.infer<typeof themeDefinitionSchema>;
export type SkillThemePrompt = z.infer<typeof skillThemePromptSchema>;

export interface ProfessionSummary {
  id: string;
  name: string;
  slug: string;
  styleCount: number;
  publishStatus: z.infer<typeof publishStatusSchema>;
  updatedAt: string;
}

export interface ProfessionSkillSummary {
  id: string;
  professionId: string;
  displayName: string;
  promptStatus: z.infer<typeof skillPromptStatusSchema>;
  mappingStatus: z.infer<typeof skillMappingStatusSchema>;
  executionStatus: z.infer<typeof skillExecutionStatusSchema>;
  professionPrompt?: ProfessionPromptDefinition;
  professionPromptSha256?: string;
}

export interface ProfessionStyle {
  id: string;
  professionId: string;
  name: string;
  description: string;
  themeDefinition: ThemeDefinition;
  selectedSkillIds: string[];
  skillPrompts: SkillThemePrompt[];
  publishStatus: z.infer<typeof publishStatusSchema>;
  updatedAt: string;
}

export interface ProfessionRecord extends ProfessionSummary {
  canonicalName: string;
  ownerUserId?: string;
  workflowProjectId?: string;
  catalogSnapshotId?: string;
}

export interface VerifiedProfessionSkillRecord extends ImportProfessionSkillInput {
  sourceRunId: string;
}

export interface BuildReadySkill extends ProfessionSkillSummary {
  sourceRunId: string;
  sourceInventoryId: string;
  sourceFrameManifestArtifactId: string;
  sourceEntries: ImportProfessionSkillInput["sourceEntries"];
  professionPrompt: ProfessionPromptDefinition;
  professionPromptSha256: string;
}

export interface StyleBuildContext {
  profession: ProfessionRecord;
  style: ProfessionStyle;
  skills: BuildReadySkill[];
  missingProfessionPromptSkillIds: string[];
}

export interface ProfessionCatalogImportView {
  professionId: string;
  workflowProjectId: string;
  catalogSnapshotId: string;
  sourceRunId: string;
  importedSkillCount: number;
  skills: ProfessionSkillSummary[];
}

/**
 * 目录上下文绑定后的公开结果；skills 仅反映降级后的目录状态，不包含资源、Artifact 或路径细节。
 */
export interface ProfessionCatalogContextView {
  professionId: string;
  workflowProjectId: string;
  catalogSnapshotId: string;
  skills: ProfessionSkillSummary[];
}

export type StyleContentIncompleteReason =
  | "theme-incomplete"
  | "skills-required"
  | "skill-prompts-incomplete";

export interface StyleContentCompleteness {
  complete: boolean;
  incompleteSkillIds: string[];
  reasons: StyleContentIncompleteReason[];
}

/** Evaluates content required for review without rejecting valid private drafts. */
export function evaluateStyleContentCompleteness(
  style: SaveProfessionStyleInput,
): StyleContentCompleteness {
  const reasons: StyleContentIncompleteReason[] = [];
  const theme = style.themeDefinition;
  if (
    ![
      theme.goal,
      theme.baseStyle,
      theme.materialRules,
      theme.particleRules,
      theme.layeringRules,
      theme.constraints,
      theme.acceptanceCriteria,
      theme.exclusions,
    ].every(hasText) ||
    theme.colorAnchors.length === 0 ||
    theme.colorAnchors.some((anchor) => !hasText(anchor.name))
  ) {
    reasons.push("theme-incomplete");
  }
  if (style.selectedSkillIds.length === 0) {
    reasons.push("skills-required");
  }
  const incompleteSkillIds = style.skillPrompts
    .filter(
      (prompt) =>
        !hasText(prompt.themePrompt) ||
        !hasText(prompt.changes) ||
        !hasText(prompt.acceptanceCriteria) ||
        !hasText(prompt.exclusions),
    )
    .map((prompt) => prompt.skillId);
  if (incompleteSkillIds.length > 0) {
    reasons.push("skill-prompts-incomplete");
  }
  return { complete: reasons.length === 0, incompleteSkillIds, reasons };
}

/** Returns the UTF-8 size of the exact style content frozen into a task. */
export function stylePromptPackageBytes(
  style: Pick<SaveProfessionStyleBase, "themeDefinition" | "skillPrompts">,
): number {
  return Buffer.byteLength(
    JSON.stringify({
      schemaVersion: 1,
      themeDefinition: style.themeDefinition,
      skillPrompts: style.skillPrompts,
    }),
    "utf8",
  );
}

function hasText(value: string): boolean {
  return value.trim().length > 0;
}
