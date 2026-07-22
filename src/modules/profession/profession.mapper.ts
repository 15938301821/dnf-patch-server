/**
 * @fileoverview 将职业领域数据库行映射为公开 DTO，并重新校验数据库枚举值。
 * @module profession
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import type {
  professionSkills,
  professionStyleSkills,
  professionStyles,
  professions,
} from "../../common/db/studio-schema.js";
import {
  publishStatusSchema,
  professionPromptDefinitionSchema,
  skillExecutionStatusSchema,
  skillMappingStatusSchema,
  skillPromptStatusSchema,
  skillThemePromptSchema,
  themeDefinitionSchema,
  type ProfessionRecord,
  type ProfessionSkillSummary,
  type ProfessionStyle,
  type ProfessionSummary,
  type SkillThemePrompt,
} from "./profession.contracts.js";

export function toProfessionSummary(
  row: typeof professions.$inferSelect,
  styleCount: number,
): ProfessionSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    styleCount,
    publishStatus: publishStatusSchema.parse(row.publishStatus),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProfessionRecord(
  row: typeof professions.$inferSelect,
  styleCount: number,
): ProfessionRecord {
  return {
    ...toProfessionSummary(row, styleCount),
    canonicalName: row.canonicalName,
    ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
    ...(row.workflowProjectId
      ? { workflowProjectId: row.workflowProjectId }
      : {}),
    ...(row.catalogSnapshotId
      ? { catalogSnapshotId: row.catalogSnapshotId }
      : {}),
  };
}

export function toSkillSummary(
  row: typeof professionSkills.$inferSelect,
): ProfessionSkillSummary {
  const professionPrompt = row.professionPrompt
    ? professionPromptDefinitionSchema.parse(row.professionPrompt)
    : undefined;
  if (professionPrompt && !row.professionPromptSha256) {
    throw new Error("PROFESSION_PROMPT_HASH_MISSING");
  }
  return {
    id: row.id,
    professionId: row.professionId,
    displayName: row.displayName,
    promptStatus: skillPromptStatusSchema.parse(row.promptStatus),
    mappingStatus: skillMappingStatusSchema.parse(row.mappingStatus),
    executionStatus: skillExecutionStatusSchema.parse(row.executionStatus),
    ...(professionPrompt ? { professionPrompt } : {}),
    ...(row.professionPromptSha256
      ? { professionPromptSha256: row.professionPromptSha256 }
      : {}),
  };
}

export function toStyle(
  row: typeof professionStyles.$inferSelect,
  skillPrompts: SkillThemePrompt[],
): ProfessionStyle {
  const themeDefinition = row.themeDefinition
    ? themeDefinitionSchema.parse(row.themeDefinition)
    : themeDefinitionSchema.parse({
        schemaVersion: 1,
        goal: "",
        baseStyle: row.prompt,
        colorAnchors: [],
        materialRules: "",
        particleRules: "",
        layeringRules: "",
        constraints: row.agent,
        acceptanceCriteria: "",
        exclusions: "",
      });
  return {
    id: row.id,
    professionId: row.professionId,
    name: row.name,
    description: row.description,
    themeDefinition,
    selectedSkillIds: skillPrompts.map((prompt) => prompt.skillId),
    skillPrompts,
    publishStatus: publishStatusSchema.parse(row.publishStatus),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSkillThemePrompt(
  row: typeof professionStyleSkills.$inferSelect,
): SkillThemePrompt {
  return skillThemePromptSchema.parse({
    skillId: row.skillId,
    themePrompt: row.customPrompt ?? "",
    changes: row.changes ?? "",
    acceptanceCriteria: row.acceptanceCriteria ?? "",
    exclusions: row.exclusions ?? "",
  });
}
