import { z } from "zod";
import { clientIdSchema, sha256Schema } from "../../common/contracts/index.js";
import { createJobSchema } from "../job/job.contracts.js";

export const createRunSchema = z.object({
  projectId: z.uuid(),
  snapshotId: z.uuid(),
  clientRunId: clientIdSchema,
  action: z.enum([
    "create-profession",
    "create-theme",
    "generate-patch",
    "validate-only",
    "package-bpk",
  ]),
  requestSha256: sha256Schema,
  serverConnectionEnabled: z.literal(true).default(true),
  modelEgressAuthorized: z.boolean().default(false),
  deploymentAuthorized: z.literal(false).default(false),
  deploymentPerformed: z.literal(false).default(false),
  fullSkillCoverageProven: z.literal(false).default(false),
  clientCompatibilityProven: z.literal(false).default(false),
  jobs: z.array(createJobSchema).min(1).max(64),
  policyId: clientIdSchema,
  policySha256: sha256Schema,
});

export const runEventQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const runSubscriptionSchema = z.object({
  runId: z.uuid(),
  afterSequence: z.number().int().min(-1).default(-1),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;
export type RunEventQuery = z.infer<typeof runEventQuerySchema>;
export type RunSubscription = z.infer<typeof runSubscriptionSchema>;

export interface RunView {
  id: string;
  projectId: string;
  snapshotId: string;
  clientRunId: string;
  action: string;
  status: string;
  currentStage: string;
  requestSha256: string;
  serverConnectionEnabled: true;
  modelEgressAuthorized: boolean;
  deploymentAuthorized: false;
  deploymentPerformed: false;
  fullSkillCoverageProven: false;
  clientCompatibilityProven: false;
  createdAtUtc: string;
  updatedAtUtc: string;
  finishedAtUtc?: string;
}

export interface RunEventView {
  runId: string;
  sequence: number;
  level: "info" | "warning" | "error";
  stage: string;
  message: string;
  evidenceArtifactId?: string;
  createdAtUtc: string;
}
