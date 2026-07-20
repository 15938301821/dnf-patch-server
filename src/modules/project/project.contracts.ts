import { z } from "zod";
import {
  clientIdSchema,
  idSchema,
  safeDisplayNameSchema,
  sha256Schema,
} from "../../common/contracts/index.js";

export const createProjectSchema = z
  .object({
    factoryId: clientIdSchema,
    clientProjectId: clientIdSchema.optional(),
    displayName: safeDisplayNameSchema,
  })
  .strict();

export const projectSnapshotSchema = z
  .object({
    clientSnapshotId: clientIdSchema,
    rootRulesSha256: sha256Schema,
    manifestSha256: sha256Schema.optional(),
    promptTreeSha256: sha256Schema,
    toolCatalogSha256: sha256Schema,
    repositoryRevision: z.string().max(80).optional(),
    fullSkillCoverageProven: z.literal(false).default(false),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateProjectSnapshotInput = z.infer<typeof projectSnapshotSchema>;

export interface ProjectView {
  id: string;
  factoryId: string;
  clientProjectId?: string;
  displayName: string;
  canonicalName: string;
  version: number;
  archived: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface ProjectSnapshotView extends CreateProjectSnapshotInput {
  id: string;
  projectId: string;
  createdAtUtc: string;
}

export const projectIdSchema = idSchema;
