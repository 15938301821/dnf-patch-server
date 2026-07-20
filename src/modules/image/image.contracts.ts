import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";

export const createImageAttemptSchema = z
  .object({
    modelCallId: z.uuid().optional(),
    promptSha256: sha256Schema,
    inputSnapshotSha256: sha256Schema,
    generationConfigSha256: sha256Schema,
    actualSeed: z.string().max(80).optional(),
    adapterIdentity: z.string().trim().min(1).max(200),
    outputArtifactId: z.uuid().optional(),
    status: z.enum(["planned", "generated", "failed", "adapted"]),
    directRuntimeUseAllowed: z.literal(false).default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "generated" || value.status === "adapted") &&
      value.outputArtifactId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["outputArtifactId"],
        message: "已生成或已适配的 Image Attempt 必须绑定输出 Artifact。",
      });
    }
  });

export type CreateImageAttemptInput = z.infer<typeof createImageAttemptSchema>;

export interface ImageAttemptView extends CreateImageAttemptInput {
  id: string;
  runId: string;
  createdAtUtc: string;
}
