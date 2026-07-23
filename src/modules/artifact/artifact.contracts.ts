/**
 * @fileoverview 定义 Worker 驱动的 Artifact 上传、finalize 与下载授权协议；不负责 HTTP 路由、
 * 数据库事务、对象存储访问或实际鉴权。Artifact 是私有对象存储中的证据对象，数据库只保存其
 * 相对存储引用、长度、SHA-256 与 Run/Job 归属元数据，而非对象正文。
 * @module modules/artifact/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：ArtifactWorkerController 在 Worker token 守卫后用这些 Zod schema 校验 body，
 * ArtifactService 与 ArtifactRepository 以推导出的 DTO 继续校验 lease、attempt、Run 归属和对象证据；
 * 浏览器读取端只消费 ArtifactView。下游对象存储端口只接收服务端已经受控生成的 object key。
 * 输入输出：输入是 Worker 声明的名称、媒体类型、长度、SHA-256、provenance 及当前租约；输出是
 * 不含 object key 的短期 URL 授权或脱敏 Artifact ViewModel。短期 URL 仅在过期前允许一次受控对象操作，
 * 不代表对象公开、Artifact 已部署，或候选补丁已验证兼容。
 * 副作用：本文件没有网络、数据库或对象存储副作用；它只建立运行时 DTO 边界。事务、哈希复核和
 * 会话状态写入由下游 Service/Repository 完成。
 * 安全边界：严格 schema 拒绝未知字段；workerId、leaseId 和 attempt 共同绑定 Worker 的限时执行权，
 * 即 lease（带过期时间和唯一 fencing 编号的任务编辑锁）与 attempt（Job 的第几次领取）。缺少其一、
 * 缺少 SHA-256 或 Run/Job 归属证据时，调用链必须 fail-closed，不能把 URL 或对象 key 交给调用方。
 */
import { z } from "zod";
import {
  boundedJsonRecordSchema,
  safeDisplayNameSchema,
  sha256Schema,
} from "../../common/contracts/index.js";
import { objectStorageMediaTypeSchema } from "../../common/storage/object-storage.client.js";

/**
 * Artifact provenance 的有界 JSON schema。
 *
 * 由受控 Worker 在申请上传时产生，并由 Repository 在写入前及读取映射时再次解析；用于保留可审计
 * 来源，不允许承载任意深度或无限大的对象。它不证明来源内容真实、候选包兼容，或拥有下载权限。
 */
export const artifactProvenanceSchema = boundedJsonRecordSchema;

/**
 * Worker 对当前 Job 操作的最小租约 DTO。
 *
 * 三个字段由 Worker 已领取的 Job 产生，Controller 在业务层前校验格式；Repository 仍会用数据库时间
 * 校验 owner、leaseId、attempt 和期限，故本 schema 通过不代表租约有效或资源归属已获确认。
 */
const artifactLeaseSchema = z
  .object({
    workerId: z.uuid(),
    leaseId: z.uuid(),
    attempt: z.number().int().min(1).max(10),
  })
  .strict();

/**
 * 申请受控 PUT 上传的严格 DTO schema。
 *
 * ArtifactWorkerController 从请求 body 解析它，ArtifactService 将通过的声明与当前 Job 租约和 Run 配额
 * 一并交给 Repository。SHA-256 是对象字节的 256 位摘要，后续 finalize 必须由对象存储流式复核；
 * 此处声明的哈希、长度和 media type 只是期望值，不代表对象已存在、已验证或已写入数据库。
 */
export const authorizeArtifactUploadSchema = artifactLeaseSchema
  .extend({
    logicalName: safeDisplayNameSchema,
    mediaType: objectStorageMediaTypeSchema,
    byteLength: z.number().int().min(0).max(4_294_967_295),
    sha256: sha256Schema,
    provenance: artifactProvenanceSchema,
  })
  .strict();

/**
 * finalize 请求的严格租约 DTO schema。
 *
 * Worker 在已完成受控 PUT 后提交此 DTO；它不携带 object key，防止调用方指定任意对象。通过格式校验
 * 不代表 finalize 成功，Repository 仍会拒绝过期会话、旧 attempt、归属不符或哈希证据不一致。
 */
export const finalizeArtifactUploadSchema = artifactLeaseSchema;

/**
 * 申请短期 GET 下载授权的严格租约 DTO schema。
 *
 * Worker 使用当前 Job 的 lease 请求同一 Run 内的最终 Artifact；短期 URL 不等于公开对象权限，且不允许
 * 以此跨 Run、跨 Job 或跨 attempt 读取对象。
 */
export const authorizeArtifactDownloadSchema = artifactLeaseSchema;

/** 通过上传授权 schema 解析后的 Service 输入；不是数据库上传会话行。 */
export type AuthorizeArtifactUploadInput = z.infer<
  typeof authorizeArtifactUploadSchema
>;

/** 通过 finalize schema 解析后的租约输入；只用于再次绑定当前 Job attempt。 */
export type FinalizeArtifactUploadInput = z.infer<
  typeof finalizeArtifactUploadSchema
>;

/** 通过下载授权 schema 解析后的租约输入；不包含或暴露对象 key。 */
export type AuthorizeArtifactDownloadInput = z.infer<
  typeof authorizeArtifactDownloadSchema
>;

/**
 * 返回给 Worker 的受控上传授权 ViewModel。
 *
 * uploadUrl 与 requiredHeaders 由对象存储端口生成，expiresAtUtc 为会话可用截止时间；调用方只能按声明
 * 执行 PUT，不能从该结构推导 bucket、长期凭据或对象的公共读取权限。
 */
export interface ArtifactUploadAuthorizationView {
  uploadId: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  expiresAtUtc: string;
}

/**
 * 返回给 Worker 的短期下载授权 ViewModel。
 *
 * 服务仅在 Job、Run 与精确 lease 归属通过后生成它；downloadUrl 到期即失效，且不表示 Artifact 已被部署、
 * 候选补丁兼容，或调用者可以枚举同一对象存储中的其他对象。
 */
export interface ArtifactDownloadAuthorizationView {
  artifactId: string;
  downloadUrl: string;
  expiresAtUtc: string;
}

/**
 * 对浏览器及受控 Worker 公开的 Artifact 元数据 ViewModel。
 *
 * Repository 从已 finalized 的数据库记录映射该结构；provenance、长度与 SHA-256 是审计与完整性元数据，
 * 不含 storageKey、对象正文、签名 URL 或任何 Worker token。该视图不证明对象已下载、补丁已部署或兼容性。
 */
export interface ArtifactView {
  id: string;
  runId: string;
  logicalName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  provenance: Record<string, unknown>;
  createdAtUtc: string;
}
