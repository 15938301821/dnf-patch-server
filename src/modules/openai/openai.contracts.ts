import type { z } from "zod";

export type ModelRole = "orchestrator" | "engineer" | "artist";

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
  requestSha256: string;
  responseSha256?: string;
  responseId?: string;
  status: "passed" | "failed" | "blocked";
  modelEgressAuthorized: boolean;
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
