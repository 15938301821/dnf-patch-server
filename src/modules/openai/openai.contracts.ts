import type { z } from "zod";

export type ModelRole = "orchestrator" | "engineer" | "artist";
export type ModelCallStatus =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "abandoned";

export interface StructuredModelRequest<T> {
  runId: string;
  role: Exclude<ModelRole, "artist">;
  schemaName: string;
  schema: z.ZodType<T>;
  instructions: string;
  input: string;
}

export interface ImageModelRequest {
  runId: string;
  role: "artist";
  prompt: string;
}

export interface ModelCallView {
  id: string;
  runId: string;
  role: ModelRole;
  model: string;
  endpointIdentity: string;
  modelConfigurationVersion?: number;
  requestSha256: string;
  responseSha256?: string;
  responseId?: string;
  status: ModelCallStatus;
  modelEgressAuthorized: boolean;
  modelEgressPerformed: boolean;
  errorCode?: string;
  createdAtUtc: string;
  finishedAtUtc?: string;
}

export interface StructuredModelResult<T> {
  value?: T;
  record: ModelCallView;
}

export interface ImageModelResult {
  bytes?: Uint8Array;
  record: ModelCallView;
}
