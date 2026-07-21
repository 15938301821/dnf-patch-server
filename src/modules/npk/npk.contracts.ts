import { z } from "zod";
import {
  repositoryRelativePathSchema,
  sha256Schema,
} from "../../common/contracts/index.js";

export function normalizeNpkInternalPath(value: string): string {
  return value.replaceAll("\\", "/").normalize("NFC").toLowerCase();
}

const npkInternalPathSchema = repositoryRelativePathSchema
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
        );
      }),
    { message: "NPK 内部路径不能包含控制字符。" },
  )
  .transform(normalizeNpkInternalPath);

export const inventoryEntrySchema = z
  .object({
    internalPath: npkInternalPathSchema,
    imgVersion: z.number().int().min(1).max(6),
    frameCount: z.number().int().min(0).max(1_000_000),
    metadataSha256: sha256Schema,
  })
  .strict();

export const createInventorySchema = z
  .object({
    runId: z.uuid(),
    sourceLabel: z.string().trim().min(1).max(200),
    sourceLength: z.number().int().min(1).max(4_294_967_295),
    sourceSha256: sha256Schema,
    inventoryArtifactId: z.uuid().optional(),
    entries: z.array(inventoryEntrySchema).min(1).max(100_000),
  })
  .strict();

export type CreateInventoryInput = z.infer<typeof createInventorySchema>;
export type InventoryEntryInput = z.infer<typeof inventoryEntrySchema>;

export interface InventoryView {
  id: string;
  projectId: string;
  runId: string;
  sourceLabel: string;
  sourceLength: number;
  sourceSha256: string;
  status: "frozen";
  inventoryArtifactId?: string;
  entryCount: number;
  createdAtUtc: string;
}

export interface InventoryEntryEvidence {
  id: string;
  inventoryId: string;
  projectId: string;
  runId: string;
  metadataSha256: string;
}
