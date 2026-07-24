/**
 * @fileoverview 在当前 Profession Job 的数据库事务与行锁内还原单技能冻结 NPK/IMG 来源事实；
 * 不读取对象正文、不签发跨 Run 下载、不调用模型或本机工具。
 * @module modules/job/profession-source-context-repository
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：ProfessionSourceContextService 调用本 Repository；本类先锁定 Job，再读取数据库时间并
 * 复用冻结 payload/lease 解析器，随后联查 source Run 的 Inventory、清单 Artifact 与精确 Entry 集合。
 * 输入输出：输入为 path jobId 和四字段 lease DTO；输出为脱敏源 ViewModel 或有限拒绝状态。
 * 副作用：只读 transaction 会取得 Job row lock；不更新数据库、不访问对象存储、不产生模型出站。
 * 安全边界：Worker token 不能替代 lease fencing；payload、Inventory、Artifact provenance、Entry
 * 归属、顺序和摘要必须全部一致，任一漂移都 fail-closed 且不得返回部分路径集合。
 */
import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  artifacts,
  jobs,
  npkInventories,
  npkInventoryEntries,
} from "../../common/db/schema.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import {
  resolveProfessionExecutionContext,
  type ResolveProfessionExecutionContextResult,
} from "./profession-execution-context.js";
import {
  professionSkillSourceContextViewSchema,
  type ProfessionSkillSourceContextView,
} from "./profession-source-context.contracts.js";

const sourceFrameManifestProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("source-frame-manifest"),
    sourceSha256: sha256Schema,
    toolSha256: sha256Schema,
    jobPayloadSha256: sha256Schema,
    deploymentAuthorized: z.literal(false),
  })
  .strict();

type ProfessionExecutionGateFailure = Exclude<
  ResolveProfessionExecutionContextResult,
  { status: "accepted" }
>;

/** Repository 可返回的有限状态；证据不一致不区分具体数据库字段，避免通过 HTTP 泄露内部结构。 */
export type ResolveProfessionSkillSourceContextResult =
  | ProfessionExecutionGateFailure
  | { status: "source-evidence-mismatch" }
  | { status: "accepted"; context: ProfessionSkillSourceContextView };

@Injectable()
/** 冻结 Profession 技能源只读数据访问边界，拥有事务、Job 锁和多表一致性校验。 */
export class ProfessionSourceContextRepository {
  /** @param connection 服务进程共享的 Drizzle 连接；Controller 不得直接访问该基础设施。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 在当前 lease 仍有效时还原一个技能的精确来源集合。
   *
   * 锁顺序固定为 Job，后续 Inventory/Artifact/Entry 都是不可变证据读取；Job row lock 防止 heartbeat、
   * complete 或 reaper 在本次核验中途改变 lease。事务结束后 Worker 仍须持续 heartbeat，不能把本响应
   * 当作永久执行权。
   *
   * @param jobId 内部路由 path 已校验的 Profession Job UUID。
   * @param input 当前 claim 的 workerId、leaseId、attempt 与冻结 skillId。
   * @returns accepted 时只包含源摘要和 NPK 内部相对路径；其他状态不返回部分证据。
   */
  async resolveSkillSourceContext(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
  ): Promise<ResolveProfessionSkillSourceContextResult> {
    return this.connection.database.transaction(async (transaction) => {
      // 第一步：先锁定权威 Job，并用同一事务的数据库时间校验 lease 与冻结 payload。
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
        .for("update");
      if (!job) return { status: "lease-mismatch" };
      const now = await databaseNow(transaction);
      const gate = resolveProfessionExecutionContext(job, input, now);
      if (gate.status !== "accepted") return gate;
      const expected = gate.context.skill.sourceEvidence;

      // 第二步：Inventory 与源帧清单必须同属 payload 冻结的 source Run，且 Artifact 角色/来源哈希固定。
      const [source] = await transaction
        .select({
          runId: npkInventories.runId,
          inventoryId: npkInventories.id,
          sourceByteLength: npkInventories.sourceLength,
          sourceSha256: npkInventories.sourceSha256,
          manifestArtifactId: artifacts.id,
          manifestLogicalName: artifacts.logicalName,
          manifestMediaType: artifacts.mediaType,
          manifestByteLength: artifacts.byteLength,
          manifestSha256: artifacts.sha256,
          manifestProvenance: artifacts.provenance,
        })
        .from(npkInventories)
        .innerJoin(
          artifacts,
          and(
            eq(artifacts.runId, npkInventories.runId),
            eq(artifacts.id, npkInventories.sourceFrameManifestArtifactId),
          ),
        )
        .where(
          and(
            eq(npkInventories.id, expected.sourceInventoryId),
            eq(npkInventories.runId, expected.sourceRunId),
            eq(npkInventories.status, "frozen"),
            eq(
              npkInventories.sourceFrameManifestArtifactId,
              expected.sourceFrameManifestArtifactId,
            ),
          ),
        )
        .limit(1);
      if (!source) return { status: "source-evidence-mismatch" };
      const provenance = sourceFrameManifestProvenanceSchema.safeParse(
        source.manifestProvenance,
      );
      if (
        !provenance.success ||
        source.manifestArtifactId !== expected.sourceFrameManifestArtifactId ||
        source.manifestLogicalName !== "source-frame-manifest.json" ||
        source.manifestMediaType !== "application/json" ||
        provenance.data.sourceSha256.toUpperCase() !==
          source.sourceSha256.toUpperCase()
      ) {
        return { status: "source-evidence-mismatch" };
      }

      // 第三步：只读取 payload 枚举的 Entry，并按 payload 顺序重建；缺失、跨 Inventory 或摘要漂移整次拒绝。
      const expectedEntryIds = expected.sourceEntries.map(
        (entry) => entry.sourceInventoryEntryId,
      );
      const rows = await transaction
        .select({
          id: npkInventoryEntries.id,
          internalPath: npkInventoryEntries.internalPath,
          imgVersion: npkInventoryEntries.imgVersion,
          frameCount: npkInventoryEntries.frameCount,
          metadataSha256: npkInventoryEntries.metadataSha256,
        })
        .from(npkInventoryEntries)
        .where(
          and(
            eq(npkInventoryEntries.inventoryId, expected.sourceInventoryId),
            inArray(npkInventoryEntries.id, expectedEntryIds),
          ),
        );
      if (rows.length !== expectedEntryIds.length) {
        return { status: "source-evidence-mismatch" };
      }
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      const entries = [];
      for (const expectedEntry of expected.sourceEntries) {
        const row = rowsById.get(expectedEntry.sourceInventoryEntryId);
        if (
          !row ||
          row.metadataSha256.toUpperCase() !==
            expectedEntry.sourceMetadataSha256.toUpperCase()
        ) {
          return { status: "source-evidence-mismatch" };
        }
        entries.push({
          sourceInventoryEntryId: row.id,
          internalPath: row.internalPath,
          imgVersion: row.imgVersion,
          frameCount: row.frameCount,
          metadataSha256: row.metadataSha256.toUpperCase(),
        });
      }

      // 第四步：数据库映射再次通过公开 ViewModel schema；路径或大小预算异常不能越过 Repository。
      const context = professionSkillSourceContextViewSchema.safeParse({
        schemaVersion: 1,
        skillId: input.skillId,
        source: {
          runId: source.runId,
          inventoryId: source.inventoryId,
          byteLength: source.sourceByteLength,
          sha256: source.sourceSha256.toUpperCase(),
        },
        frameManifest: {
          artifactId: source.manifestArtifactId,
          mediaType: "application/json",
          byteLength: source.manifestByteLength,
          sha256: source.manifestSha256.toUpperCase(),
          toolSha256: provenance.data.toolSha256.toUpperCase(),
        },
        entries,
      });
      return context.success
        ? { status: "accepted", context: context.data }
        : { status: "source-evidence-mismatch" };
    });
  }
}

type Transaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

/** 从当前事务的 MySQL 时钟取得 lease 比较时间，避免 Nest/Worker 本机时钟偏差。 */
async function databaseNow(transaction: Transaction): Promise<Date> {
  const [row] = await transaction
    .select({ value: sql<Date | string>`CURRENT_TIMESTAMP(3)` })
    .from(jobs)
    .limit(1);
  if (!row) throw new Error("DATABASE_TIME_UNAVAILABLE");
  return row.value instanceof Date ? row.value : new Date(row.value);
}
