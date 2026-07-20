import { z } from "zod";
import {
  repositoryRelativePathSchema,
  sha256Schema,
} from "../../common/contracts/index.js";

export const artifactProvenanceSchema = z.record(z.string(), z.json());

export const createArtifactSchema = z.object({
  logicalName: z.string().trim().min(1).max(200),
  storageKey: repositoryRelativePathSchema,
  mediaType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u),
  byteLength: z.number().int().min(0).max(4_294_967_295),
  sha256: sha256Schema,
  provenance: artifactProvenanceSchema,
});

export type CreateArtifactInput = z.infer<typeof createArtifactSchema>;

export interface ArtifactView extends CreateArtifactInput {
  id: string;
  runId: string;
  createdAtUtc: string;
}
