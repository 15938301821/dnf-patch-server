/**
 * @fileoverview 持久化 Project 与 Project Snapshot 的单表记录，并将数据库行映射为公开 ViewModel；
 * 不验证 Factory、规范化名称、HTTP DTO、用户授权、Run 状态或 Worker 能力。
 * @module modules/project/repository
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：ProjectService 在完成领域校验后调用本类；本类通过 DatabaseService 的 Drizzle 连接读写
 * projects 与 projectSnapshots 表；RunService 可通过 ProjectService 读取返回的 ViewModel。
 * 输入输出：输入是 Service 已校验的 id、创建 DTO 和服务器生成 id/规范名；输出是 ViewModel 或 undefined，
 * 不返回原始 Drizzle 行、规则正文、Prompt、对象路径或游戏资源。
 * 副作用：list/find 方法只读数据库；create/createSnapshot 插入单条记录。当前操作不创建 Run、Job、
 * Artifact、outbox 或对象存储内容。
 * 安全边界：Snapshot 的 immutable safety state 读取时重新通过 schema 解析，并且写入时强制
 * fullSkillCoverageProven=false；Repository 不信任调用方用 ViewModel 绕过这一不变量。
 */
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
/** Project/Snapshot 数据访问边界；Controller 不应绕过 Service 直接注入。 */
export class ProjectRepository {
  /** @param connection 应用生命周期管理的 Drizzle 数据库连接。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 查询全部 Project。
   * @returns 按最后更新时间倒序的 ProjectView；不包含 Snapshot 列表或授权范围。
   */
  async list(): Promise<ProjectView[]> {
    const rows = await this.connection.database
      .select()
      .from(projects)
      .orderBy(desc(projects.updatedAt));
    return rows.map(toProjectView);
  }

  /**
   * 根据服务器 id 查询 Project。
   * @param id 已由上游 schema 校验的 Project 标识。
   * @returns 找到时的 ProjectView，否则 undefined，由 Service 生成稳定业务错误。
   */
  async findById(id: string): Promise<ProjectView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    return row ? toProjectView(row) : undefined;
  }

  /**
   * 按规范化显示名称查询唯一性冲突。
   * @param name canonicalName 生成的稳定比较键，不应传入未规范化的浏览器显示名称。
   * @returns 已存在的 ProjectView 或 undefined；调用方用它阻止同名 Project 创建。
   */
  async findByCanonicalName(name: string): Promise<ProjectView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(projects)
      .where(eq(projects.canonicalName, name))
      .limit(1);
    return row ? toProjectView(row) : undefined;
  }

  /**
   * 读取属于指定 Project 的单个 Snapshot。
   * @param projectId 当前 Project 标识，用于防止独立 snapshot id 跨 Project 泄露。
   * @param snapshotId 服务器生成的 Snapshot 标识。
   * @returns 匹配归属时的 Snapshot ViewModel，否则 undefined。
   */
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

  /**
   * 保存 Service 已验证的 Project。
   * @param input 浏览器 DTO，Factory 已由 Service 验证，clientProjectId 保留为可选外部关联。
   * @param id Service 生成的服务器主键。
   * @param canonicalName Service 从 displayName 派生的唯一性比较键。
   * @returns 新 ProjectView；不创建 Snapshot 或 Run。
   */
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

  /**
   * 保存 Project 的事实源摘要 Snapshot。
   * @param projectId 已确认存在的 Project 标识。
   * @param input 已按 Snapshot DTO 校验的摘要；不携带源码或实际资源。
   * @param id Service 生成的 Snapshot 主键。
   * @returns 新的 ProjectSnapshotView，其中安全状态被强制保持 false。
   */
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

/**
 * 将 projects 数据库行转换为无数据库类型的公开 ViewModel。
 * @param row 已查询的 projects 行。
 * @returns ProjectView；不会添加 Snapshot 或推断用户访问授权。
 */
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

/**
 * 将 Snapshot 数据库行映射为公开摘要，并重新校验不可提升的安全状态。
 * @param row 已查询的 project_snapshots 行。
 * @returns ProjectSnapshotView；摘要存在不表示对应开发期文件可用或经过部署验证。
 * @throws 当数据库中 fullSkillCoverageProven 违反 immutable safety schema 时抛出。
 */
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
