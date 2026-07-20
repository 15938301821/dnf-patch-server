import { Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { immutableSafetyStateSchema } from "../../common/contracts/index.js";
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

  async findSnapshotById(
    projectId: string,
    snapshotId: string,
  ): Promise<ProjectSnapshotView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(projectSnapshots)
      .where(
        and(
          eq(projectSnapshots.projectId, projectId),
          eq(projectSnapshots.id, snapshotId),
        ),
      )
      .limit(1);
    return row ? toProjectSnapshotView(row) : undefined;
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

function toProjectSnapshotView(
  row: typeof projectSnapshots.$inferSelect,
): ProjectSnapshotView {
  const safetyState = immutableSafetyStateSchema.parse({
    fullSkillCoverageProven: row.fullSkillCoverageProven,
  });
  return {
    id: row.id,
    projectId: row.projectId,
    clientSnapshotId: row.clientSnapshotId,
    rootRulesSha256: row.rootRulesSha256,
    ...(row.manifestSha256 ? { manifestSha256: row.manifestSha256 } : {}),
    promptTreeSha256: row.promptTreeSha256,
    toolCatalogSha256: row.toolCatalogSha256,
    ...(row.repositoryRevision
      ? { repositoryRevision: row.repositoryRevision }
      : {}),
    fullSkillCoverageProven: safetyState.fullSkillCoverageProven,
    createdAtUtc: row.createdAt.toISOString(),
  };
}
