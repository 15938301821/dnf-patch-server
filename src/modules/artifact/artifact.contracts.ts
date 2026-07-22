import { z } from "zod";
import {
  boundedJsonRecordSchema,
  safeDisplayNameSchema,
  sha256Schema,
} from "../../common/contracts/index.js";
import { objectStorageMediaTypeSchema } from "../../common/storage/object-storage.client.js";

export const artifactProvenanceSchema = boundedJsonRecordSchema;

const artifactLeaseSchema = z
  .object({
    workerId: z.uuid(),
    leaseId: z.uuid(),
    attempt: z.number().int().min(1).max(10),
  })
  .strict();

export const authorizeArtifactUploadSchema = artifactLeaseSchema
  .extend({
    logicalName: safeDisplayNameSchema,
    mediaType: objectStorageMediaTypeSchema,
    byteLength: z.number().int().min(0).max(4_294_967_295),
    sha256: sha256Schema,
    provenance: artifactProvenanceSchema,
  })
  .strict();

export const finalizeArtifactUploadSchema = artifactLeaseSchema;
export const authorizeArtifactDownloadSchema = artifactLeaseSchema;

export type AuthorizeArtifactUploadInput = z.infer<
  typeof authorizeArtifactUploadSchema
>;
export type FinalizeArtifactUploadInput = z.infer<
  typeof finalizeArtifactUploadSchema
>;
export type AuthorizeArtifactDownloadInput = z.infer<
  typeof authorizeArtifactDownloadSchema
>;

export interface ArtifactUploadAuthorizationView {
  uploadId: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  expiresAtUtc: string;
}

export interface ArtifactDownloadAuthorizationView {
  artifactId: string;
  downloadUrl: string;
  expiresAtUtc: string;
}

export interface ArtifactView {
  id: string;
  runId: string;
  logicalName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  provenance: Record<string, unknown>;
  createdAtUtc: string;
}
