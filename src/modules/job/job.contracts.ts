import { z } from "zod";
import { boundedJsonRecordSchema } from "../../common/contracts/index.js";
import { allowedJobKindSchema } from "../guardrail/guardrail.contracts.js";

export const createJobSchema = z
  .object({
    kind: allowedJobKindSchema,
    payload: boundedJsonRecordSchema,
    maxAttempts: z.number().int().min(1).max(10).default(3),
  })
  .strict();

export const claimJobSchema = z.object({ workerId: z.uuid() }).strict();

export const heartbeatJobSchema = z
  .object({
    workerId: z.uuid(),
    leaseId: z.uuid().optional(),
  })
  .strict();

export const completeJobSchema = z
  .object({
    workerId: z.uuid(),
    leaseId: z.uuid().optional(),
    status: z.enum(["passed", "failed", "blocked"]),
    resultSha256: z
      .string()
      .regex(/^[A-Fa-f0-9]{64}$/u)
      .optional(),
    errorCode: z.string().max(80).optional(),
    errorMessage: z.string().max(2_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "passed" && value.resultSha256 === undefined) {
      context.addIssue({
        code: "custom",
        path: ["resultSha256"],
        message: "通过的 Job 必须提供结果 SHA-256。",
      });
    }
    if (value.status !== "passed" && value.errorCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "失败或阻断的 Job 必须提供稳定错误码。",
      });
    }
  });

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type ClaimJobInput = z.infer<typeof claimJobSchema>;
export type HeartbeatJobInput = z.infer<typeof heartbeatJobSchema>;
export type CompleteJobInput = z.infer<typeof completeJobSchema>;

export interface JobView {
  id: string;
  runId: string;
  kind: z.infer<typeof allowedJobKindSchema>;
  status: string;
  payload: Record<string, unknown>;
  payloadSha256: string;
  leaseOwnerId?: string;
  leaseId?: string;
  leaseExpiresAtUtc?: string;
  attemptCount: number;
  maxAttempts: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}
