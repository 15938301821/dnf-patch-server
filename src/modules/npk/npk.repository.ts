/**
 * @fileoverview 持久化和查询冻结 NPK Inventory/条目元数据，并在 Worker 回填时以同一事务验证 Job、Run、
 * 数据库时间 lease、attempt 与 finalized Artifact；不读取 NPK/IMG 字节、不解析条目或执行本机工具。
 * @module modules/npk/repository
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：NpkService 使用 NpkRepositoryPort 调用本类；普通创建经 create 写入两张 Inventory 表，
 * Worker 创建经 createFromWorker 锁定 jobs/runs/upload session 后再写入；职业和资源导入链路通过 Service
 * 查询 ViewModel/最小条目证据。
 * 输入输出：输入是 Service 已校验的 Project/Run/id/DTO 或 Worker jobId；输出是 ViewModel、条目证据、
 * undefined 或有限 Worker 状态，不返回原始数据库行、NPK 字节、对象 URL、Worker token 或路径权限。
 * 副作用：create/createFromWorker 在事务中插入 npkInventories 和 npkInventoryEntries；Worker 回填会取得
 * Job、Run、会话和已有 Inventory 的行锁。查询方法只读。
 * 安全边界：Worker 回填只接受数据库时钟下有效的精确 lease、`inventory` kind、同 Job/Run/worker/lease/
 * attempt 的 finalized Artifact；同一 Run+Artifact 重报返回旧记录。Repository 只检查绑定元数据，
 * 不从 Artifact 内容重新证明条目、来源哈希或资源映射。
 */
import { Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { hasExactJobLease } from "../../common/contracts/index.js";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  artifacts,
  jobs,
  npkInventories,
  npkInventoryEntries,
  runs,
} from "../../common/db/schema.js";
import {
  normalizeNpkInternalPath,
  type CreateInventoryInput,
  type CreateWorkerInventoryInput,
  type InventoryEntryEvidence,
  type InventoryView,
  type WorkerInventoryMutationResult,
} from "./npk.contracts.js";

/**
 * NpkService 依赖的数据访问契约，便于业务测试替换持久化层而不泄露 Drizzle 实现。
 * 各查询仅返回脱敏 ViewModel/证据；undefined 必须由 Service 或调用方按业务语义处理，不能猜测默认数据。
 */
export interface NpkRepositoryPort {
  /** 在普通创建路径原子写入一个 Inventory 和全部条目。 */
  create(
    projectId: string,
    runId: string,
    id: string,
    input: CreateInventoryInput,
  ): Promise<InventoryView>;
  /** 以数据库时钟、锁定 Job 和 finalized Artifact 验证 Worker 回填，返回可映射的有限状态。 */
  createFromWorker(
    jobId: string,
    id: string,
    input: CreateWorkerInventoryInput,
  ): Promise<WorkerInventoryMutationResult>;
  /** 查询 Project 下所有 Inventory，不隐式筛选 frozen 状态。 */
  list(projectId: string): Promise<InventoryView[]>;
  /** 查询 Project 最近一条 frozen Inventory；无记录时返回 undefined。 */
  findLatest(projectId: string): Promise<InventoryView | undefined>;
  /** 查询指定 Project+Run 的最近一条 frozen Inventory；归属不匹配时返回 undefined。 */
  findByRun(
    projectId: string,
    runId: string,
  ): Promise<InventoryView | undefined>;
  /** 查询指定 Inventory 下条目的最小归属/摘要证据，不返回资源正文。 */
  findEntryEvidence(
    inventoryId: string,
    entryId: string,
  ): Promise<InventoryEntryEvidence | undefined>;
}

@Injectable()
/** NPK 元数据的数据访问实现，Controller 不应绕过 Service 直接使用此类。 */
export class NpkRepository implements NpkRepositoryPort {
  /** @param connection 应用生命周期管理的 Drizzle 连接，提供事务、行锁与数据库时间。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 在一个事务内插入普通入口提交的 Inventory 和所有条目。
   * @param projectId 已由 Service 与请求 path 绑定的 Project 标识。
   * @param runId Service 已验证属于 projectId 的 producing Run。
   * @param id Service 生成的 Inventory 主键。
   * @param input 严格 DTO；可选 Artifact 的存在与归属已由 Service 验证。
   * @returns 新的 InventoryView；不证明输入条目来自实际 NPK 解析。
   */
  async create(
    projectId: string,
    runId: string,
    id: string,
    input: CreateInventoryInput,
  ): Promise<InventoryView> {
    const createdAt = new Date();
    return this.connection.database.transaction((transaction) =>
      insertInventory(transaction, projectId, runId, id, input, createdAt),
    );
  }

  /**
   * 在同一事务中验证 Worker 回填并冻结 Inventory。
   *
   * 步骤 1：锁定 Job 并读取数据库 CURRENT_TIMESTAMP(3)，以权威时间验证 workerId/leaseId/attempt；
   * 步骤 2：只接受 `inventory` Job kind，锁定其 Run 以取得不可伪造的 projectId；步骤 3：锁定并确认
   * 同一 Job/Run/Worker/lease/attempt 的上传会话和 Artifact 均已 finalized；步骤 4：查询同一 Run+Artifact
   * 的旧记录实现幂等；步骤 5：仅在没有旧记录时写入 Inventory 和条目。任一拒绝分支不会写入新记录。
   *
   * @param jobId 内部 Worker 路由 path 中的 Job 标识，不能由 input 替代。
   * @param id 本次新建候选 Inventory 的服务器 UUID；幂等命中时不会使用它。
   * @param input Worker DTO，所有 lease/attempt/Artifact 字段都必须与锁定数据库状态精确匹配。
   * @returns accepted（含幂等旧记录）或有限拒绝状态，交由 Service 映射为稳定 HTTP 错误。
   * @sideEffect 对 Job、Run、上传会话和已有 Inventory 获取 `FOR UPDATE`；accepted 新建时插入两张表。
   */
  async createFromWorker(
    jobId: string,
    id: string,
    input: CreateWorkerInventoryInput,
  ): Promise<WorkerInventoryMutationResult> {
    return this.connection.database.transaction(async (transaction) => {
      const [job] = await transaction
        .select({
          runId: jobs.runId,
          kind: jobs.kind,
          status: jobs.status,
          leaseOwnerId: jobs.leaseOwnerId,
          leaseId: jobs.leaseId,
          leaseExpiresAt: jobs.leaseExpiresAt,
          attemptCount: jobs.attemptCount,
          now: sql<Date | string>`CURRENT_TIMESTAMP(3)`,
        })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
        .for("update");
      if (!job) return { status: "lease-mismatch" };
      const now = dateValue(job.now);
      if (!hasExactJobLease(job, input, now)) {
        return { status: "lease-mismatch" };
      }
      if (job.kind !== "inventory") {
        return { status: "job-kind-mismatch" };
      }

      const [run] = await transaction
        .select({ projectId: runs.projectId })
        .from(runs)
        .where(eq(runs.id, job.runId))
        .limit(1)
        .for("update");
      if (!run) throw new Error("INVENTORY_RUN_INVARIANT_FAILED");

      const [upload] = await transaction
        .select({
          artifactId: artifacts.id,
          finalizedAt: artifactUploadSessions.finalizedAt,
        })
        .from(artifactUploadSessions)
        .innerJoin(
          artifacts,
          and(
            eq(artifacts.runId, artifactUploadSessions.runId),
            eq(artifacts.id, artifactUploadSessions.artifactId),
          ),
        )
        .where(
          and(
            eq(artifactUploadSessions.runId, job.runId),
            eq(artifactUploadSessions.jobId, jobId),
            eq(artifactUploadSessions.workerId, input.workerId),
            eq(artifactUploadSessions.leaseId, input.leaseId),
            eq(artifactUploadSessions.attempt, input.attempt),
            eq(artifactUploadSessions.artifactId, input.inventoryArtifactId),
            eq(artifactUploadSessions.status, "finalized"),
          ),
        )
        .limit(1)
        .for("update");
      if (!upload || upload.finalizedAt === null) {
        return { status: "artifact-not-finalized" };
      }

      const [existing] = await transaction
        .select()
        .from(npkInventories)
        .where(
          and(
            eq(npkInventories.runId, job.runId),
            eq(npkInventories.inventoryArtifactId, input.inventoryArtifactId),
          ),
        )
        .limit(1)
        .for("update");
      if (existing) {
        return { status: "accepted", inventory: toInventoryView(existing) };
      }

      const inventory = await insertInventory(
        transaction,
        run.projectId,
        job.runId,
        id,
        input,
        now,
      );
      return { status: "accepted", inventory };
    });
  }

  /**
   * 查询一个 Project 的全部 Inventory。
   * @param projectId Project 标识；本方法不执行用户所有权检查或 frozen 状态过滤。
   * @returns 按创建时间倒序的脱敏 InventoryView 列表。
   */
  async list(projectId: string): Promise<InventoryView[]> {
    const rows = await this.connection.database
      .select()
      .from(npkInventories)
      .where(eq(npkInventories.projectId, projectId))
      .orderBy(desc(npkInventories.createdAt));
    return rows.map(toInventoryView);
  }

  /**
   * 查询 Project 最近一条 frozen Inventory，供展示和冻结证据链消费。
   * @param projectId Project 标识。
   * @returns 最近 frozen View 或 undefined；undefined 不能被解释为可以使用任意来源文件。
   */
  async findLatest(projectId: string): Promise<InventoryView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(npkInventories)
      .where(
        and(
          eq(npkInventories.projectId, projectId),
          eq(npkInventories.status, "frozen"),
        ),
      )
      .orderBy(desc(npkInventories.createdAt))
      .limit(1);
    return row ? toInventoryView(row) : undefined;
  }

  /**
   * 查询指定 Project 与 producing Run 的最近 frozen Inventory。
   * @param projectId Project 归属边界。
   * @param runId producing Run 标识。
   * @returns 匹配归属且 frozen 的 View，否则 undefined。
   */
  async findByRun(
    projectId: string,
    runId: string,
  ): Promise<InventoryView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(npkInventories)
      .where(
        and(
          eq(npkInventories.projectId, projectId),
          eq(npkInventories.runId, runId),
          eq(npkInventories.status, "frozen"),
        ),
      )
      .orderBy(desc(npkInventories.createdAt))
      .limit(1);
    return row ? toInventoryView(row) : undefined;
  }

  /**
   * 取得指定条目的最小归属和摘要证据。
   * @param inventoryId 已冻结 Inventory 标识。
   * @param entryId 条目标识；必须属于 inventoryId。
   * @returns InventoryEntryEvidence 或 undefined；调用方仍需比较 projectId/runId/metadataSha256。
   */
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

/** Drizzle 事务回调类型，保证父 Inventory 与全部条目在同一提交/回滚边界内。 */
type NpkTransaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

/**
 * 在当前事务内写入父 Inventory 和全部条目。
 * @param transaction 同一数据库事务；任一插入失败时父/子记录应一起回滚。
 * @param projectId 已验证 Project 归属。
 * @param runId 已验证 producing Run 归属。
 * @param id 服务端生成的 Inventory id。
 * @param input 普通或 Worker 已解析 DTO；Worker 绑定在调用本函数前已经验证。
 * @param createdAt 普通路径的服务时间或 Worker 路径的数据库时间，用于一致性写入。
 * @returns 新的 InventoryView；不会重新解析 Artifact/NPK 内容。
 * @sideEffect 插入 npkInventories 与 npkInventoryEntries，路径/摘要在写入边界再次规范化。
 */
async function insertInventory(
  transaction: NpkTransaction,
  projectId: string,
  runId: string,
  id: string,
  input: CreateInventoryInput | CreateWorkerInventoryInput,
  createdAt: Date,
): Promise<InventoryView> {
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
}

/**
 * 将 Inventory 数据库行映射为公开摘要。
 * @param row 已查询或刚构造的 Inventory 行形状。
 * @returns 不含内部对象位置、条目正文或 Worker lease 的 InventoryView。
 * @remarks status 硬编码为 frozen，依赖本仓储当前唯一写入路径始终保存 frozen；不能据此推断数据库没有被绕过。
 */
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

/**
 * 将 MySQL 返回的 Date/字符串时间转换为可比较值。
 * @param value 当前事务查询的数据库时间，不能换成 Worker 或服务进程本机时间。
 * @returns Date，用于 exact lease 时效判断。
 */
function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
