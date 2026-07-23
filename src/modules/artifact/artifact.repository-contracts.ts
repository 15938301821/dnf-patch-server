/**
 * @fileoverview 定义 Artifact 上传会话的内部仓储契约、状态联合与数据库映射形状；不包含 Drizzle、
 * HTTP、对象存储 URL/正文、事务实现或 Worker token 鉴权。
 * @module modules/artifact/repository-contracts
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：ArtifactService 依赖 ArtifactRepositoryPort 进行业务编排，ArtifactRepository 实现该端口，
 * repository-support 将数据库行映射为这些记录；Controller 只间接使用其公开 ViewModel，不能直接调用端口。
 * 输入输出：输入来自已校验的 Worker lease、Service 生成的会话/Artifact ID 与对象存储复核证据；输出是
 * 有限判别状态和内部记录。ArtifactView 是唯一可对外传递的元数据，其余 objectKey 仅停留在 Service 与
 * Repository 之间。
 * 副作用：本文件是纯类型/运行时状态 schema，不读写数据库、不发起网络、不创建 transaction 或对象存储操作；
 * 实现者必须在 Repository transaction 中落实写入、行锁和数据库时间检查。
 * 安全边界：lease 是带过期时间和唯一 fencing 编号的 Job 执行权，attempt 是 Job 的领取轮次；端口方法接收
 * 二者以便实现精确校验。SHA-256 是对象字节的 256 位摘要，只有复核证据匹配会话声明才允许最终 Artifact。
 * accepted/finalized 状态不代表对象公开、补丁兼容、已下载或已部署。
 */
import type { ObjectStorageEvidence } from "../../common/storage/object-storage.client.js";
import { z } from "zod";
import type {
  ArtifactView,
  FinalizeArtifactUploadInput,
} from "./artifact.contracts.js";

/**
 * 上传会话允许持久化的有限状态 schema。
 *
 * ArtifactRepository 写入、repository-support 读取时解析；`authorized` 表示待 PUT/finalize，`finalized`
 * 表示已绑定一个 Artifact，`rejected` 表示拒绝继续。通过该 schema 不代表对象已删除、哈希已验证或 lease 有效。
 */
export const artifactUploadSessionStatusSchema = z.enum([
  "authorized",
  "finalized",
  "rejected",
]);

/** 上传会话状态的 TypeScript 判别联合，由上方 schema 的运行时解析结果推导。 */
export type ArtifactUploadSessionStatus = z.infer<
  typeof artifactUploadSessionStatusSchema
>;

/**
 * Service 与 Repository 之间传递的上传会话内部记录。
 *
 * 由 reserve/prepare 查询和数据库行映射产生，objectKey 仅供对象存储端口签名、verify 或补偿删除，绝不作为
 * HTTP ViewModel 返回。leaseId 与 attempt 必须与会话创建时的 Job 执行轮次一致；record 不自行证明其仍未过期。
 */
export interface ArtifactUploadSessionRecord {
  /** 服务端生成的上传会话 UUID。 */
  id: string;
  /** 由锁定 Job 推导出的 Run UUID，防止调用方任意指定归属。 */
  runId: string;
  /** 创建会话的 Job UUID。 */
  jobId: string;
  /** 当前会话绑定的已认证 Worker UUID。 */
  workerId: string;
  /** 当前 attempt 的唯一 lease fencing UUID。 */
  leaseId: string;
  /** Job 第几次领取；旧轮次不能 finalize 新轮次会话。 */
  attempt: number;
  /** 私有对象存储的内部相对引用，不可公开回显。 */
  objectKey: string;
  /** 经显示名 schema 校验的逻辑文件名，不是磁盘路径。 */
  logicalName: string;
  /** 声明并复核的对象媒体类型。 */
  mediaType: string;
  /** 声明并复核的对象字节长度。 */
  expectedByteLength: number;
  /** 声明的对象 SHA-256，统一大写后与服务端复核证据比较。 */
  expectedSha256: string;
  /** 有界 provenance JSON；保留审计来源，不承载对象正文。 */
  provenance: Record<string, unknown>;
  /** 会话当前状态，决定是否还能 finalize 或被 orphan reaper 清理。 */
  status: ArtifactUploadSessionStatus;
  /** 以数据库时间计算的会话截止时间。 */
  expiresAt: Date;
  /** 会话写入数据库的时间。 */
  createdAt: Date;
  /** finalized 后关联的 Artifact UUID；缺失时不能把会话视为有效 finalized 状态。 */
  artifactId?: string;
}

/**
 * Service 创建上传授权前交给 Repository 的服务端预留记录。
 *
 * ID/objectKey 由 Service 生成，名称、媒体类型、长度、SHA-256、provenance 来自已通过 DTO schema 的 Worker
 * 声明；该记录不是数据库行，不携带 Run 或 lease，二者必须由锁定 Job 与独立 lease 参数推导。
 */
export interface ReserveArtifactUploadRecord {
  /** 服务端生成的上传会话 UUID。 */
  id: string;
  /** 服务端生成的私有对象存储相对引用。 */
  objectKey: string;
  /** Worker 声明的显示名，已过运行时格式校验。 */
  logicalName: string;
  /** Worker 声明的媒体类型，后续由对象存储证据复核。 */
  mediaType: string;
  /** Worker 声明的字节长度，计入 Run 配额。 */
  expectedByteLength: number;
  /** Worker 声明的 SHA-256，后续不能替代服务端流式计算。 */
  expectedSha256: string;
  /** Worker 声明的有界审计来源 JSON。 */
  provenance: Record<string, unknown>;
}

/**
 * 上传会话状态机向 Service 暴露的有限业务结果。
 *
 * Repository 生产、ArtifactService 映射为稳定 HTTP 错误或幂等 ViewModel；它不是数据库驱动错误，
 * 也不代表对象存储操作已经执行或回滚。
 */
export type ArtifactUploadMutationStatus =
  | "accepted"
  | "finalized"
  | "lease-mismatch"
  | "run-quota-exceeded"
  | "upload-expired"
  | "upload-not-found"
  | "upload-terminal"
  | "evidence-mismatch";

/**
 * reserveUpload 的结果：成功时包含刚提交的会话，失败时不创建会话。
 *
 * `lease-mismatch` 说明 Worker 执行权不再精确匹配；`run-quota-exceeded` 说明包含活跃会话在内的总量会超限。
 */
export type ReserveArtifactUploadResult =
  | { status: "accepted"; session: ArtifactUploadSessionRecord }
  | { status: "lease-mismatch" | "run-quota-exceeded" };

/**
 * prepareFinalize 的结果：允许复核、幂等返回既有 Artifact 或拒绝本次操作。
 *
 * `accepted` 只允许 Service 在事务外 verify 对象，不能被当作最终哈希证明；`finalized` 可用于同一会话的
 * 幂等重试，其他状态禁止对象存储签名或最终元数据写入。
 */
export type PrepareArtifactFinalizeResult =
  | { status: "accepted"; session: ArtifactUploadSessionRecord }
  | { status: "finalized"; artifact: ArtifactView }
  | {
      status:
        | "lease-mismatch"
        | "upload-expired"
        | "upload-not-found"
        | "upload-terminal";
    };

/**
 * finalizeUpload 的结果：接受新 Artifact、幂等返回既有 Artifact 或给出稳定拒绝原因。
 *
 * `evidence-mismatch` 表示 Repository 已拒绝会话而未插入 Artifact，Service 可在提交后尝试对象删除；
 * 其余失败状态不代表对象被删除或任何外部 I/O 已发生。
 */
export type FinalizeArtifactUploadResult =
  | { status: "accepted" | "finalized"; artifact: ArtifactView }
  | {
      status:
        | "evidence-mismatch"
        | "lease-mismatch"
        | "upload-expired"
        | "upload-not-found"
        | "upload-terminal";
    };

/**
 * 下载查找的内部结果。
 *
 * accepted 的 objectKey 只能传回 ArtifactService 供对象存储签名；artifact-not-found 同时覆盖不存在和跨 Run，
 * 避免向 Worker 泄露对象归属，lease-mismatch 则禁止签发 URL。
 */
export type ArtifactDownloadLookupResult =
  | { status: "accepted"; objectKey: string }
  | { status: "artifact-not-found" | "lease-mismatch" };

/**
 * orphan reaper 的一项内部删除候选。
 *
 * Repository 在数据库 transaction 中选择并锁定它，ArtifactService 在提交后执行对象存储 DELETE；
 * 它不是 finalized Artifact 列表，也不表示删除已经发生。
 */
export interface ArtifactOrphanRecord {
  /** 需在 DELETE 成功后标记的服务端上传会话 UUID。 */
  uploadId: string;
  /** 仅供对象存储端口使用的私有相对引用。 */
  objectKey: string;
}

/**
 * ArtifactService 使用的仓储抽象端口。
 *
 * ArtifactRepository 是生产实现，Service 单测用受控 stub 替代；所有实现必须在数据库 transaction 中落实
 * lease、attempt、Run 归属、行锁和状态转换。端口不提供 HTTP、对象正文、签名 URL 或 Worker token 接口。
 */
export interface ArtifactRepositoryPort {
  /**
   * 查找 Artifact 的 Run 归属，供跨模块引用前的一致性判断。
   *
   * @param id 已持久化或内部流程提供的 Artifact UUID。
   * @returns Run UUID 或 undefined；未找到不代表任何其他 Artifact 可访问。
   */
  findRunId(id: string): Promise<string | undefined>;

  /**
   * 读取 Run 的脱敏 Artifact 元数据。
   *
   * @param runId 已解析的 Run UUID。
   * @returns 已 finalized ArtifactView 列表，不含 objectKey 或下载授权。
   */
  listByRun(runId: string): Promise<ArtifactView[]>;

  /**
   * 原子预留上传会话和 Run 配额。
   *
   * @param jobId 已校验 Job UUID，决定 Run 归属。
   * @param reservation 服务端生成的对象引用及已校验声明。
   * @param lease 当前 Worker lease/attempt，必须在数据库时间下精确匹配。
   * @param sessionTtlSeconds 会话有效秒数。
   * @param maxRunBytes 单 Run 配额字节上限。
   * @returns accepted 会话或无写入的拒绝状态。
   */
  reserveUpload(
    jobId: string,
    reservation: ReserveArtifactUploadRecord,
    lease: FinalizeArtifactUploadInput,
    sessionTtlSeconds: number,
    maxRunBytes: number,
  ): Promise<ReserveArtifactUploadResult>;

  /**
   * 为对象复核准备并锁定上传会话状态。
   *
   * @param jobId 已校验 Job UUID。
   * @param uploadId 服务端上传会话 UUID。
   * @param lease 当前 Worker lease/attempt。
   * @returns 可复核会话、幂等 Artifact 或禁止 finalize 的状态。
   */
  prepareFinalize(
    jobId: string,
    uploadId: string,
    lease: FinalizeArtifactUploadInput,
  ): Promise<PrepareArtifactFinalizeResult>;

  /**
   * 原子写入复核一致的 Artifact 并封存会话。
   *
   * @param jobId 已校验 Job UUID。
   * @param uploadId 服务端上传会话 UUID。
   * @param artifactId Service 生成的 Artifact UUID。
   * @param evidence 对象存储重新计算的长度、媒体类型和 SHA-256 证据。
   * @param lease 当前 Worker lease/attempt。
   * @returns 新建/既有 Artifact 或稳定拒绝状态；不会签发 URL。
   */
  finalizeUpload(
    jobId: string,
    uploadId: string,
    artifactId: string,
    evidence: ObjectStorageEvidence,
    lease: FinalizeArtifactUploadInput,
  ): Promise<FinalizeArtifactUploadResult>;

  /**
   * 拒绝尚未终态的会话，并返回受控对象引用供提交后补偿删除。
   *
   * @param uploadId 服务端上传会话 UUID。
   * @param errorCode 已映射的稳定错误码，不能是原始 SDK 详情。
   * @returns 可删除 objectKey 或 undefined；返回 key 不表示对象已删。
   */
  rejectUpload(
    uploadId: string,
    errorCode: string,
  ): Promise<string | undefined>;

  /**
   * 在精确 lease 与同 Run 归属通过后返回内部对象引用。
   *
   * @param jobId 已校验 Job UUID。
   * @param artifactId 已校验 Artifact UUID。
   * @param lease 当前 Worker lease/attempt。
   * @returns objectKey 或不存在/租约失败状态；调用方才可向对象存储索取短期 URL。
   */
  findForDownload(
    jobId: string,
    artifactId: string,
    lease: FinalizeArtifactUploadInput,
  ): Promise<ArtifactDownloadLookupResult>;

  /**
   * 选择一批可删除的过期/拒绝会话并保持数据库领取边界。
   *
   * @param batchSize 环境限定的单轮候选上限。
   * @returns 内部 orphan 记录；不表示对象存储 DELETE 已执行。
   */
  findOrphans(batchSize: number): Promise<ArtifactOrphanRecord[]>;

  /**
   * 记录对象存储 DELETE 成功后的会话删除时间。
   *
   * @param uploadId 已由 orphan 或拒绝流程取得的会话 UUID。
   * @returns 无返回值；条件零更新不代表 DELETE 失败或成功。
   */
  markObjectDeleted(uploadId: string): Promise<void>;
}
