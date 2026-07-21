import { z } from "zod";
import { clientIdSchema, sha256Schema } from "../../common/contracts/index.js";
import { createJobSchema } from "../job/job.contracts.js";

export const createRunSchema = z
  .object({
    projectId: z.uuid(),
    snapshotId: z.uuid(),
    clientRunId: clientIdSchema,
    action: z.enum([
      "create-profession",
      "create-theme",
      "generate-patch",
      "validate-only",
      "package-bpk",
      "import-resources",
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
  })
  .strict();

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/u);

export const runEventQuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().min(-1).default(-1),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

export const runSubscriptionSchema = z
  .object({
    runId: z.uuid(),
    afterSequence: z.number().int().min(-1).default(-1),
  })
  .strict();

export const runEventSchema = z
  .object({
    runId: z.uuid(),
    sequence: z.number().int().min(0),
    level: z.enum(["info", "warning", "error"]),
    stage: z.string().trim().min(1).max(96),
    message: z.string().trim().min(1).max(2_000),
    evidenceArtifactId: z.uuid().optional(),
    createdAtUtc: z.iso.datetime({ offset: true }),
  })
  .strict();

export const runEventOutboxSchema = z
  .object({
    id: z.uuid(),
    topic: z.literal("run.event"),
    aggregateId: z.uuid(),
    payload: runEventSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.aggregateId !== value.payload.runId) {
      context.addIssue({
        code: "custom",
        path: ["aggregateId"],
        message: "Outbox aggregateId 必须与 Run Event 的 runId 一致。",
      });
    }
  });

export type CreateRunInput = z.infer<typeof createRunSchema>;
export type RunEventQuery = z.infer<typeof runEventQuerySchema>;
export type RunSubscription = z.infer<typeof runSubscriptionSchema>;
export type RunEventOutbox = z.infer<typeof runEventOutboxSchema>;

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

export type RunEventView = z.infer<typeof runEventSchema>;
