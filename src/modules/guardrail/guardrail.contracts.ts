import { z } from "zod";
import { clientIdSchema, sha256Schema } from "../../common/contracts/index.js";

export const allowedJobKindSchema = z.enum([
  "context-freeze",
  "inventory",
  "engineering-plan",
  "image-reference",
  "aseprite-adaptation",
  "npk-package",
  "independent-validation",
  "manual-review",
  "bpk-package",
  "shared-fx",
  "profession",
]);

export const guardrailInputSchema = z.object({
  policyId: clientIdSchema,
  policySha256: sha256Schema,
  jobKind: allowedJobKindSchema,
  payload: z.record(z.string(), z.json()),
  deploymentAuthorized: z.literal(false).default(false),
});

export type AllowedJobKind = z.infer<typeof allowedJobKindSchema>;
export type GuardrailInput = z.infer<typeof guardrailInputSchema>;

export interface GuardrailEvaluation {
  policyId: string;
  policySha256: string;
  inputSha256: string;
  decision: "allow" | "deny";
  reasonCode: string;
}

export interface GuardrailDecisionView {
  id: string;
  runId: string;
  policyId: string;
  policySha256: string;
  inputSha256: string;
  decision: "allow" | "deny";
  reasonCode: string;
  createdAtUtc: string;
}
