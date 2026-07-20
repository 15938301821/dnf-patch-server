import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";

const frameGeometrySchema = z.object({
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  canvasWidth: z.number().int().min(0),
  canvasHeight: z.number().int().min(0),
  x: z.number().int(),
  y: z.number().int(),
});

export const frameGuardrailSchema = z.object({
  runId: z.uuid(),
  policyId: z.string().min(1).max(100),
  policySha256: sha256Schema,
  source: z.object({
    sha256: sha256Schema,
    geometry: frameGeometrySchema,
    alphaNonZeroPixels: z.number().int().min(0),
  }),
  candidate: z.object({
    sourceSha256: sha256Schema,
    geometry: frameGeometrySchema,
    alphaNonZeroPixels: z.number().int().min(0),
  }),
});

export type FrameGuardrailInput = z.infer<typeof frameGuardrailSchema>;

export interface FrameGuardrailResult {
  id: string;
  runId: string;
  decision: "allow" | "deny";
  reasonCode: string;
  checks: {
    sourceHash: boolean;
    size: boolean;
    anchor: boolean;
    alpha: boolean;
  };
  createdAtUtc: string;
}
