import { Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../common/db/database.service.js";
import { npkInventories, npkInventoryEntries } from "../../common/db/schema.js";
import {
  normalizeNpkInternalPath,
  type CreateInventoryInput,
  type InventoryEntryEvidence,
  type InventoryView,
} from "./npk.contracts.js";

export interface NpkRepositoryPort {
  create(
    projectId: string,
    runId: string,
    id: string,
    input: CreateInventoryInput,
  ): Promise<InventoryView>;
  list(projectId: string): Promise<InventoryView[]>;
  findEntryEvidence(
    inventoryId: string,
    entryId: string,
  ): Promise<InventoryEntryEvidence | undefined>;
}

@Injectable()
export class NpkRepository implements NpkRepositoryPort {
  constructor(private readonly connection: DatabaseService) {}

  async create(
    projectId: string,
    runId: string,
    id: string,
    input: CreateInventoryInput,
  ): Promise<InventoryView> {
    const createdAt = new Date();
    return this.connection.database.transaction(async (transaction) => {
      await transaction.insert(npkInventories).values({
        id,
        projectId,
        runId,
        sourceLabel: input.sourceLabel,
        sourceLength: input.sourceLength,
        sourceSha256: input.sourceSha256.toUpperCase(),
        entryCount: input.entries.length,
        status: "frozen",
        createdAt,
        ...(input.inventoryArtifactId
          ? { inventoryArtifactId: input.inventoryArtifactId }
          : {}),
      });
      await transaction.insert(npkInventoryEntries).values(
        input.entries.map((entry) => ({
          id: randomUUID(),
          inventoryId: id,
          internalPath: normalizeNpkInternalPath(entry.internalPath),
          imgVersion: entry.imgVersion,
          frameCount: entry.frameCount,
          metadataSha256: entry.metadataSha256.toUpperCase(),
        })),
      );
      return toInventoryView({
        id,
        projectId,
        runId,
        sourceLabel: input.sourceLabel,
        sourceLength: input.sourceLength,
        sourceSha256: input.sourceSha256.toUpperCase(),
        entryCount: input.entries.length,
        status: "frozen",
        inventoryArtifactId: input.inventoryArtifactId ?? null,
        createdAt,
      });
    });
  }

  async list(projectId: string): Promise<InventoryView[]> {
    const rows = await this.connection.database
      .select()
      .from(npkInventories)
      .where(eq(npkInventories.projectId, projectId))
      .orderBy(desc(npkInventories.createdAt));
    return rows.map(toInventoryView);
  }

  async findEntryEvidence(
    inventoryId: string,
    entryId: string,
  ): Promise<InventoryEntryEvidence | undefined> {
    const [row] = await this.connection.database
      .select({
        id: npkInventoryEntries.id,
        inventoryId: npkInventoryEntries.inventoryId,
        projectId: npkInventories.projectId,
        runId: npkInventories.runId,
        metadataSha256: npkInventoryEntries.metadataSha256,
      })
      .from(npkInventoryEntries)
      .innerJoin(
        npkInventories,
        eq(npkInventories.id, npkInventoryEntries.inventoryId),
      )
      .where(
        and(
          eq(npkInventoryEntries.inventoryId, inventoryId),
          eq(npkInventoryEntries.id, entryId),
        ),
      )
      .limit(1);
    return row;
  }
}

function toInventoryView(
  row: typeof npkInventories.$inferSelect,
): InventoryView {
  return {
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    sourceLabel: row.sourceLabel,
    sourceLength: row.sourceLength,
    sourceSha256: row.sourceSha256,
    status: "frozen",
    ...(row.inventoryArtifactId
      ? { inventoryArtifactId: row.inventoryArtifactId }
      : {}),
    entryCount: row.entryCount,
    createdAtUtc: row.createdAt.toISOString(),
  };
}
