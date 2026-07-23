/**
 * @fileoverview 定义对象存储内部客户端契约；不暴露 AWS SDK、MinIO 凭据或 bucket 选择能力。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：Artifact 等领域 Service 依赖 ObjectStoragePort，ObjectStorageService 再调用内部
 * ObjectStorageClientPort，S3/禁用适配器实现后者。输入是已由业务层生成的相对对象 key、媒体
 * 类型、字节数与 SHA-256，输出为短期授权或完整性证据。此契约本身无 I/O 副作用。
 * 安全边界：Artifact 指私有对象存储中的证据对象，数据库只保存引用与摘要；短期 URL 不等于
 * 公开权限，调用方必须先校验用户或 Worker、Run/Project、lease 与 attempt 归属。
 */
import { z } from "zod";
import { sha256Schema } from "../contracts/index.js";

/**
 * 校验服务端生成的对象相对 key，拒绝根路径、反斜杠、空/父级路径段和控制字符。
 * 消费方可将成功结果交给固定 bucket 客户端，但该 schema 不证明对象存在或业务归属。
 */
export const objectStorageKeySchema = z
  .string()
  .min(1)
  .max(500)
  .superRefine((value, context) => {
    // 步骤 1：先拒绝会改变路径语义或日志边界的全局字符模式。
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
    // 步骤 2：逐段限制字符与 `.`/`..`，避免对象 key 逃逸服务端命名空间。
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

/** 校验小写标准媒体类型格式；不嗅探对象正文，也不证明类型声明真实。 */
export const objectStorageMediaTypeSchema = z
  .string()
  .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u);
/** 校验 SHA-256 十六进制格式并统一大写，供上传签名和服务端复核使用。 */
export const objectStorageSha256Schema = sha256Schema.transform((value) =>
  value.toUpperCase(),
);

/** 对象存储层可稳定映射到 HTTP/Job 结果的错误码；不包含 SDK 原始错误或凭据详情。 */
export type ObjectStorageErrorCode =
  | "OBJECT_STORAGE_DISABLED"
  | "OBJECT_STORAGE_INVALID_INPUT"
  | "OBJECT_STORAGE_LENGTH_MISMATCH"
  | "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH"
  | "OBJECT_STORAGE_OBJECT_TOO_LARGE"
  | "OBJECT_STORAGE_READ_FAILED"
  | "OBJECT_STORAGE_SHA256_MISMATCH";

/** 对象存储端口的稳定内部异常，上层按 code 映射而不暴露底层 Provider 对象。 */
export class ObjectStorageError extends Error {
  /** 调用方可分支处理的稳定错误码；message 仅为脱敏维护说明。 */
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

/** 由环境配置生产、ObjectStorageService 消费的运行选项，不包含 endpoint 或凭据。 */
export interface ObjectStorageOptions {
  /** 禁用时所有公开操作在接触客户端前失败。 */
  enabled: boolean;
  /** 单对象读取/授权字节上限，必须为 environmentSchema 已校验的正整数。 */
  maxObjectBytes: number;
  /** 预签名 URL 有效期秒数，限制在环境配置允许范围内。 */
  signedUrlTtlSeconds: number;
}

/** 由业务 Service 生产的最小对象引用；key 必须属于已完成归属校验的记录。 */
export interface ObjectStorageObjectRequest {
  /** 固定 bucket 内的相对 key，不得由用户直接选择任意路径。 */
  objectKey: string;
}

/** 业务层申请上传授权的 DTO；声明证据最终仍需服务端重新读取验证。 */
export interface ObjectStorageUploadRequest extends ObjectStorageObjectRequest {
  /** 上传对象声明的媒体类型，将绑定到签名 header。 */
  mediaType: string;
  /** 上传对象声明的字节数，不得超过单对象上限。 */
  byteLength: number;
  /** 上传对象声明的 SHA-256；不能代替 verify 的服务端重算。 */
  sha256: string;
}

/** ObjectStorageService 解析后的上传请求，SHA-256 已统一为大写。 */
export interface NormalizedObjectStorageUploadRequest extends ObjectStorageUploadRequest {
  /** 规范化大写摘要，与签名元数据及后续证据比较保持同一表示。 */
  sha256: string;
}

/** 返回受控上传方的短期 PUT ViewModel，不包含 bucket 或对象存储凭据。 */
export interface ObjectStorageUploadAuthorization {
  /** 授权绑定的固定对象 key，供调用方关联上传会话。 */
  objectKey: string;
  /** Provider 生成的短期 PUT URL；到期后不能继续使用，不代表对象公开。 */
  url: string;
  /** 上传方必须原样携带的已签名 header，包括媒体类型与声明摘要。 */
  requiredHeaders: Record<string, string>;
  /** 服务端按 TTL 计算的 UTC 到期展示值，不替代 Provider 对签名期限的校验。 */
  expiresAtUtc: string;
}

/** 返回已授权下载方的短期 GET ViewModel，不包含永久访问能力。 */
export interface ObjectStorageDownloadAuthorization {
  /** 业务层已确认可下载的对象 key。 */
  objectKey: string;
  /** Provider 生成的短期 GET URL；不能转化为 bucket 公开策略。 */
  url: string;
  /** 服务端按 TTL 计算的 UTC 到期展示值。 */
  expiresAtUtc: string;
}

/** 基础设施客户端读取结果；正文保持异步流，避免将大对象一次载入内存。 */
export interface ObjectStorageReadResult {
  /** SDK 响应转换的字节流；Service 必须完整消费并重算长度与哈希。 */
  body: AsyncIterable<Uint8Array>;
  /** Provider 声明的可选长度，只作为与实际流字节数交叉检查的证据。 */
  contentLength?: number;
  /** Provider 返回的可选媒体类型；verify 要求与预期严格一致。 */
  contentType?: string;
}

/** finalize 前的服务端复核声明；由 Artifact 业务层从同一上传会话元数据生产。 */
export interface ObjectStorageVerificationRequest extends ObjectStorageObjectRequest {
  /** 上传会话冻结的媒体类型。 */
  expectedMediaType: string;
  /** 上传会话冻结的字节数。 */
  expectedByteLength: number;
  /** 上传会话冻结的大写 SHA-256。 */
  expectedSha256: string;
}

/** 服务端完整读取对象后形成的完整性证据；不证明候选补丁兼容或已部署。 */
export interface ObjectStorageEvidence {
  /** 已复核对象的固定相对 key。 */
  objectKey: string;
  /** 与冻结声明一致的媒体类型。 */
  mediaType: string;
  /** 实际从完整字节流累计的长度。 */
  byteLength: number;
  /** 实际从完整字节流计算的大写 SHA-256。 */
  sha256: string;
}

/** 基础设施客户端只处理对象协议细节，不判断业务归属或 Artifact 状态。 */
export interface ObjectStorageClientPort {
  /**
   * @param input 已规范化并通过容量校验的上传声明。
   * @param ttlSeconds 环境固定的签名有效期秒数。
   * @returns Provider PUT URL 与必须携带的签名 header，不含 bucket 凭据。
   */
  authorizeUpload(
    input: NormalizedObjectStorageUploadRequest,
    ttlSeconds: number,
  ): Promise<Pick<ObjectStorageUploadAuthorization, "requiredHeaders" | "url">>;
  /** @returns 固定 key 的短期 GET URL；调用前业务层必须完成授权。 */
  authorizeDownload(objectKey: string, ttlSeconds: number): Promise<string>;
  /** @returns 固定 key 的异步正文流及可选响应元数据。 */
  read(objectKey: string): Promise<ObjectStorageReadResult>;
  /** @returns Provider 删除完成后 resolve；调用方必须先证明对象可清理。 */
  delete(objectKey: string): Promise<void>;
}

/** 领域模块依赖的稳定端口，避免把 AWS SDK 类型扩散到业务层。 */
export interface ObjectStoragePort {
  /** @returns 与声明证据绑定的短期上传授权；存储禁用或输入非法时拒绝。 */
  authorizeUpload(
    input: ObjectStorageUploadRequest,
  ): Promise<ObjectStorageUploadAuthorization>;
  /** @returns 业务层已授权 key 的短期下载授权；URL 不代表公开访问。 */
  authorizeDownload(
    input: ObjectStorageObjectRequest,
  ): Promise<ObjectStorageDownloadAuthorization>;
  /** @returns 完整读取并重算后的证据；只证明长度、媒体类型和哈希匹配。 */
  verify(
    input: ObjectStorageVerificationRequest,
  ): Promise<ObjectStorageEvidence>;
  /** @returns 删除完成后 resolve；不会同步删除数据库 Artifact 元数据。 */
  delete(input: ObjectStorageObjectRequest): Promise<void>;
}

/**
 * @param value 尚未信任的对象 key。
 * @returns 含 C0 或 DEL 控制字符时为 true，防止不可见路径/日志混淆。
 */
function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}
