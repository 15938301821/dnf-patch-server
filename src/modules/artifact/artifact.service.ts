/**
 * @fileoverview 编排 Worker 租约绑定的 Artifact 授权上传、对象复核 finalize、短期下载授权与 orphan 清理；
 * 不直接执行本机文件工具、不读取游戏目录、不保存对象正文，也不把短期 URL 当作公开对象权限。
 * Artifact 是私有对象存储中的证据对象，数据库仅保存相对存储引用、长度、SHA-256、provenance 与 Run 归属。
 * @module modules/artifact/service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：ArtifactWorkerController 在 Worker token、DTO 格式校验后调用上传/finalize/下载方法；
 * ArtifactController 调用列表查询；ArtifactOrphanReaperService 调用清理；NPK 与职业 Service 通过
 * findRunId 检查跨模块 Artifact 归属。下游 ArtifactRepository 拥有数据库 transaction 与 row lock，
 * ObjectStoragePort 负责签名 URL、流式对象证据复核和删除。
 * 输入输出：输入是经过 Zod 校验的 path/body DTO、已注入的配额/TTL 和对象存储证据；输出是脱敏
 * ArtifactView 或短期 URL，不含 object key、bucket 或凭据。finalize 成功仅证明服务端复核的长度、媒体类型
 * 与 SHA-256 相符，不证明补丁兼容、覆盖范围或已经部署。
 * 副作用：会话和 Artifact 元数据由 Repository 的事务写入；签名、verify 与 delete 是事务外对象存储 I/O。
 * 当外部授权失败时会在已提交会话上另开事务拒绝会话；当删除失败时会保留可重试 orphan。
 * 安全边界：认证成功不等于归属成功。每个 Worker 操作必须绑定 lease（带过期时间和唯一 fencing 编号的
 * 限时 Job 执行权）和 attempt（同一 Job 的第几次领取）；SHA-256 是对象字节的 256 位摘要，声明值必须
 * 在 finalize 时由对象存储重新计算并比对。缺失租约、Run/Job 归属、配额或证据时必须 fail-closed。
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  ObjectStorageError,
  type ObjectStoragePort,
} from "../../common/storage/object-storage.client.js";
import { OBJECT_STORAGE_PORT } from "../../common/storage/object-storage.tokens.js";
import type {
  ArtifactDownloadAuthorizationView,
  ArtifactUploadAuthorizationView,
  ArtifactView,
  AuthorizeArtifactDownloadInput,
  AuthorizeArtifactUploadInput,
  FinalizeArtifactUploadInput,
} from "./artifact.contracts.js";
import { ArtifactRepository } from "./artifact.repository.js";
import type {
  ArtifactRepositoryPort,
  ArtifactUploadMutationStatus,
  ReserveArtifactUploadRecord,
} from "./artifact.repository-contracts.js";
import {
  ARTIFACT_UPLOAD_OPTIONS,
  type ArtifactUploadOptions,
} from "./artifact.tokens.js";

/**
 * 会话必须终止、不能重试为“暂时不可用”的对象存储复核错误码集合。
 *
 * ObjectStoragePort 生产这些稳定码，rejectInvalidObject 与 throwStorageFailure 消费；命中时不能创建
 * Artifact 元数据。它们表示本次声明与对象证据不一致，不表示对象已安全删除或候选补丁不兼容。
 */
const terminalVerificationCodes = new Set([
  "OBJECT_STORAGE_LENGTH_MISMATCH",
  "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
  "OBJECT_STORAGE_OBJECT_TOO_LARGE",
  "OBJECT_STORAGE_SHA256_MISMATCH",
]);

/**
 * Artifact 领域的业务编排 Service。
 *
 * Controller 只把已校验 DTO 交给此类；Repository 才拥有 Drizzle 查询、数据库时间、transaction 与 row lock，
 * ObjectStoragePort 才访问对象存储。该层不接受 bucket、object key、文件路径或任意下载目标，避免把服务端
 * 编排能力变成对象存储代理。
 */
@Injectable()
export class ArtifactService {
  constructor(
    @Inject(ArtifactRepository)
    private readonly artifacts: ArtifactRepositoryPort,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
    @Inject(ARTIFACT_UPLOAD_OPTIONS)
    private readonly options: ArtifactUploadOptions,
  ) {}

  /**
   * 查找 Artifact 所属 Run，供 NPK/职业领域在写入引用前做归属一致性检查。
   *
   * @param id 来自已持久化引用或内部领域流程的 Artifact UUID，不是未校验的 HTTP 输入。
   * @returns 对应 Run UUID；不存在时返回 undefined，调用方必须将其作为缺失证据处理而非猜测归属。
   * @throws 本方法不映射 HTTP 错误，也不执行所有权授权、对象存储访问或事务写入。
   */
  findRunId(id: string): Promise<string | undefined> {
    return this.artifacts.findRunId(id);
  }

  /**
   * 读取某个 Run 已 finalized 的 Artifact 元数据列表。
   *
   * @param runId 来自 ArtifactController 已通过 UUID schema 的 path 参数。
   * @returns 脱敏 ArtifactView 列表，不含 object key、短期 URL 或对象正文；空数组不代表 Run 不存在。
   * @throws 本方法不签发下载授权、不检查 Worker lease，也不把数据库行直接暴露给浏览器。
   */
  listByRun(runId: string): Promise<ArtifactView[]> {
    return this.artifacts.listByRun(runId);
  }

  /**
   * 为当前 Worker lease 预留服务端对象 key，并返回受声明长度、类型与哈希约束的短期 PUT。
   *
   * 调用关系：仅由 ArtifactWorkerController 的 `POST .../uploads` 在 Worker token 认证与 DTO 格式校验后调用。
   * Repository 在独立 transaction 中锁定 Job/Run、核对 attempt/lease 并预留配额，然后对象存储端口签发 URL。
   *
   * @param jobId URL path 中已校验的 Job UUID；Repository 用其锁定权威 Job 并推导 Run，不能指定对象路径。
   * @param input body 中已校验的 Worker 租约、名称、媒体类型、长度、SHA-256 与 provenance 声明。
   * @returns 不含 objectKey/bucket 的短期 PUT 授权；调用方可据此执行受控 PUT，但结果不代表对象已上传或已 finalize。
   * @throws `JOB_LEASE_MISMATCH`、`ARTIFACT_RUN_QUOTA_EXCEEDED`、对象存储授权失败等稳定 HTTP 错误；
   * 任一失败时不向 Worker 返回 URL。
   */
  async authorizeUpload(
    jobId: string,
    input: AuthorizeArtifactUploadInput,
  ): Promise<ArtifactUploadAuthorizationView> {
    // 第 1 步：仅服务端生成不可预测的会话与对象引用，Worker 从未获得可任选的 object key。
    const uploadId = randomUUID();
    const objectKey = `artifacts/${randomUUID()}`;
    const record: ReserveArtifactUploadRecord = {
      id: uploadId,
      objectKey,
      logicalName: input.logicalName,
      mediaType: input.mediaType,
      expectedByteLength: input.byteLength,
      expectedSha256: input.sha256.toUpperCase(),
      provenance: input.provenance,
    };

    // 第 2 步：事务内锁定 Job/Run、校验精确 lease/attempt 并预留配额；失败时禁止签发 PUT URL。
    const reserved = await this.artifacts.reserveUpload(
      jobId,
      record,
      leaseInput(input),
      this.options.sessionTtlSeconds,
      this.options.maxRunBytes,
    );
    if (reserved.status !== "accepted") {
      throwUploadMutation(reserved.status);
    }

    try {
      // 第 3 步：事务提交后才向对象存储索取短期 URL，避免在持有数据库锁时进行网络 I/O。
      const authorization = await this.storage.authorizeUpload({
        objectKey: reserved.session.objectKey,
        mediaType: reserved.session.mediaType,
        byteLength: reserved.session.expectedByteLength,
        sha256: reserved.session.expectedSha256,
      });
      return {
        uploadId: reserved.session.id,
        uploadUrl: authorization.url,
        requiredHeaders: authorization.requiredHeaders,
        expiresAtUtc: reserved.session.expiresAt.toISOString(),
      };
    } catch {
      // 签名失败时另开持久化操作拒绝已预留会话；不得留下可继续使用的授权状态或伪造成功。
      await this.artifacts.rejectUpload(
        reserved.session.id,
        "OBJECT_STORAGE_AUTHORIZATION_FAILED",
      );
      throw new ServiceUnavailableException({
        code: "OBJECT_STORAGE_AUTHORIZATION_FAILED",
        message: "对象上传授权暂时不可用。",
      });
    }
  }

  /**
   * 再次验证 Worker lease 并流式复核对象；只有复核证据通过后才创建最终 Artifact。
   *
   * 调用关系：仅由 Worker 完成受控 PUT 后的 `POST .../finalize` 调用。prepare/finalize 两次进入 Repository
   * transaction，以避免在对象存储 I/O 后使用过期 lease、旧 attempt 或已变更会话。
   *
   * @param jobId URL path 中已校验的 Job UUID，限定当前 Run 与 lease。
   * @param uploadId URL path 中已校验的服务端会话 UUID，不允许替换为对象 key。
   * @param input body 中已校验的 workerId、leaseId、attempt；每次持久化前都将重新按数据库时间校验。
   * @returns finalized ArtifactView；仅代表服务端观察到的对象证据与会话声明一致，不代表对象已下载或补丁可部署。
   * @throws `JOB_LEASE_MISMATCH`、上传会话错误、证据不一致或对象复核不可用等稳定 HTTP 错误。
   */
  async finalizeUpload(
    jobId: string,
    uploadId: string,
    input: FinalizeArtifactUploadInput,
  ): Promise<ArtifactView> {
    // 第 1 步：短 transaction 锁定并确认会话可 finalize；已 finalized 时幂等返回原 Artifact。
    const prepared = await this.artifacts.prepareFinalize(
      jobId,
      uploadId,
      input,
    );
    if (prepared.status === "finalized") return prepared.artifact;
    if (prepared.status !== "accepted") {
      throwUploadMutation(prepared.status);
    }

    let evidence;
    try {
      // 第 2 步：在数据库事务外流式复核对象的 media type、长度和 SHA-256，避免长时间占用行锁。
      evidence = await this.storage.verify({
        objectKey: prepared.session.objectKey,
        expectedMediaType: prepared.session.mediaType,
        expectedByteLength: prepared.session.expectedByteLength,
        expectedSha256: prepared.session.expectedSha256,
      });
    } catch (error) {
      await this.rejectInvalidObject(prepared.session.id, error);
      throwStorageFailure(error);
    }

    // 第 3 步：再次锁定并核对 lease/会话，在同一 transaction 中写 Artifact 与封存会话。
    const finalized = await this.artifacts.finalizeUpload(
      jobId,
      prepared.session.id,
      randomUUID(),
      evidence,
      input,
    );
    if (finalized.status === "accepted" || finalized.status === "finalized") {
      return finalized.artifact;
    }
    if (finalized.status === "evidence-mismatch") {
      // 数据库已拒绝证据时才尝试补偿对象删除；删除失败会留下受限 orphan 供 reaper 重试。
      await this.deleteRejectedObject(
        prepared.session.id,
        prepared.session.objectKey,
      );
    }
    throwUploadMutation(finalized.status);
  }

  /**
   * 为当前有效 lease 签发同 Run 最终 Artifact 的短期 GET，不返回 object key。
   *
   * @param jobId URL path 中已校验的 Job UUID；Repository 用当前数据库 lease 限定访问范围。
   * @param artifactId URL path 中已校验的 Artifact UUID；跨 Run 或不存在对象统一拒绝。
   * @param input body 中已校验的 Worker 租约；只通过 token 认证而没有精确 attempt/lease 不足以下载。
   * @returns 有过期时间的下载 URL；不含存储定位信息，且不表示对象公开、永久可访问或补丁已获批准。
   * @throws `ARTIFACT_NOT_FOUND`、`JOB_LEASE_MISMATCH` 或对象存储授权异常；失败时不得返回 URL。
   */
  async authorizeDownload(
    jobId: string,
    artifactId: string,
    input: AuthorizeArtifactDownloadInput,
  ): Promise<ArtifactDownloadAuthorizationView> {
    const found = await this.artifacts.findForDownload(
      jobId,
      artifactId,
      input,
    );
    if (found.status === "artifact-not-found") {
      throw new NotFoundException({
        code: "ARTIFACT_NOT_FOUND",
        message: "Artifact 不存在或不属于当前 Run。",
      });
    }
    if (found.status !== "accepted") throwUploadMutation(found.status);

    // 归属与 lease 已经由 Repository transaction 确认后才进行外部签名，避免为未授权对象生成 URL。
    const authorization = await this.storage.authorizeDownload({
      objectKey: found.objectKey,
    });
    return {
      artifactId,
      downloadUrl: authorization.url,
      expiresAtUtc: authorization.expiresAtUtc,
    };
  }

  /**
   * 将可确定的对象复核失败转换为拒绝会话，并尝试安排对象删除。
   *
   * @param uploadId 来自已 prepare 的服务端上传会话，不接受客户端 object key。
   * @param error ObjectStoragePort 抛出的未知错误；仅稳定终止码可触发状态拒绝。
   * @returns 无返回值；非终止或无法识别的错误保留会话，交由上层映射为暂时不可用，不能误删对象。
   */
  private async rejectInvalidObject(
    uploadId: string,
    error: unknown,
  ): Promise<void> {
    const code = objectStorageErrorCode(error);
    if (!code || !terminalVerificationCodes.has(code)) return;
    const objectKey = await this.artifacts.rejectUpload(uploadId, code);
    if (!objectKey) return;
    await this.deleteRejectedObject(uploadId, objectKey);
  }

  /**
   * 在会话已经被拒绝后删除对象，并仅在删除成功后记录删除时间。
   *
   * @param uploadId 被拒绝会话的内部 UUID，用于成功后的持久化标记。
   * @param objectKey Repository 返回的受控存储引用，不由 Worker 或浏览器提供。
   * @returns 无返回值；对象删除或标记失败被吞掉，以便 orphan reaper 在后续有界批次补偿。
   */
  private async deleteRejectedObject(
    uploadId: string,
    objectKey: string,
  ): Promise<void> {
    try {
      await this.storage.delete({ objectKey });
      await this.artifacts.markObjectDeleted(uploadId);
    } catch {
      // Rejected sessions remain available to the bounded orphan reaper.
    }
  }

  /**
   * 删除一批已拒绝或过期会话对象；失败项保留，供下一有界批次重试。
   *
   * 调用关系：ArtifactOrphanReaperService 的单进程 timer 调用；Repository 在 transaction 内用数据库时间
   * 选取并锁定有界候选，Service 才进行对象存储 DELETE。
   *
   * @param batchSize 来自受环境校验的 reaper 配置，限制单轮对象 I/O 与数据库处理量。
   * @returns 无返回值；空批次或单个删除失败不表示存储完全干净。
   * @throws 单个对象的删除/标记错误被隔离，避免阻塞其他候选；定时器层仅记录整体稳定错误码。
   */
  async reapOrphans(batchSize: number): Promise<void> {
    const orphans = await this.artifacts.findOrphans(batchSize);
    for (const orphan of orphans) {
      try {
        // 删除是事务外 I/O；仅成功后标记，失败时禁止伪造零泄漏或跳过未来重试。
        await this.storage.delete({ objectKey: orphan.objectKey });
        await this.artifacts.markObjectDeleted(orphan.uploadId);
      } catch {
        // 单个对象失败不能阻断同一批次的其余清理。
      }
    }
  }
}

/**
 * 从上传 DTO 提取 Repository 所需的最小 lease 输入。
 *
 * 上传声明已经通过 Controller schema，但这里只复制 workerId、leaseId 与 attempt，防止把名称、哈希等
 * 非租约字段混入精确 lease 检查。返回值仍不证明 lease 有效，Repository 会依数据库时间再次验证。
 */
function leaseInput(
  input: AuthorizeArtifactUploadInput,
): FinalizeArtifactUploadInput {
  return {
    workerId: input.workerId,
    leaseId: input.leaseId,
    attempt: input.attempt,
  };
}

/**
 * 从对象存储端口的 unknown 异常中安全读取稳定错误码。
 *
 * 该函数不回显原始错误、响应正文或凭据；无法识别时返回 undefined，由调用方走暂时不可用分支，
 * 不把未知网络/SDK 错误误判为可删除的完整性失败。
 */
function objectStorageErrorCode(error: unknown): string | undefined {
  if (error instanceof ObjectStorageError) return error.code;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

/**
 * 把对象存储复核结果映射为稳定的 HTTP 业务错误。
 *
 * 终止证据不一致返回冲突，未知/暂时性错误返回服务不可用；不会泄露对象存储 SDK 原始错误，
 * 也不表示已成功清理对象或创建 Artifact 元数据。
 */
function throwStorageFailure(error: unknown): never {
  const code = objectStorageErrorCode(error);
  if (code && terminalVerificationCodes.has(code)) {
    throw new ConflictException({
      code,
      message: "上传对象与声明证据不一致。",
    });
  }
  throw new ServiceUnavailableException({
    code: "OBJECT_STORAGE_VERIFICATION_UNAVAILABLE",
    message: "对象完整性复核暂时不可用。",
  });
}

/**
 * 将 Repository 的有限状态结果映射为客户端可处理的稳定错误码。
 *
 * 输入来自已验证的仓储判别联合而非数据库驱动错误；此映射不执行回滚或对象删除。调用方必须在进入本函数前
 * 完成应有的拒绝/补偿操作，避免错误响应被误解为副作用已经完成。
 */
function throwUploadMutation(status: ArtifactUploadMutationStatus): never {
  if (status === "run-quota-exceeded") {
    throw new PayloadTooLargeException({
      code: "ARTIFACT_RUN_QUOTA_EXCEEDED",
      message: "当前 Run 的对象容量配额不足。",
    });
  }
  if (status === "upload-not-found") {
    throw new NotFoundException({
      code: "ARTIFACT_UPLOAD_NOT_FOUND",
      message: "Artifact 上传会话不存在。",
    });
  }
  throw new ConflictException({
    code:
      status === "lease-mismatch"
        ? "JOB_LEASE_MISMATCH"
        : status === "upload-expired"
          ? "ARTIFACT_UPLOAD_EXPIRED"
          : status === "evidence-mismatch"
            ? "ARTIFACT_EVIDENCE_MISMATCH"
            : "ARTIFACT_UPLOAD_TERMINAL",
    message: "Artifact 上传会话状态或 Worker 租约不允许当前操作。",
  });
}
