import { z } from "zod";
import { allowedJobKindSchema } from "../guardrail/guardrail.contracts.js";

export const workerCapabilitiesSchema = z
  .array(allowedJobKindSchema)
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length, {
    message: "Worker capabilities 不能重复。",
  });

export const registerWorkerSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().trim().min(1).max(160),
    capabilities: workerCapabilitiesSchema,
  })
  .strict();

export const heartbeatWorkerSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

export type RegisterWorkerInput = z.infer<typeof registerWorkerSchema>;
export type HeartbeatWorkerInput = z.infer<typeof heartbeatWorkerSchema>;

export interface WorkerView {
  id: string;
  displayName: string;
  capabilities: string[];
  disabled: boolean;
  lastHeartbeatAtUtc?: string;
  createdAtUtc: string;
}
