/**
 * @fileoverview 持久化最终 Artifact 与 Worker lease 绑定的上传会话，负责 Drizzle 查询、数据库时间、
 * transaction 与行锁；不访问对象正文、不签发 URL、不执行 Worker、本机工具或游戏目录操作。
 * Artifact 是私有对象存储中的证据对象，MySQL 只存相对存储引用、长度、SHA-256、provenance 与 Run 归属。
 * @module modules/artifact/repository
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：ArtifactService 是唯一业务上游，调用本 Repository 完成查询、受控上传会话状态变更和
 * orphan 候选选择；本类下游是 DatabaseService、artifacts、artifactUploadSessions、jobs 与 runs 表，
 * 并复用 repository-support 的数据库时间、行锁与证据映射函数。对象存储网络 I/O 由 Service 在事务外执行。
 * 输入输出：输入是已由 Controller/Service 解析的 Job、上传会话、精确 lease/attempt 和对象复核证据；
 * 输出是判别联合或脱敏 ArtifactView，内部 objectKey 只传给 Service 以签名/删除，绝不直接给 HTTP 客户端。
 * 副作用：多表变更均在 transaction 中完成。需要互斥的上传路径固定按 Job -> Run -> upload session 的
 * 顺序加 row lock；transaction 提交前不触发对象存储调用、广播或成功响应。
 * 安全边界：lease 是 Worker 对 Job 的带过期时间和唯一 fencing 编号的执行权，attempt 是该 Job 的领取轮次；
 * 每次写入均按数据库时间重验二者。SHA-256 是对象字节的 256 位摘要，Artifact 只有在服务端复核证据匹配
 * 会话声明后才入库。已 finalized 只证明这些元数据一致，不证明对象公开、补丁兼容或已经部署。
 */
import { Injectable } from "@nestjs/common";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import { artifacts } from "../../common/db/schema.js";
import type { ObjectStorageEvidence } from "../../common/storage/object-storage.client.js";
import type {
  ArtifactView,
  FinalizeArtifactUploadInput,
} from "./artifact.contracts.js";
import { artifactProvenanceSchema } from "./artifact.contracts.js";
import type {
  ArtifactDownloadLookupResult,
  ArtifactOrphanRecord,
  ArtifactRepositoryPort,
  FinalizeArtifactUploadResult,
  PrepareArtifactFinalizeResult,
  ReserveArtifactUploadRecord,
  ReserveArtifactUploadResult,
} from "./artifact.repository-contracts.js";
import {
  databaseNow,
  hasExactLease,
  lockRun,
  lockedJob,
  lockedSession,
  matchesEvidence,
  numericTotal,
  resolvePreparedSession,
  toArtifactView,
} from "./artifact.repository-support.js";

/**
 * Artifact 模块的 Drizzle 持久化边界实现。
 *
 * ArtifactService 通过 ArtifactRepositoryPort 注入此类；它拥有表查询、transaction 和行锁细节，
 * 不持有 HTTP 上下文或对象存储客户端。所有稳定业务状态以返回判别联合交给 Service 映射，数据库驱动
 * 原始错误不会由本类直接变成 API 响应。
 */
@Injectable()
export class ArtifactRepository implements ArtifactRepositoryPort {
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 查询 Artifact 的 Run 归属，供其他领域在引用它前作一致性检查。
   *
   * @param id 来自已持久化关联或内部 Service 的 Artifact UUID，不是未经验证的存储定位符。
   * @returns Artifact 存在时的 Run UUID；不存在时为 undefined，调用方必须 fail-closed 而非猜测归属。
   * @throws 无稳定业务错误映射；这是只读查询，不加行锁、不访问对象存储，也不证明调用者拥有该 Run。
   */
  async findRunId(id: string): Promise<string | undefined> {
    const [row] = await this.connection.database
      .select({ runId: artifacts.runId })
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .limit(1);
    return row?.runId;
  }

  /**
   * 读取一个 Run 的已 finalized Artifact 元数据并按创建时间排序。
   *
   * @param runId 来自 ArtifactService 的 Run UUID；调用方负责其认证或领域所有权边界。
   * @returns 经过 toArtifactView 脱敏与 provenance schema 复核的列表；空数组不表示 Run 必然不存在。
   * @throws provenance 读取不符合受限 JSON 契约时抛出内部错误，不能把未验证数据库 JSON 回显给调用方。
   * 本方法不签发 URL、不返回 storageKey、不加锁，也不证明对象可下载或补丁可部署。
   */
  async listByRun(runId: string): Promise<ArtifactView[]> {
    const rows = await this.connection.database
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(asc(artifacts.createdAt));
    return rows.map(toArtifactView);
  }

  /**
   * 在 transaction 内为一次受控 PUT 预留上传会话与 Run 配额。
   *
   * 调用关系：ArtifactService 在生成服务器对象引用后调用；本方法不向对象存储签名，确保外部网络 I/O
   * 不会占用数据库锁。锁顺序固定为 Job -> Run，后续仅插入新 session，避免并发会话同时越过 Run 配额。
   *
   * @param jobId 已校验的 Job UUID；用于锁定权威 Job 并推导不可伪造的 Run 归属。
   * @param reservation Service 生成的会话 UUID/objectKey 和已校验上传声明；objectKey 不来自 Worker。
   * @param lease Worker body 中的 workerId、leaseId、attempt；按数据库时间精确匹配当前执行权。
   * @param sessionTtlSeconds 经环境校验的会话寿命，单位秒；用于从数据库当前时间计算 expiresAt。
   * @param maxRunBytes 经环境校验的单 Run 总容量上限，包含 finalized 对象与未过期 authorized 会话。
   * @returns `accepted` 携带已写入的会话；lease 不匹配或配额不足时返回状态且不插入会话。
   * @throws provenance 不符合受限 JSON schema 或数据库操作失败时 transaction 回滚，不得签发 PUT URL。
   */
  async reserveUpload(
    jobId: string,
    reservation: ReserveArtifactUploadRecord,
    lease: FinalizeArtifactUploadInput,
    sessionTtlSeconds: number,
    maxRunBytes: number,
  ): Promise<ReserveArtifactUploadResult> {
    return this.connection.database.transaction(async (transaction) => {
      // 第 1 步：先锁定 Job，并以数据库时间验证 Worker 仍拥有当前 attempt 的 lease。
      const job = await lockedJob(transaction, jobId);
      if (!job || !hasExactLease(job, lease)) {
        return { status: "lease-mismatch" };
      }

      // 第 2 步：再锁 Run，串行化同一 Run 的已完成对象与活跃会话配额计算。
      await lockRun(transaction, job.runId);
      const [artifactTotal] = await transaction
        .select({
          value: sql<string>`coalesce(sum(${artifacts.byteLength}), 0)`,
        })
        .from(artifacts)
        .where(eq(artifacts.runId, job.runId));
      const [sessionTotal] = await transaction
        .select({
          value: sql<string>`coalesce(sum(${artifactUploadSessions.expectedByteLength}), 0)`,
        })
        .from(artifactUploadSessions)
        .where(
          and(
            eq(artifactUploadSessions.runId, job.runId),
            eq(artifactUploadSessions.status, "authorized"),
            gt(artifactUploadSessions.expiresAt, job.now),
          ),
        );
      const total =
        numericTotal(artifactTotal?.value) +
        numericTotal(sessionTotal?.value) +
        reservation.expectedByteLength;
      if (total > maxRunBytes) return { status: "run-quota-exceeded" };

      // 第 3 步：在同一 transaction 写入授权会话；后续签名 URL 只能在本 transaction 提交后请求。
      const expiresAt = new Date(job.now.getTime() + sessionTtlSeconds * 1_000);
      const provenance = artifactProvenanceSchema.parse(reservation.provenance);
      await transaction.insert(artifactUploadSessions).values({
        id: reservation.id,
        runId: job.runId,
        jobId,
        workerId: lease.workerId,
        leaseId: lease.leaseId,
        attempt: lease.attempt,
        objectKey: reservation.objectKey,
        logicalName: reservation.logicalName,
        mediaType: reservation.mediaType,
        expectedByteLength: reservation.expectedByteLength,
        expectedSha256: reservation.expectedSha256.toUpperCase(),
        provenance,
        status: "authorized",
        expiresAt,
        createdAt: job.now,
        updatedAt: job.now,
      });
      return {
        status: "accepted",
        session: {
          ...reservation,
          runId: job.runId,
          jobId,
          workerId: lease.workerId,
          leaseId: lease.leaseId,
          attempt: lease.attempt,
          expectedSha256: reservation.expectedSha256.toUpperCase(),
          provenance,
          status: "authorized",
          expiresAt,
          createdAt: job.now,
        },
      };
    });
  }

  /**
   * 在对象存储复核前锁定 Job、Run 和上传会话，判断本次 finalize 是否仍可进行。
   *
   * 调用关系：ArtifactService.finalizeUpload 的第一阶段调用。固定锁顺序为 Job -> Run -> upload session；
   * 如果会话已 finalized，会返回既有 Artifact 支持幂等重试；如果已过期，会在本 transaction 内拒绝会话。
   *
   * @param jobId 已校验的 Job UUID，用于精确 lease/attempt 与 Run 归属检查。
   * @param uploadId 已校验的服务端会话 UUID，不能由 Worker 替换成 objectKey。
   * @param lease 已解析的当前 Worker lease；仍须通过数据库时间和行锁条件。
   * @returns 可复核会话、既有 finalized Artifact 或稳定拒绝状态；返回 accepted 不代表对象证据已验证。
   * @throws finalized 会话缺失其引用 Artifact 时抛出内部不变量错误；其他数据库失败回滚本阶段状态变更。
   */
  async prepareFinalize(
    jobId: string,
    uploadId: string,
    lease: FinalizeArtifactUploadInput,
  ): Promise<PrepareArtifactFinalizeResult> {
    return this.connection.database.transaction(async (transaction) => {
      // 第 1 步：锁 Job 并阻止旧 lease/attempt 继续使用会话。
      const job = await lockedJob(transaction, jobId);
      if (!job || !hasExactLease(job, lease)) {
        return { status: "lease-mismatch" };
      }

      // 第 2 步：锁 Run 后再锁 session，保持所有上传路径一致的锁顺序。
      await lockRun(transaction, job.runId);
      const session = await lockedSession(transaction, uploadId);
      return resolvePreparedSession(
        transaction,
        jobId,
        job.runId,
        session,
        lease,
        job.now,
      );
    });
  }

  /**
   * 再次验证 lease、会话和对象存储证据，并原子创建最终 Artifact 后封存会话。
   *
   * 调用关系：ArtifactService 在事务外完成流式 verify 后调用。为防止 verify 期间 lease 过期或会话被并发改变，
   * 本方法再次按 Job -> Run -> upload session 加锁，而不是信任 prepare 阶段的旧结论。
   *
   * @param jobId 已校验的 Job UUID，确定权威 Run 归属。
   * @param uploadId 已校验的上传会话 UUID。
   * @param artifactId 仅由 Service 生成的最终 Artifact UUID，不接受 Worker 自选 ID。
   * @param evidence ObjectStoragePort 重新计算的 objectKey、media type、字节长度和 SHA-256 证据。
   * @param lease 当前 Worker 的精确 lease/attempt；旧 fencing 编号不能 finalize 新一轮 attempt。
   * @returns accepted/finalized 时给出 ArtifactView；证据、会话或 lease 异常时返回稳定状态而不插入 Artifact。
   * @throws transaction 内任一写入失败会回滚 Artifact 插入和会话封存，绝不出现半 finalized 元数据。
   */
  async finalizeUpload(
    jobId: string,
    uploadId: string,
    artifactId: string,
    evidence: ObjectStorageEvidence,
    lease: FinalizeArtifactUploadInput,
  ): Promise<FinalizeArtifactUploadResult> {
    return this.connection.database.transaction(async (transaction) => {
      // 第 1 步：按固定顺序重新锁定权威状态，拒绝 verify 期间已失效的 lease 或会话。
      const job = await lockedJob(transaction, jobId);
      if (!job || !hasExactLease(job, lease)) {
        return { status: "lease-mismatch" };
      }
      await lockRun(transaction, job.runId);
      const session = await lockedSession(transaction, uploadId);

      // 第 2 步：复用会话状态机；已 finalized 幂等返回，过期会话在此 transaction 内转 rejected。
      const prepared = await resolvePreparedSession(
        transaction,
        jobId,
        job.runId,
        session,
        lease,
        job.now,
      );
      if (prepared.status !== "accepted") return prepared;
      if (!matchesEvidence(prepared.session, evidence)) {
        // 第 3 步：证据不一致只拒绝 session，禁止写最终 Artifact；对象删除由提交后的 Service 补偿。
        await transaction
          .update(artifactUploadSessions)
          .set({
            status: "rejected",
            errorCode: "ARTIFACT_EVIDENCE_MISMATCH",
            updatedAt: job.now,
          })
          .where(eq(artifactUploadSessions.id, uploadId));
        return { status: "evidence-mismatch" };
      }

      // 第 4 步：只有证据一致时才在同一 transaction 插入 Artifact 并封存 session，二者要么全成要么全回滚。
      const storageKey = evidence.objectKey;
      const artifact: ArtifactView = {
        id: artifactId,
        runId: job.runId,
        logicalName: prepared.session.logicalName,
        mediaType: evidence.mediaType,
        byteLength: evidence.byteLength,
        sha256: evidence.sha256.toUpperCase(),
        provenance: prepared.session.provenance,
        createdAtUtc: job.now.toISOString(),
      };
      await transaction.insert(artifacts).values({
        id: artifact.id,
        runId: artifact.runId,
        logicalName: artifact.logicalName,
        storageKey,
        mediaType: artifact.mediaType,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
        provenance: artifact.provenance,
        createdAt: job.now,
      });
      await transaction
        .update(artifactUploadSessions)
        .set({
          status: "finalized",
          artifactId,
          finalizedAt: job.now,
          updatedAt: job.now,
        })
        .where(eq(artifactUploadSessions.id, uploadId));
      return { status: "accepted", artifact };
    });
  }

  /**
   * 将仍处于 authorized 状态的上传会话标记为 rejected，并返回内部对象引用供 Service 补偿删除。
   *
   * 调用关系：对象存储签名或可确定的 verify 失败后由 ArtifactService 调用；本方法不校验 Worker lease，
   * 因为调用方正处理已建立会话的系统侧失败路径。
   *
   * @param uploadId 服务端会话 UUID；不接受浏览器或 Worker 指定的 objectKey。
   * @param errorCode 已受控的稳定错误码，写入审计状态而不是原始 SDK 异常。
   * @returns 可删除的内部 objectKey；会话不存在或已终态时返回 undefined，且不改写既有终态。
   * @throws 数据库失败时 transaction 回滚；本方法不删除对象，调用方不得把返回值当成删除已经完成。
   */
  async rejectUpload(
    uploadId: string,
    errorCode: string,
  ): Promise<string | undefined> {
    return this.connection.database.transaction(async (transaction) => {
      // 锁定 session 后只允许 authorized -> rejected，避免覆盖 finalized 或既有拒绝原因。
      const session = await lockedSession(transaction, uploadId);
      if (!session || session.status !== "authorized") return undefined;
      const now = await databaseNow(transaction);
      await transaction
        .update(artifactUploadSessions)
        .set({ status: "rejected", errorCode, updatedAt: now })
        .where(eq(artifactUploadSessions.id, uploadId));
      return session.objectKey;
    });
  }

  /**
   * 验证当前 Worker lease 可读取同一 Run 的最终 Artifact，并返回仅供 Service 使用的 objectKey。
   *
   * @param jobId 已校验的 Job UUID；先锁定 Job 并以数据库时间验证其精确 lease/attempt。
   * @param artifactId 已校验的 Artifact UUID；查询条件同时约束 Job 推导的 Run，禁止跨 Run 读取。
   * @param lease Worker 的已解析执行权；认证 token 本身不能替代它。
   * @returns accepted 时返回内部 objectKey；不存在或跨 Run 返回 artifact-not-found，lease 不符返回 lease-mismatch。
   * @throws 无对象存储或签名副作用；短期 URL 只能由 Service 在本检查完成后另行签发。
   */
  async findForDownload(
    jobId: string,
    artifactId: string,
    lease: FinalizeArtifactUploadInput,
  ): Promise<ArtifactDownloadLookupResult> {
    return this.connection.database.transaction(async (transaction) => {
      // 先锁 Job，防止旧 Worker attempt 以过期 lease 读取同 Run 的对象。
      const job = await lockedJob(transaction, jobId);
      if (!job || !hasExactLease(job, lease)) {
        return { status: "lease-mismatch" };
      }
      const [artifact] = await transaction
        .select({ storageKey: artifacts.storageKey })
        .from(artifacts)
        .where(
          and(eq(artifacts.id, artifactId), eq(artifacts.runId, job.runId)),
        )
        .limit(1);
      return artifact
        ? { status: "accepted", objectKey: artifact.storageKey }
        : { status: "artifact-not-found" };
    });
  }

  /**
   * 选择并锁定一批可删除的 orphan 上传会话，必要时将过期 authorized 会话转为 rejected。
   *
   * 调用关系：ArtifactService.reapOrphans 在对象存储 DELETE 前调用。transaction 使用数据库时间和
   * `FOR UPDATE SKIP LOCKED`，使并发 transaction 不重复领取同一 session；这不是多 Nest 实例的
   * 调度 leader 机制，定时调度仍仅按当前单实例设计。
   *
   * @param batchSize 来自环境校验的正整数上限，限制单次锁定与后续外部 I/O 的数量。
   * @returns 仅含 uploadId/objectKey 的有界候选；空数组不代表没有历史 orphan，只代表本轮没有可领取项。
   * @throws 数据库失败时 transaction 回滚，禁止把未锁定记录交给对象存储 DELETE。
   */
  async findOrphans(batchSize: number): Promise<ArtifactOrphanRecord[]> {
    return this.connection.database.transaction(async (transaction) => {
      // 第 1 步：以数据库时间选择未标记删除、已过期且尚非 finalized 的会话并加跳锁行锁。
      const now = await databaseNow(transaction);
      const rows = await transaction
        .select({
          uploadId: artifactUploadSessions.id,
          objectKey: artifactUploadSessions.objectKey,
          status: artifactUploadSessions.status,
        })
        .from(artifactUploadSessions)
        .where(
          and(
            isNull(artifactUploadSessions.objectDeletedAt),
            lte(artifactUploadSessions.expiresAt, now),
            or(
              eq(artifactUploadSessions.status, "rejected"),
              eq(artifactUploadSessions.status, "authorized"),
            ),
          ),
        )
        .orderBy(asc(artifactUploadSessions.expiresAt))
        .limit(batchSize)
        .for("update", { skipLocked: true });

      // 第 2 步：过期但仍 authorized 的会话必须先持久化为 rejected；失败时整个选择/状态变更回滚。
      for (const row of rows) {
        if (row.status !== "authorized") continue;
        await transaction
          .update(artifactUploadSessions)
          .set({
            status: "rejected",
            errorCode: "ARTIFACT_UPLOAD_EXPIRED",
            updatedAt: now,
          })
          .where(eq(artifactUploadSessions.id, row.uploadId));
      }
      return rows.map(({ uploadId, objectKey }) => ({ uploadId, objectKey }));
    });
  }

  /**
   * 在对象存储 DELETE 成功后记录上传会话的删除时间，作为后续批次的幂等边界。
   *
   * @param uploadId 来自 findOrphans 或 rejectUpload 的服务端会话 UUID。
   * @returns 无返回值；条件更新零行时也安全，表示会话已标记、未过期、未拒绝或不存在，不能据此声称删除成功。
   * @throws 数据库失败时 transaction 回滚；本方法不调用对象存储，调用方必须先完成 DELETE。
   */
  async markObjectDeleted(uploadId: string): Promise<void> {
    await this.connection.database.transaction(async (transaction) => {
      // 只记录已 rejected 且已过期的 session，避免把仍可 finalize 的对象误标为已删除。
      const now = await databaseNow(transaction);
      await transaction
        .update(artifactUploadSessions)
        .set({ objectDeletedAt: now, updatedAt: now })
        .where(
          and(
            eq(artifactUploadSessions.id, uploadId),
            eq(artifactUploadSessions.status, "rejected"),
            lte(artifactUploadSessions.expiresAt, now),
          ),
        );
    });
  }
}
