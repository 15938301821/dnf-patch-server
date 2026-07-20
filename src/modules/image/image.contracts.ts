import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";

export const createImageAttemptSchema = z.object({
  modelCallId: z.uuid().optional(),
  promptSha256: sha256Schema,
  inputSnapshotSha256: sha256Schema,
  generationConfigSha256: sha256Schema,
  actualSeed: z.string().max(80).optional(),
  adapterIdentity: z.string().trim().min(1).max(200),
  outputArtifactId: z.uuid().optional(),
  status: z.enum(["planned", "generated", "failed", "adapted"]),
  directRuntimeUseAllowed: z.literal(false).default(false),
});

export type CreateImageAttemptInput = z.infer<typeof createImageAttemptSchema>;

export interface ImageAttemptView extends CreateImageAttemptInput {
  id: string;
  runId: string;
  createdAtUtc: string;
}
