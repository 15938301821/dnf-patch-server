/**
 * @fileoverview 将职业领域数据库行映射为公开 DTO，并重新校验数据库枚举值。
 * @module profession
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import type {
  professionSkills,
  professionStyles,
  professions,
} from "../../common/db/studio-schema.js";
import {
  publishStatusSchema,
  skillExecutionStatusSchema,
  skillMappingStatusSchema,
  skillPromptStatusSchema,
  type ProfessionRecord,
  type ProfessionSkillSummary,
  type ProfessionStyle,
  type ProfessionSummary,
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
  return {
    id: row.id,
    professionId: row.professionId,
    displayName: row.displayName,
    promptStatus: skillPromptStatusSchema.parse(row.promptStatus),
    mappingStatus: skillMappingStatusSchema.parse(row.mappingStatus),
    executionStatus: skillExecutionStatusSchema.parse(row.executionStatus),
  };
}

export function toStyle(
  row: typeof professionStyles.$inferSelect,
  selectedSkillIds: string[],
): ProfessionStyle {
  return {
    id: row.id,
    professionId: row.professionId,
    name: row.name,
    description: row.description,
    agent: row.agent,
    prompt: row.prompt,
    selectedSkillIds,
    publishStatus: publishStatusSchema.parse(row.publishStatus),
    updatedAt: row.updatedAt.toISOString(),
  };
}
