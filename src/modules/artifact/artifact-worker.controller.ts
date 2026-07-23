/**
 * @fileoverview 暴露 Worker 租约绑定的 Artifact 上传授权、finalize 与下载授权路由；不接受 bucket、
 * object key、任意对象存储选择或本机文件路径，也不自行执行业务状态机。
 * @module modules/artifact/worker-controller
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：仓库外受控 Worker 以 `X-Worker-Token` 调用 `/v1/internal/jobs/:jobId/artifacts`；
 * WorkerTokenGuard 在 Controller 前认证机器身份，ZodValidationPipe 校验 path/body，再由 ArtifactService
 * 协调 Repository 与私有对象存储。该 Guard 只证明 token 有效，不替代 Job、Run、lease 或 attempt 归属校验。
 * 输入输出：上传链路为“授权上传 -> 受控 PUT -> finalize”：先接收已声明的长度、媒体类型、SHA-256 和
 * provenance，输出短期 PUT URL；Worker 直接 PUT 后只提交 lease 完成 finalize；下载仅返回短期 GET URL。
 * 副作用：Controller 不读写数据库或访问对象存储，所有会话写入、行锁、哈希复核与外部 URL 签发在下游。
 * 安全边界：Artifact 是私有对象存储的证据对象；短期 URL 不等于公开权限。lease 是带唯一 fencing 编号的
 * 限时 Job 执行权，attempt 是 Job 第几次领取；旧 attempt、跨 Run/Job 或缺少哈希证据必须被下游拒绝。
 */
import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  authorizeArtifactDownloadSchema,
  authorizeArtifactUploadSchema,
  finalizeArtifactUploadSchema,
  type ArtifactDownloadAuthorizationView,
  type ArtifactUploadAuthorizationView,
  type ArtifactView,
  type AuthorizeArtifactDownloadInput,
  type AuthorizeArtifactUploadInput,
  type FinalizeArtifactUploadInput,
} from "./artifact.contracts.js";
import { ArtifactService } from "./artifact.service.js";

@Controller("internal/jobs/:jobId/artifacts")
@UseGuards(WorkerTokenGuard)
export class ArtifactWorkerController {
  constructor(private readonly artifacts: ArtifactService) {}

  /**
   * 为当前 Worker lease 预留上传会话并签发受约束的短期 PUT URL。
   *
   * 调用关系：Worker 在上传前调用；Controller 只校验 DTO，Service 负责在 Repository 事务中绑定
   * Job/Run/attempt 并向对象存储请求签名。
   *
   * @param jobId URL path 中已通过 idSchema 的 Job 标识，不能作为任意对象路径使用。
   * @param input body 中已通过严格 schema 的声明和精确 lease；SHA-256 仍须在 finalize 时复核。
   * @returns 不含 bucket/objectKey 的一次短期上传授权，不代表对象已上传、已验证或最终落库。
   * @throws Service 映射 `JOB_LEASE_MISMATCH`、配额、会话或对象存储授权失败等稳定错误。
   */
  @Post("uploads")
  authorizeUpload(
    @Param("jobId", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(authorizeArtifactUploadSchema))
    input: AuthorizeArtifactUploadInput,
  ): Promise<ArtifactUploadAuthorizationView> {
    return this.artifacts.authorizeUpload(jobId, input);
  }

  /**
   * 复核 Worker 已 PUT 的对象并在成功时 finalize Artifact 元数据。
   *
   * @param jobId URL path 中经校验的 Job 标识，用于限定 Run 与当前 lease。
   * @param uploadId URL path 中经校验的服务端上传会话标识，不允许由 Worker 替换对象 key。
   * @param input body 中经校验的 workerId、leaseId 与 attempt；Repository 会再次校验数据库时间。
   * @returns finalized ArtifactView；只证明对象长度、媒体类型和 SHA-256 与服务端复核证据一致，
   * 不证明候选补丁兼容或已经部署。
   * @throws Service 映射租约不匹配、会话过期、证据不一致或对象存储暂不可用等稳定错误。
   */
  @Post("uploads/:uploadId/finalize")
  finalizeUpload(
    @Param("jobId", new ZodValidationPipe(idSchema)) jobId: string,
    @Param("uploadId", new ZodValidationPipe(idSchema)) uploadId: string,
    @Body(new ZodValidationPipe(finalizeArtifactUploadSchema))
    input: FinalizeArtifactUploadInput,
  ): Promise<ArtifactView> {
    return this.artifacts.finalizeUpload(jobId, uploadId, input);
  }

  /**
   * 为同一 Run 内、当前 lease 允许读取的最终 Artifact 签发短期 GET URL。
   *
   * @param jobId URL path 中经校验的 Job 标识，Service 用它确认 Worker 的当前执行归属。
   * @param artifactId URL path 中经校验的 Artifact 标识，Repository 拒绝跨 Run 查找。
   * @param input body 中经校验的精确 lease，不可省略为仅凭 Worker token 的下载请求。
   * @returns 不含 objectKey 的临时下载授权；其有效期不代表对象对所有用户公开。
   * @throws `ARTIFACT_NOT_FOUND`、`JOB_LEASE_MISMATCH` 或对象存储授权失败由 Service 稳定映射。
   */
  @Post(":artifactId/download-authorizations")
  authorizeDownload(
    @Param("jobId", new ZodValidationPipe(idSchema)) jobId: string,
    @Param("artifactId", new ZodValidationPipe(idSchema)) artifactId: string,
    @Body(new ZodValidationPipe(authorizeArtifactDownloadSchema))
    input: AuthorizeArtifactDownloadInput,
  ): Promise<ArtifactDownloadAuthorizationView> {
    return this.artifacts.authorizeDownload(jobId, artifactId, input);
  }
}
