/**
 * @fileoverview 编排 Project/Project Snapshot 的读取、Factory 关联验证、规范化名称唯一性和稳定错误；
 * 不处理 HTTP DTO、直接 Drizzle 查询、Run/Job 创建或 Worker 执行。
 * @module modules/project/service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：ProjectController 和 Run 等领域 Service 调用本类；本类委托 FactoryService 读取关联
 * Factory，委托 ProjectRepository 持久化 Project/Snapshot。
 * 输入输出：输入是 Controller 已校验的 id 或 DTO；输出是公开 ViewModel 或稳定 NotFound/Conflict 错误，
 * 不输出数据库行、规则正文、Worker 能力或可执行计划。
 * 副作用：读取方法只访问数据库；create/createSnapshot 分别插入一条 Project/Snapshot。它们不创建 Run、
 * Job、Artifact、事件或 outbox。
 * 安全边界：创建 Project 前必须存在 Factory，显示名称以 canonicalName 检查唯一性；创建 Snapshot 前必须
 * 存在 Project，且输入不能提升 fullSkillCoverageProven。当前模块不替代跨用户所有权或部署授权验证。
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { canonicalName } from "../../common/utils/canonical.js";
import { FactoryService } from "../factory/factory.service.js";
import type {
  CreateProjectInput,
  CreateProjectSnapshotInput,
  ProjectSnapshotView,
  ProjectView,
} from "./project.contracts.js";
import { ProjectRepository } from "./project.repository.js";

@Injectable()
/** Project 领域业务层，向 Controller 隐藏 Factory 依赖、规范化与 Repository 细节。 */
export class ProjectService {
  /**
   * @param projects Project/Snapshot 数据访问边界。
   * @param factories Factory 公开 Service，用于验证 Project 外键的业务可用性。
   */
  constructor(
    private readonly projects: ProjectRepository,
    private readonly factories: FactoryService,
  ) {}

  /**
   * 列出当前 Project。
   * @returns 按 Repository 排序的 ProjectView；不证明每个项目已有可用 Snapshot 或 Worker。
   */
  list(): Promise<ProjectView[]> {
    return this.projects.list();
  }

  /**
   * 读取一个 Project，不存在时提供稳定业务错误。
   * @param id 已校验的服务器 Project 标识。
   * @returns ProjectView。
   * @throws PROJECT_NOT_FOUND 当数据库中不存在该 id 时抛出。
   */
  async get(id: string): Promise<ProjectView> {
    const project = await this.projects.findById(id);
    if (!project) {
      throw new NotFoundException({
        code: "PROJECT_NOT_FOUND",
        message: "项目不存在。",
      });
    }
    return project;
  }

  /**
   * 验证关联 Factory 与规范化名称后创建 Project。
   *
   * 步骤 1：通过 FactoryService 确认 factoryId 存在；步骤 2：从 displayName 计算 canonicalName 并检查
   * 冲突；步骤 3：生成服务器 UUID 后委托 Repository 插入。任何步骤失败都不应创建 Project/Snapshot/Run。
   *
   * @param input 已由 Controller 严格解析的 Project DTO。
   * @returns 新建 ProjectView。
   * @throws FACTORY_NOT_FOUND 或 PROJECT_NAME_CONFLICT 当关联或唯一性不成立时抛出。
   */
  async create(input: CreateProjectInput): Promise<ProjectView> {
    await this.factories.get(input.factoryId);
    const normalized = canonicalName(input.displayName);
    if (await this.projects.findByCanonicalName(normalized)) {
      throw new ConflictException({
        code: "PROJECT_NAME_CONFLICT",
        message: "规范化后的项目名称已存在。",
      });
    }
    return this.projects.create(input, randomUUID(), normalized);
  }

  /**
   * 为已有 Project 保存规则/manifest/prompt/tool 的摘要快照。
   * @param projectId 已校验的 Project 标识；先经 get 确认存在。
   * @param input 已校验的摘要 DTO，不能包含或替代实际开发期资源。
   * @returns 新的 ProjectSnapshotView，安全状态固定为 false。
   * @throws PROJECT_NOT_FOUND 当 Project 不存在时抛出，且不写入孤立 Snapshot。
   */
  async createSnapshot(
    projectId: string,
    input: CreateProjectSnapshotInput,
  ): Promise<ProjectSnapshotView> {
    await this.get(projectId);
    return this.projects.createSnapshot(projectId, input, randomUUID());
  }

  /**
   * 读取属于当前 Project 的 Snapshot。
   * @param projectId 作为归属边界的 Project 标识。
   * @param snapshotId 服务器 Snapshot 标识。
   * @returns 匹配归属的 ProjectSnapshotView。
   * @throws PROJECT_SNAPSHOT_NOT_FOUND 当 Snapshot 不存在或属于不同 Project 时抛出，避免跨项目引用。
   */
  async getSnapshot(
    projectId: string,
    snapshotId: string,
  ): Promise<ProjectSnapshotView> {
    const snapshot = await this.projects.findSnapshotById(
      projectId,
      snapshotId,
    );
    if (!snapshot) {
      throw new NotFoundException({
        code: "PROJECT_SNAPSHOT_NOT_FOUND",
        message: "项目快照不存在或不属于当前项目。",
      });
    }
    return snapshot;
  }
}
