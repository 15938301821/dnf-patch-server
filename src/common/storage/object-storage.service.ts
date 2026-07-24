/**
 * @fileoverview 实现对象存储业务端口的运行时校验和服务端完整性复核；不创建 Artifact 元数据。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：Artifact Service 在完成用户/Worker、Run、lease/attempt 和对象生命周期检查后调用
 * 本 Service；本 Service 再调用 ObjectStorageClientPort。输入为对象声明，输出为短期 URL 或
 * 完整性证据。副作用包括签发 Provider URL、读取完整对象流和删除对象，不写 Artifact 数据表。
 * 安全边界：所有入口先检查禁用态和 Zod 边界；verify 必须由服务端重算长度与 SHA-256，成功
 * 只证明对象字节与冻结声明一致，不证明客户端兼容、全技能覆盖或部署。
 */
import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ObjectStorageError,
  objectStorageKeySchema,
  objectStorageMediaTypeSchema,
  objectStorageSha256Schema,
  type NormalizedObjectStorageUploadRequest,
  type ObjectStorageClientPort,
  type ObjectStorageDownloadAuthorization,
  type ObjectStorageEvidence,
  type ObjectStorageObjectRequest,
  type ObjectStorageOptions,
  type ObjectStoragePort,
  type ObjectStorageUploadAuthorization,
  type ObjectStorageUploadRequest,
  type ObjectStorageVerifiedBytes,
  type ObjectStorageVerifiedReadRequest,
  type ObjectStorageVerificationRequest,
  type ObjectStorageWriteRequest,
} from "./object-storage.client.js";
import {
  OBJECT_STORAGE_CLIENT,
  OBJECT_STORAGE_OPTIONS,
} from "./object-storage.tokens.js";

/** 对象 key 的严格内部 DTO schema，拒绝调用方夹带未声明字段。 */
const objectRequestSchema = z.object({ objectKey: objectStorageKeySchema });
/** 上传授权输入 schema，绑定媒体类型、非负长度与规范化摘要。 */
const uploadRequestSchema = objectRequestSchema.extend({
  mediaType: objectStorageMediaTypeSchema,
  byteLength: z.number().int().min(0),
  sha256: objectStorageSha256Schema,
});
/** 服务端复核输入 schema；预期证据应来自冻结上传会话，而非当前上传方自由声明。 */
const verificationRequestSchema = objectRequestSchema.extend({
  expectedMediaType: objectStorageMediaTypeSchema,
  expectedByteLength: z.number().int().min(0),
  expectedSha256: objectStorageSha256Schema,
});
/** 小型正文读取在完整证据之外增加用途级内存上限，禁止调用方借此拉取大 Artifact。 */
const verifiedReadRequestSchema = verificationRequestSchema
  .extend({ maxByteLength: z.number().int().positive() })
  .strict();
/** 服务端写入输入必须携带真实字节和冻结摘要，拒绝任意额外 Provider 参数。 */
const writeRequestSchema = objectRequestSchema
  .extend({
    mediaType: objectStorageMediaTypeSchema,
    bytes: z.instanceof(Uint8Array),
    sha256: objectStorageSha256Schema,
  })
  .strict();

/** 对象存储业务端口实现，隔离领域层与 AWS SDK/MinIO 协议细节。 */
@Injectable()
export class ObjectStorageService implements ObjectStoragePort {
  /**
   * @param options 已由环境契约限制的对象存储开关、TTL 和容量边界。
   * @param client 基础设施客户端；禁用态下不会被调用。
   */
  constructor(
    @Inject(OBJECT_STORAGE_OPTIONS)
    private readonly options: ObjectStorageOptions,
    @Inject(OBJECT_STORAGE_CLIENT)
    private readonly client: ObjectStorageClientPort,
  ) {}

  /**
   * 生成短期 PUT 授权，并在进入 S3 层前校验对象 key、媒体类型、长度和 SHA-256。
   * @param input Artifact 业务层为固定上传会话生产的声明，不接受任意 bucket。
   * @returns 绑定 key、声明 header 和环境 TTL 的短期 PUT ViewModel；不包含永久权限。
   * @throws ObjectStorageError 当对象存储禁用、输入非法或对象超过单对象上限。
   */
  async authorizeUpload(
    input: ObjectStorageUploadRequest,
  ): Promise<ObjectStorageUploadAuthorization> {
    // 步骤 1：禁用态在接触客户端前停止，避免触发 SDK 默认凭据或网络路径。
    this.assertEnabled();
    // 步骤 2：严格解析声明并检查容量，再允许基础设施层生成签名。
    const parsed = this.parseUpload(input);
    const authorization = await this.client.authorizeUpload(
      parsed,
      this.options.signedUrlTtlSeconds,
    );
    // 步骤 3：只组合业务层需要的短期 ViewModel，不暴露 bucket 或 Provider 凭据。
    return {
      objectKey: parsed.objectKey,
      url: authorization.url,
      requiredHeaders: authorization.requiredHeaders,
      expiresAtUtc: expiresAtUtc(this.options.signedUrlTtlSeconds),
    };
  }

  /**
   * 生成短期 GET 授权；调用方仍需在业务层先完成归属和状态检查。
   * @param input 业务层已确认调用方有权读取的固定对象 key。
   * @returns 带服务端到期展示值的短期 GET ViewModel，不代表对象公开。
   * @throws ObjectStorageError 当对象存储禁用或 key 非法。
   */
  async authorizeDownload(
    input: ObjectStorageObjectRequest,
  ): Promise<ObjectStorageDownloadAuthorization> {
    this.assertEnabled();
    const parsed = this.parseObjectRequest(input);
    const url = await this.client.authorizeDownload(
      parsed.objectKey,
      this.options.signedUrlTtlSeconds,
    );
    return {
      objectKey: parsed.objectKey,
      url,
      expiresAtUtc: expiresAtUtc(this.options.signedUrlTtlSeconds),
    };
  }

  /**
   * 将服务端已生成的有界字节写入固定私有 key，并完整回读形成证据。
   * PUT 使用不可覆盖语义；若 PUT 响应丢失或 key 已由同一恢复流程写入，会以冻结摘要回读确认，
   * 只有完整证据一致才返回成功。
   */
  async write(
    input: ObjectStorageWriteRequest,
  ): Promise<ObjectStorageEvidence> {
    this.assertEnabled();
    const parsed = writeRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_INVALID_INPUT",
        "服务端对象写入声明不合法。",
      );
    }
    if (parsed.data.bytes.byteLength > this.options.maxObjectBytes) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_OBJECT_TOO_LARGE",
        "对象超过单对象容量上限。",
      );
    }
    const actualSha256 = createHash("sha256")
      .update(parsed.data.bytes)
      .digest("hex")
      .toUpperCase();
    if (actualSha256 !== parsed.data.sha256) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_SHA256_MISMATCH",
        "服务端对象字节与冻结摘要不一致。",
      );
    }
    const declaration: NormalizedObjectStorageUploadRequest = {
      objectKey: parsed.data.objectKey,
      mediaType: parsed.data.mediaType,
      byteLength: parsed.data.bytes.byteLength,
      sha256: actualSha256,
    };
    try {
      await this.client.write(declaration, parsed.data.bytes);
    } catch {
      // PUT 可能已成功但响应丢失；固定 key + 摘要回读是唯一允许的恢复判据。
    }
    try {
      return await this.verify({
        objectKey: declaration.objectKey,
        expectedMediaType: declaration.mediaType,
        expectedByteLength: declaration.byteLength,
        expectedSha256: declaration.sha256,
      });
    } catch {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_WRITE_FAILED",
        "对象写入后未能确认完整证据。",
      );
    }
  }

  /**
   * 从对象存储重新读取完整对象并计算长度与 SHA-256，避免信任上传方声明。
   * @param input Artifact 上传会话冻结的 key、媒体类型、长度和摘要。
   * @returns 从完整流实际计算且与声明一致的证据；不创建或 finalize 数据库 Artifact 行。
   * @throws ObjectStorageError 当媒体类型、长度、哈希或容量边界不满足声明。
   */
  async verify(
    input: ObjectStorageVerificationRequest,
  ): Promise<ObjectStorageEvidence> {
    // 步骤 1：在网络读取前验证开关、key 和冻结声明，超上限声明不会触发对象下载。
    this.assertEnabled();
    const parsed = this.parseVerification(input);
    const object = await this.client.read(parsed.objectKey);
    // 步骤 2：先核对响应媒体类型；不一致时无需认可后续对象证据。
    if (object.contentType !== parsed.expectedMediaType) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
        "对象媒体类型与声明不一致。",
      );
    }

    const hash = createHash("sha256");
    let byteLength = 0;
    // 步骤 3：流式读取全部正文并同步累计长度/哈希，超过容量立即停止，避免内存聚合大对象。
    for await (const chunk of object.body) {
      byteLength += chunk.byteLength;
      if (byteLength > this.options.maxObjectBytes) {
        throw new ObjectStorageError(
          "OBJECT_STORAGE_OBJECT_TOO_LARGE",
          "对象超过单对象容量上限。",
        );
      }
      hash.update(chunk);
    }
    const sha256 = hash.digest("hex").toUpperCase();
    // 步骤 4：交叉核对 Provider 长度、冻结声明与实际摘要；任一漂移都不得形成 finalized 证据。
    if (
      object.contentLength !== undefined &&
      object.contentLength !== byteLength
    ) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_LENGTH_MISMATCH",
        "对象响应长度与实际读取长度不一致。",
      );
    }
    if (byteLength !== parsed.expectedByteLength) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_LENGTH_MISMATCH",
        "对象长度与声明不一致。",
      );
    }
    if (sha256 !== parsed.expectedSha256) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_SHA256_MISMATCH",
        "对象 SHA-256 与声明不一致。",
      );
    }
    // 步骤 5：只返回服务端可证明的字节证据，最终 Artifact 状态由调用方事务写入。
    return {
      objectKey: parsed.objectKey,
      mediaType: parsed.expectedMediaType,
      byteLength,
      sha256,
    };
  }

  /**
   * 完整读取一个严格有界的小型对象，在返回正文前同时复核媒体类型、长度和 SHA-256。
   * @param input 已由业务记录冻结的对象证据与当前解析器内存预算；不接受 bucket 或 URL。
   * @returns 只有全部字节和证据一致时才返回的正文；失败时不泄露部分内容。
   * @throws ObjectStorageError 输入、容量、媒体类型、长度、Provider 长度或摘要任一不匹配时抛出。
   */
  async readVerifiedBytes(
    input: ObjectStorageVerifiedReadRequest,
  ): Promise<ObjectStorageVerifiedBytes> {
    // 步骤 1：用途级预算必须比全局限制更严格；声明本身超限时不发起网络读取。
    this.assertEnabled();
    const parsed = verifiedReadRequestSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.maxByteLength > this.options.maxObjectBytes
    ) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_INVALID_INPUT",
        "对象正文读取声明不合法。",
      );
    }
    if (parsed.data.expectedByteLength > parsed.data.maxByteLength) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_OBJECT_TOO_LARGE",
        "对象超过当前解析器的正文容量上限。",
      );
    }

    const object = await this.client.read(parsed.data.objectKey);
    if (object.contentType !== parsed.data.expectedMediaType) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
        "对象媒体类型与声明不一致。",
      );
    }

    // 步骤 2：在有界内存中累计完整正文；超限立即中止且不向业务层返回部分 bytes。
    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for await (const chunk of object.body) {
      byteLength += chunk.byteLength;
      if (byteLength > parsed.data.maxByteLength) {
        throw new ObjectStorageError(
          "OBJECT_STORAGE_OBJECT_TOO_LARGE",
          "对象超过当前解析器的正文容量上限。",
        );
      }
      chunks.push(chunk);
      hash.update(chunk);
    }
    const sha256 = hash.digest("hex").toUpperCase();

    // 步骤 3：Provider 元数据与冻结证据全部一致后，才拼接并返回正文。
    if (
      (object.contentLength !== undefined &&
        object.contentLength !== byteLength) ||
      byteLength !== parsed.data.expectedByteLength
    ) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_LENGTH_MISMATCH",
        "对象长度与声明不一致。",
      );
    }
    if (sha256 !== parsed.data.expectedSha256) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_SHA256_MISMATCH",
        "对象 SHA-256 与声明不一致。",
      );
    }
    return {
      objectKey: parsed.data.objectKey,
      mediaType: parsed.data.expectedMediaType,
      byteLength,
      sha256,
      bytes: Buffer.concat(chunks, byteLength),
    };
  }

  /**
   * 删除指定对象 key；调用方负责确保该对象不再被可信 Artifact 元数据引用。
   * @param input 已完成生命周期与归属检查的对象 key。
   * @returns Provider 确认删除命令完成后 resolve；不修改数据库引用。
   * @throws ObjectStorageError 当对象存储禁用或 key 非法。
   */
  async delete(input: ObjectStorageObjectRequest): Promise<void> {
    this.assertEnabled();
    const parsed = this.parseObjectRequest(input);
    await this.client.delete(parsed.objectKey);
  }

  /**
   * 确认对象存储功能已显式启用。
   * @throws ObjectStorageError 禁用时抛出 `OBJECT_STORAGE_DISABLED`，后续客户端不得被调用。
   */
  private assertEnabled(): void {
    if (!this.options.enabled) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_DISABLED",
        "对象存储未启用。",
      );
    }
  }

  /**
   * @param input 业务层提供、尚未在本层验证的对象引用。
   * @returns 严格 schema 解析后的相对 key。
   * @throws ObjectStorageError key 格式或对象结构非法时抛出 `OBJECT_STORAGE_INVALID_INPUT`。
   */
  private parseObjectRequest(
    input: ObjectStorageObjectRequest,
  ): ObjectStorageObjectRequest {
    const result = objectRequestSchema.safeParse(input);
    if (!result.success) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_INVALID_INPUT",
        "对象存储 key 不合法。",
      );
    }
    return result.data;
  }

  /**
   * @param input 冻结上传会话的候选声明。
   * @returns key/媒体类型/长度校验成功且摘要已大写的请求。
   * @throws ObjectStorageError 输入非法或声明长度超过环境单对象上限时抛出。
   */
  private parseUpload(
    input: ObjectStorageUploadRequest,
  ): NormalizedObjectStorageUploadRequest {
    const result = uploadRequestSchema.safeParse(input);
    if (!result.success) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_INVALID_INPUT",
        "对象上传声明不合法。",
      );
    }
    if (result.data.byteLength > this.options.maxObjectBytes) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_OBJECT_TOO_LARGE",
        "对象超过单对象容量上限。",
      );
    }
    return result.data;
  }

  /**
   * @param input finalize 前来自上传会话的预期证据。
   * @returns 可用于服务端对象读取比较的规范化声明。
   * @throws ObjectStorageError 输入非法或预期长度超过单对象上限时抛出。
   */
  private parseVerification(
    input: ObjectStorageVerificationRequest,
  ): z.infer<typeof verificationRequestSchema> {
    const result = verificationRequestSchema.safeParse(input);
    if (!result.success) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_INVALID_INPUT",
        "对象校验声明不合法。",
      );
    }
    if (result.data.expectedByteLength > this.options.maxObjectBytes) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_OBJECT_TOO_LARGE",
        "声明对象长度超过单对象容量上限。",
      );
    }
    return result.data;
  }
}

/**
 * @param ttlSeconds environmentSchema 已限制的短期授权有效秒数。
 * @returns 基于当前服务时钟计算的 UTC ISO 展示值；Provider 签名仍是实际授权期限事实源。
 */
function expiresAtUtc(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1_000).toISOString();
}
