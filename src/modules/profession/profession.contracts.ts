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

const selectedSkillIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: "selectedSkillIds 不能包含重复项。",
  });

export const saveProfessionStyleSchema = z
  .object({
    name: safeDisplayNameSchema,
    description: z.string().trim().max(2_000),
    agent: z.string().trim().min(1).max(32_000),
    prompt: z.string().trim().min(1).max(32_000),
    selectedSkillIds: selectedSkillIdsSchema,
  })
  .strict();

const importSkillSchema = z
  .object({
    stableKey: clientIdSchema,
    displayName: safeDisplayNameSchema,
    promptStatus: skillPromptStatusSchema.default("candidate"),
    sourceInventoryId: z.uuid(),
    sourceInventoryEntryId: z.uuid(),
    sourceFrameManifestArtifactId: z.uuid(),
    sourceMetadataSha256: sha256Schema,
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
export type ImportProfessionSkillCatalogInput = z.infer<
  typeof importProfessionSkillCatalogSchema
>;
export type ImportProfessionSkillInput = z.infer<typeof importSkillSchema>;

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
}

export interface ProfessionStyle {
  id: string;
  professionId: string;
  name: string;
  description: string;
  agent: string;
  prompt: string;
  selectedSkillIds: string[];
  publishStatus: z.infer<typeof publishStatusSchema>;
  updatedAt: string;
}

export interface ProfessionRecord extends ProfessionSummary {
  canonicalName: string;
  workflowProjectId?: string;
  catalogSnapshotId?: string;
}

export interface VerifiedProfessionSkillRecord extends ImportProfessionSkillInput {
  sourceRunId: string;
}

export interface BuildReadySkill extends ProfessionSkillSummary {
  sourceRunId: string;
  sourceFrameManifestArtifactId: string;
  sourceMetadataSha256: string;
}

export interface StyleBuildContext {
  profession: ProfessionRecord;
  style: ProfessionStyle;
  skills: BuildReadySkill[];
}

export interface ProfessionCatalogImportView {
  professionId: string;
  workflowProjectId: string;
  catalogSnapshotId: string;
  sourceRunId: string;
  importedSkillCount: number;
  skills: ProfessionSkillSummary[];
}
