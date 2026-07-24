/**
 * @fileoverview 编排普通 Inventory 冻结、Worker 回填、证据查询及 Run/Artifact 归属校验；不解析 NPK/IMG、
 * 不访问游戏目录、不调用对象存储或执行 Worker 工具。
 * @module modules/npk/service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：NpkController 调用 create/list，NpkWorkerController 调用 createFromWorker；资源导入和职业
 * 链路调用 findLatest/findByRun/getEntryEvidence。Service 通过公开 RunService/ArtifactService 验证普通路径，
 * 通过 NpkRepository 的事务路径验证 Worker lease 和 finalized Artifact。
 * 输入输出：输入是已解析 DTO、Project/Job/Inventory/Entry id；输出是脱敏 Inventory/证据 ViewModel 或稳定
 * NotFound/Conflict 错误，不返回 NPK 字节、对象 URL、游戏路径、Worker token 或本机命令。
 * 副作用：普通 create 可能插入 Inventory/条目；Worker createFromWorker 可能在受限事务内冻结同一数据；
 * 其他方法只读。该 Service 不创建 Job、租约、Artifact 或 outbox。
 * 安全边界：普通路径校验 Run 与可选 Artifact 的归属，但当前不接收稳定用户身份，不能将它描述为项目级
 * 用户所有权校验。Worker token 认证也不等于 Job 归属，精确 lease/attempt/finalized Artifact 由 Repository
 * 以数据库时间确认；所有路径都用同一规范化规则拒绝重复内部路径。
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ArtifactService } from "../artifact/artifact.service.js";
import { RunService } from "../run/run.service.js";
import {
  normalizeNpkInternalPath,
  type CreateInventoryInput,
  type CreateWorkerInventoryInput,
  type InventoryEntryEvidence,
  type InventoryView,
} from "./npk.contracts.js";
import { NpkRepository, type NpkRepositoryPort } from "./npk.repository.js";

/** 供 NPK Service 注入的最小 Run 查询接口，避免跨模块依赖 RunRepository。 */
interface RunLookupPort {
  get(id: string): ReturnType<RunService["get"]>;
}

/** 供普通创建路径确认可选 Artifact 归属的最小接口，不暴露对象存储或 Artifact 写入能力。 */
interface ArtifactLookupPort {
  findRunId(id: string): Promise<string | undefined>;
}

@Injectable()
/** NPK Inventory 领域业务层，向两类 Controller 隐藏跨模块查询与 Repository 事务细节。 */
export class NpkService {
  /**
   * @param inventories NPK 持久化端口，Worker 路径的 lease/Artifact 验证发生在其事务内。
   * @param runs 公开 Run 查询接口，用于普通路径验证 Project 归属。
   * @param artifacts 公开 Artifact 查询接口，用于普通路径验证可选来源 Artifact 的 Run 归属。
   */
  constructor(
    @Inject(NpkRepository)
    private readonly inventories: NpkRepositoryPort,
    @Inject(RunService) private readonly runs: RunLookupPort,
    @Inject(ArtifactService) private readonly artifacts: ArtifactLookupPort,
  ) {}

  /**
   * 冻结普通业务入口提交的 Inventory 元数据。
   *
   * 步骤 1：读取 producing Run 并验证它属于 path 的 Project；步骤 2：若声明来源 Artifact，验证其存在且
   * 属于同一 Run；步骤 3：使用规范化路径拒绝同一请求内的重复条目；步骤 4：生成服务器 UUID 并委托
   * Repository 原子写入。任何失败都不会创建父/子记录。
   *
   * @param projectId URL 中已校验的 Project 标识。
   * @param input 经过严格 schema 解析的 Inventory DTO。
   * @returns 新 InventoryView；成功不代表服务器已从 NPK 正文复算条目/来源哈希或完成客户端兼容验证。
   * @throws INVENTORY_RUN_PROJECT_MISMATCH、INVENTORY_ARTIFACT_NOT_FOUND、INVENTORY_ARTIFACT_RUN_MISMATCH
   * 或 INVENTORY_PATH_CONFLICT 当归属/去重不变量不成立时抛出。
   */
  async create(
    projectId: string,
    input: CreateInventoryInput,
  ): Promise<InventoryView> {
    const run = await this.runs.get(input.runId);
    if (run.projectId !== projectId) {
      throw new ConflictException({
        code: "INVENTORY_RUN_PROJECT_MISMATCH",
        message: "Inventory 的 producing Run 不属于目标项目。",
      });
    }
    if (input.inventoryArtifactId) {
      const artifactRunId = await this.artifacts.findRunId(
        input.inventoryArtifactId,
      );
      if (!artifactRunId) {
        throw new NotFoundException({
          code: "INVENTORY_ARTIFACT_NOT_FOUND",
          message: "Inventory 引用的来源 Artifact 不存在。",
        });
      }
      if (artifactRunId !== input.runId) {
        throw new ConflictException({
          code: "INVENTORY_ARTIFACT_RUN_MISMATCH",
          message: "Inventory 引用的来源 Artifact 不属于 producing Run。",
        });
      }
    }
    assertUniquePaths(input);
    return this.inventories.create(projectId, input.runId, randomUUID(), input);
  }

  /**
   * 在 Worker 当前精确 lease 下，把同 Job 已 finalized 的 Artifact 关联为冻结 Inventory。
   * @param jobId 内部路由 path 的 Job 标识，不从 Worker body 接收 runId 以防伪造归属。
   * @param input 已解析 Worker DTO；Repository 必须继续用数据库时间、锁定 Job 和上传会话验证所有绑定字段。
   * @returns accepted 或幂等命中的 InventoryView；不代表 Artifact 内容被 NPK 模块重新解析。
   * @throws INVENTORY_JOB_REQUIRED、INVENTORY_ARTIFACT_REQUIRED 或 JOB_LEASE_MISMATCH，当证据不足时
   * fail-closed 且不会创建新 Inventory。
   */
  async createFromWorker(
    jobId: string,
    input: CreateWorkerInventoryInput,
  ): Promise<InventoryView> {
    assertUniquePaths(input);
    const result = await this.inventories.createFromWorker(
      jobId,
      randomUUID(),
      input,
    );
    if (result.status === "accepted") return result.inventory;
    if (result.status === "job-kind-mismatch") {
      throw new ConflictException({
        code: "INVENTORY_JOB_REQUIRED",
        message: "当前 Job 不接受 Inventory 回填。",
      });
    }
    if (result.status === "artifact-not-finalized") {
      throw new ConflictException({
        code: "INVENTORY_ARTIFACT_REQUIRED",
        message: "Inventory 必须绑定当前租约已 finalize 的同 Job Artifact。",
      });
    }
    if (result.status === "artifact-evidence-mismatch") {
      throw new ConflictException({
        code: "INVENTORY_ARTIFACT_EVIDENCE_MISMATCH",
        message: "Inventory Artifact 的角色或来源证据不匹配。",
      });
    }
    throw new ConflictException({
      code: "JOB_LEASE_MISMATCH",
      message: "任务租约不存在、已过期或不属于当前 Worker。",
    });
  }

  /**
   * 列出 Project 下已保存的 Inventory。
   * @param projectId Project 标识；当前方法不实现跨用户所有权过滤。
   * @returns Repository 排序的 View 列表，空数组不代表可改用未导入的官方资源。
   */
  list(projectId: string): Promise<InventoryView[]> {
    return this.inventories.list(projectId);
  }

  /**
   * 查询 Project 最近的 frozen Inventory，用于展示和后续事实引用。
   * @param projectId Project 标识。
   * @returns 最近 frozen View 或 undefined；它只表示已保存的元数据，不证明资源正文仍可读取。
   */
  findLatest(projectId: string): Promise<InventoryView | undefined> {
    return this.inventories.findLatest(projectId);
  }

  /**
   * 查询指定 producing Run 的 frozen Inventory 元数据。
   * @param projectId Project 归属边界。
   * @param runId producing Run 标识。
   * @returns 匹配归属的 View 或 undefined，不返回 NPK/IMG 正文。
   */
  findByRun(
    projectId: string,
    runId: string,
  ): Promise<InventoryView | undefined> {
    return this.inventories.findByRun(projectId, runId);
  }

  /**
   * 按 ID 查询 frozen Inventory 摘要，供跨模块核对整个 Inventory 的条目数量和证据身份。
   * @throws INVENTORY_NOT_FOUND 当记录不存在或未处于 frozen 状态。
   */
  async getById(inventoryId: string): Promise<InventoryView> {
    const inventory = await this.inventories.findById(inventoryId);
    if (!inventory) {
      throw new NotFoundException({
        code: "INVENTORY_NOT_FOUND",
        message: "冻结 Inventory 不存在。",
      });
    }
    return inventory;
  }

  /**
   * 提供冻结 Inventory Entry 的最小归属证据。
   * @param inventoryId Inventory 标识。
   * @param entryId 需要验证的条目标识。
   * @returns 含 Project/Run/metadata SHA-256 的证据；调用方仍必须和自己的上下文比较。
   * @throws INVENTORY_ENTRY_NOT_FOUND 当条目不存在或不属于目标 Inventory 时抛出。
   */
  async getEntryEvidence(
    inventoryId: string,
    entryId: string,
  ): Promise<InventoryEntryEvidence> {
    const evidence = await this.inventories.findEntryEvidence(
      inventoryId,
      entryId,
    );
    if (!evidence) {
      throw new NotFoundException({
        code: "INVENTORY_ENTRY_NOT_FOUND",
        message: "Inventory Entry 不存在或不属于目标 Inventory。",
      });
    }
    return evidence;
  }
}

/**
 * 使用与 schema/Repository 相同的路径规范化规则拒绝单个请求内的重复条目。
 * @param input 普通或 Worker DTO 的 entries 子集。
 * @throws INVENTORY_PATH_CONFLICT 当大小写、反斜杠或 Unicode 等价后存在重复路径时抛出。
 * @remarks 这只检查本次输入；数据库唯一键仍是并发和绕过 Service 时的最终持久化防线。
 */
function assertUniquePaths(input: Pick<CreateInventoryInput, "entries">): void {
  const normalizedPaths = input.entries.map((entry) =>
    normalizeNpkInternalPath(entry.internalPath),
  );
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new ConflictException({
      code: "INVENTORY_PATH_CONFLICT",
      message: "Inventory 中存在重复的 NPK 内部路径。",
    });
  }
}
