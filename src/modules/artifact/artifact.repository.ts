import { Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { artifacts } from "../../common/db/schema.js";
import type {
  ArtifactView,
  CreateArtifactInput,
} from "./artifact.contracts.js";
import { artifactProvenanceSchema } from "./artifact.contracts.js";

@Injectable()
export class ArtifactRepository {
  constructor(private readonly connection: DatabaseService) {}

  async findRunId(id: string): Promise<string | undefined> {
    const [row] = await this.connection.database
      .select({ runId: artifacts.runId })
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .limit(1);
    return row?.runId;
  }

  async create(
    runId: string,
    id: string,
    input: CreateArtifactInput,
  ): Promise<ArtifactView> {
    const createdAt = new Date();
    const normalized = { ...input, sha256: input.sha256.toUpperCase() };
    await this.connection.database.insert(artifacts).values({
      id,
      runId,
      ...normalized,
      createdAt,
    });
    return { id, runId, ...normalized, createdAtUtc: createdAt.toISOString() };
  }

  async listByRun(runId: string): Promise<ArtifactView[]> {
    const rows = await this.connection.database
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(asc(artifacts.createdAt));
    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      logicalName: row.logicalName,
      storageKey: row.storageKey,
      mediaType: row.mediaType,
      byteLength: row.byteLength,
      sha256: row.sha256,
      provenance: artifactProvenanceSchema.parse(row.provenance),
      createdAtUtc: row.createdAt.toISOString(),
    }));
  }
}
