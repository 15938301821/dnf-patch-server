/**
 * @fileoverview 提供禁用态对象存储客户端；不连接 S3、MinIO 或任何默认凭据链。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：ObjectStorageModule 在 OBJECT_STORAGE_ENABLED=false 时构造本适配器；正常路径应由
 * ObjectStorageService.assertEnabled 更早拒绝。所有方法只返回 rejected Promise，无网络、磁盘或
 * 凭据副作用。安全边界：即使上层门禁回归，适配器仍 fail-closed，不回退默认 S3 配置。
 */
import {
  ObjectStorageError,
  type ObjectStorageClientPort,
  type ObjectStorageReadResult,
  type ObjectStorageUploadAuthorization,
} from "./object-storage.client.js";

/** 禁用态基础设施端口，作为第二层拒绝边界而不是功能降级实现。 */
export class DisabledObjectStorageClient implements ObjectStorageClientPort {
  /** @returns 始终以 `OBJECT_STORAGE_DISABLED` 拒绝，不生成上传 URL。 */
  authorizeUpload(): Promise<
    Pick<ObjectStorageUploadAuthorization, "requiredHeaders" | "url">
  > {
    return Promise.reject(disabledError());
  }

  /** @returns 始终以 `OBJECT_STORAGE_DISABLED` 拒绝，不生成下载 URL。 */
  authorizeDownload(): Promise<string> {
    return Promise.reject(disabledError());
  }

  /** @returns 始终以 `OBJECT_STORAGE_DISABLED` 拒绝，不写入对象。 */
  write(): Promise<void> {
    return Promise.reject(disabledError());
  }

  /** @returns 始终以 `OBJECT_STORAGE_DISABLED` 拒绝，不读取对象流。 */
  read(): Promise<ObjectStorageReadResult> {
    return Promise.reject(disabledError());
  }

  /** @returns 始终以 `OBJECT_STORAGE_DISABLED` 拒绝，不删除任何对象。 */
  delete(): Promise<void> {
    return Promise.reject(disabledError());
  }
}

/** @returns 每次调用创建独立的稳定禁用错误，且不含配置或凭据详情。 */
function disabledError(): ObjectStorageError {
  return new ObjectStorageError("OBJECT_STORAGE_DISABLED", "对象存储未启用。");
}
