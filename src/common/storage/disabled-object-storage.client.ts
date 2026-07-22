/**
 * @fileoverview 提供禁用态对象存储客户端；不连接 S3、MinIO 或任何默认凭据链。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import {
  ObjectStorageError,
  type ObjectStorageClientPort,
  type ObjectStorageReadResult,
  type ObjectStorageUploadAuthorization,
} from "./object-storage.client.js";

export class DisabledObjectStorageClient implements ObjectStorageClientPort {
  /** 禁用态不应被调用；若调用说明上层门禁失效，立即 fail-closed。 */
  authorizeUpload(): Promise<
    Pick<ObjectStorageUploadAuthorization, "requiredHeaders" | "url">
  > {
    return Promise.reject(disabledError());
  }

  /** 禁用态不应被调用；若调用说明上层门禁失效，立即 fail-closed。 */
  authorizeDownload(): Promise<string> {
    return Promise.reject(disabledError());
  }

  /** 禁用态不应被调用；若调用说明上层门禁失效，立即 fail-closed。 */
  read(): Promise<ObjectStorageReadResult> {
    return Promise.reject(disabledError());
  }

  /** 禁用态不应被调用；若调用说明上层门禁失效，立即 fail-closed。 */
  delete(): Promise<void> {
    return Promise.reject(disabledError());
  }
}

function disabledError(): ObjectStorageError {
  return new ObjectStorageError("OBJECT_STORAGE_DISABLED", "对象存储未启用。");
}
