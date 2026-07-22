/**
 * @fileoverview 定义对象存储内部客户端契约；不暴露 AWS SDK、MinIO 凭据或 bucket 选择能力。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { z } from "zod";
import { sha256Schema } from "../contracts/index.js";

export const objectStorageKeySchema = z
  .string()
  .min(1)
  .max(500)
  .superRefine((value, context) => {
    if (
      value.startsWith("/") ||
      value.includes("\\") ||
      value.includes("//") ||
      containsControlCharacter(value)
    ) {
      context.addIssue({
        code: "custom",
        message: "对象 key 必须是安全的相对存储路径。",
      });
      return;
    }
    const segments = value.split("/");
    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "对象 key 只能包含受限的相对路径段。",
      });
    }
  });

export const objectStorageMediaTypeSchema = z
  .string()
  .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u);
export const objectStorageSha256Schema = sha256Schema.transform((value) =>
  value.toUpperCase(),
);

export type ObjectStorageErrorCode =
  | "OBJECT_STORAGE_DISABLED"
  | "OBJECT_STORAGE_INVALID_INPUT"
  | "OBJECT_STORAGE_LENGTH_MISMATCH"
  | "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH"
  | "OBJECT_STORAGE_OBJECT_TOO_LARGE"
  | "OBJECT_STORAGE_READ_FAILED"
  | "OBJECT_STORAGE_SHA256_MISMATCH";

export class ObjectStorageError extends Error {
  readonly code: ObjectStorageErrorCode;

  /**
   * @param code 稳定错误码，供上层映射 HTTP 或 Job 终态。
   * @param message 面向内部日志的脱敏中文说明，不包含 bucket、凭据或底层驱动对象。
   */
  constructor(code: ObjectStorageErrorCode, message: string) {
    super(message);
    this.name = "ObjectStorageError";
    this.code = code;
  }
}

export interface ObjectStorageOptions {
  enabled: boolean;
  maxObjectBytes: number;
  signedUrlTtlSeconds: number;
}

export interface ObjectStorageObjectRequest {
  objectKey: string;
}

export interface ObjectStorageUploadRequest extends ObjectStorageObjectRequest {
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface NormalizedObjectStorageUploadRequest extends ObjectStorageUploadRequest {
  sha256: string;
}

export interface ObjectStorageUploadAuthorization {
  objectKey: string;
  url: string;
  requiredHeaders: Record<string, string>;
  expiresAtUtc: string;
}

export interface ObjectStorageDownloadAuthorization {
  objectKey: string;
  url: string;
  expiresAtUtc: string;
}

export interface ObjectStorageReadResult {
  body: AsyncIterable<Uint8Array>;
  contentLength?: number;
  contentType?: string;
}

export interface ObjectStorageVerificationRequest extends ObjectStorageObjectRequest {
  expectedMediaType: string;
  expectedByteLength: number;
  expectedSha256: string;
}

export interface ObjectStorageEvidence {
  objectKey: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

/** 基础设施客户端只处理对象协议细节，不判断业务归属或 Artifact 状态。 */
export interface ObjectStorageClientPort {
  authorizeUpload(
    input: NormalizedObjectStorageUploadRequest,
    ttlSeconds: number,
  ): Promise<Pick<ObjectStorageUploadAuthorization, "requiredHeaders" | "url">>;
  authorizeDownload(objectKey: string, ttlSeconds: number): Promise<string>;
  read(objectKey: string): Promise<ObjectStorageReadResult>;
  delete(objectKey: string): Promise<void>;
}

/** 领域模块依赖的稳定端口，避免把 AWS SDK 类型扩散到业务层。 */
export interface ObjectStoragePort {
  authorizeUpload(
    input: ObjectStorageUploadRequest,
  ): Promise<ObjectStorageUploadAuthorization>;
  authorizeDownload(
    input: ObjectStorageObjectRequest,
  ): Promise<ObjectStorageDownloadAuthorization>;
  verify(
    input: ObjectStorageVerificationRequest,
  ): Promise<ObjectStorageEvidence>;
  delete(input: ObjectStorageObjectRequest): Promise<void>;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}
