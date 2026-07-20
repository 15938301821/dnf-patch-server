import { Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { projectSnapshots, projects } from "../../common/db/schema.js";
import type {
  CreateProjectInput,
  CreateProjectSnapshotInput,
  ProjectSnapshotView,
  ProjectView,
} from "./project.contracts.js";

@Injectable()
export class ProjectRepository {
  constructor(private readonly connection: DatabaseService) {}

  async list(): Promise<ProjectView[]> {
    const rows = await this.connection.database
      .select()
      .from(projects)
      .orderBy(desc(projects.updatedAt));
    return rows.map(toProjectView);
  }

  async findById(id: string): Promise<ProjectView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    return row ? toProjectView(row) : undefined;
  }

  async findByCanonicalName(name: string): Promise<ProjectView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(projects)
      .where(eq(projects.canonicalName, name))
      .limit(1);
    return row ? toProjectView(row) : undefined;
  }

  async create(
    input: CreateProjectInput,
    id: string,
    canonicalName: string,
  ): Promise<ProjectView> {
    const now = new Date();
    await this.connection.database.insert(projects).values({
      id,
      factoryId: input.factoryId,
      displayName: input.displayName,
      canonicalName,
      version: 1,
      archived: false,
      createdAt: now,
      updatedAt: now,
      ...(input.clientProjectId
        ? { clientProjectId: input.clientProjectId }
        : {}),
    });
    return {
      id,
      factoryId: input.factoryId,
      ...(input.clientProjectId
        ? { clientProjectId: input.clientProjectId }
        : {}),
      displayName: input.displayName,
      canonicalName,
      version: 1,
      archived: false,
      createdAtUtc: now.toISOString(),
      updatedAtUtc: now.toISOString(),
    };
  }

  async createSnapshot(
    projectId: string,
    input: CreateProjectSnapshotInput,
    id: string,
  ): Promise<ProjectSnapshotView> {
    const createdAt = new Date();
    await this.connection.database.insert(projectSnapshots).values({
      id,
      projectId,
      clientSnapshotId: input.clientSnapshotId,
      rootRulesSha256: input.rootRulesSha256.toUpperCase(),
      promptTreeSha256: input.promptTreeSha256.toUpperCase(),
      toolCatalogSha256: input.toolCatalogSha256.toUpperCase(),
      fullSkillCoverageProven: false,
      createdAt,
      ...(input.manifestSha256
        ? { manifestSha256: input.manifestSha256.toUpperCase() }
        : {}),
      ...(input.repositoryRevision
        ? { repositoryRevision: input.repositoryRevision }
        : {}),
    });
    return {
      id,
      projectId,
      ...input,
      rootRulesSha256: input.rootRulesSha256.toUpperCase(),
      promptTreeSha256: input.promptTreeSha256.toUpperCase(),
      toolCatalogSha256: input.toolCatalogSha256.toUpperCase(),
      ...(input.manifestSha256
        ? { manifestSha256: input.manifestSha256.toUpperCase() }
        : {}),
      fullSkillCoverageProven: false,
      createdAtUtc: createdAt.toISOString(),
    };
  }
}

function toProjectView(row: typeof projects.$inferSelect): ProjectView {
  return {
    id: row.id,
    factoryId: row.factoryId,
    ...(row.clientProjectId ? { clientProjectId: row.clientProjectId } : {}),
    displayName: row.displayName,
    canonicalName: row.canonicalName,
    version: row.version,
    archived: row.archived,
    createdAtUtc: row.createdAt.toISOString(),
    updatedAtUtc: row.updatedAt.toISOString(),
  };
}
