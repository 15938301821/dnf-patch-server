/**
 * @fileoverview 实现对象存储业务端口的运行时校验和服务端完整性复核；不创建 Artifact 元数据。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
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
  type ObjectStorageVerificationRequest,
} from "./object-storage.client.js";
import {
  OBJECT_STORAGE_CLIENT,
  OBJECT_STORAGE_OPTIONS,
} from "./object-storage.tokens.js";

const objectRequestSchema = z.object({ objectKey: objectStorageKeySchema });
const uploadRequestSchema = objectRequestSchema.extend({
  mediaType: objectStorageMediaTypeSchema,
  byteLength: z.number().int().min(0),
  sha256: objectStorageSha256Schema,
});
const verificationRequestSchema = objectRequestSchema.extend({
  expectedMediaType: objectStorageMediaTypeSchema,
  expectedByteLength: z.number().int().min(0),
  expectedSha256: objectStorageSha256Schema,
});

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
   * @throws ObjectStorageError 当对象存储禁用、输入非法或对象超过单对象上限。
   */
  async authorizeUpload(
    input: ObjectStorageUploadRequest,
  ): Promise<ObjectStorageUploadAuthorization> {
    this.assertEnabled();
    const parsed = this.parseUpload(input);
    const authorization = await this.client.authorizeUpload(
      parsed,
      this.options.signedUrlTtlSeconds,
    );
    return {
      objectKey: parsed.objectKey,
      url: authorization.url,
      requiredHeaders: authorization.requiredHeaders,
      expiresAtUtc: expiresAtUtc(this.options.signedUrlTtlSeconds),
    };
  }

  /**
   * 生成短期 GET 授权；调用方仍需在业务层先完成归属和状态检查。
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
   * 从对象存储重新读取完整对象并计算长度与 SHA-256，避免信任上传方声明。
   * @throws ObjectStorageError 当媒体类型、长度、哈希或容量边界不满足声明。
   */
  async verify(
    input: ObjectStorageVerificationRequest,
  ): Promise<ObjectStorageEvidence> {
    this.assertEnabled();
    const parsed = this.parseVerification(input);
    const object = await this.client.read(parsed.objectKey);
    if (object.contentType !== parsed.expectedMediaType) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
        "对象媒体类型与声明不一致。",
      );
    }

    const hash = createHash("sha256");
    let byteLength = 0;
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
    return {
      objectKey: parsed.objectKey,
      mediaType: parsed.expectedMediaType,
      byteLength,
      sha256,
    };
  }

  /**
   * 删除指定对象 key；调用方负责确保该对象不再被可信 Artifact 元数据引用。
   * @throws ObjectStorageError 当对象存储禁用或 key 非法。
   */
  async delete(input: ObjectStorageObjectRequest): Promise<void> {
    this.assertEnabled();
    const parsed = this.parseObjectRequest(input);
    await this.client.delete(parsed.objectKey);
  }

  private assertEnabled(): void {
    if (!this.options.enabled) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_DISABLED",
        "对象存储未启用。",
      );
    }
  }

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

function expiresAtUtc(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1_000).toISOString();
}
