import { z } from "zod";
import { allowedJobKindSchema } from "../guardrail/guardrail.contracts.js";

export const registerWorkerSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(160),
  capabilities: z.array(allowedJobKindSchema).min(1),
});

export const heartbeatWorkerSchema = z.object({
  id: z.uuid(),
});

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
