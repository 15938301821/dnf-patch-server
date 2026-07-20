import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";

export const inventoryEntrySchema = z.object({
  internalPath: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => !value.replaceAll("\\", "/").split("/").includes(".."), {
      message: "NPK 内部路径不能包含父目录段。",
    }),
  imgVersion: z.number().int().min(1).max(6),
  frameCount: z.number().int().min(0).max(1_000_000),
  metadataSha256: sha256Schema,
});

export const createInventorySchema = z.object({
  sourceLabel: z.string().trim().min(1).max(200),
  sourceLength: z.number().int().min(1).max(4_294_967_295),
  sourceSha256: sha256Schema,
  inventoryArtifactId: z.uuid().optional(),
  entries: z.array(inventoryEntrySchema).min(1).max(100_000),
});

export type CreateInventoryInput = z.infer<typeof createInventorySchema>;
export type InventoryEntryInput = z.infer<typeof inventoryEntrySchema>;

export interface InventoryView {
  id: string;
  projectId: string;
  sourceLabel: string;
  sourceLength: number;
  sourceSha256: string;
  status: "frozen";
  inventoryArtifactId?: string;
  entryCount: number;
  createdAtUtc: string;
}
