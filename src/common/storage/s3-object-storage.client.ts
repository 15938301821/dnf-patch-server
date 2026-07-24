/**
 * @fileoverview 将内部对象存储客户端契约适配到 S3/MinIO；不管理 bucket、用户或业务归属。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：ObjectStorageModule 用显式环境配置创建本适配器，ObjectStorageService 通过内部端口
 * 调用它。输入是已校验对象 key/声明和固定 TTL，输出为 S3/MinIO 短期 URL或异步字节流。
 * 副作用包括签名 PUT/GET、读取与删除固定私有 bucket 中的对象；不写数据库或公开 bucket。
 * 安全边界：调用方不能覆盖 bucket、endpoint 或凭据；上传签名绑定 If-None-Match、媒体类型与
 * SHA 元数据。SDK 原始错误只向内部传播，公开边界必须映射为脱敏稳定错误。
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type DeleteObjectCommandOutput,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Buffer } from "node:buffer";
import {
  ObjectStorageError,
  type NormalizedObjectStorageUploadRequest,
  type ObjectStorageClientPort,
  type ObjectStorageReadResult,
  type ObjectStorageUploadAuthorization,
} from "./object-storage.client.js";

/** 由环境配置生产的 S3 客户端参数；凭据只用于构造 SDK，不得持久化或返回。 */
export interface S3ObjectStorageClientConfig {
  /** environmentSchema 校验的本机回环 S3/MinIO URL。 */
  endpoint: string;
  /** 签名区域，必须与私有存储部署配置一致。 */
  region: string;
  /** 固定私有 bucket，业务请求不能覆盖。 */
  bucket: string;
  /** 独立对象存储应用 Access Key；不是浏览器或 Worker token。 */
  accessKeyId: string;
  /** 独立 Secret Key，仅在进程内存和 SDK credentials 中短暂存在。 */
  secretAccessKey: string;
  /** 是否使用 path-style URL，供本机 MinIO 兼容。 */
  forcePathStyle: boolean;
}

/** 可替换的 S3 GET/PUT/DELETE 命令边界，生产实现委托 AWS SDK，测试实现记录命令。 */
export interface S3StorageCommandClient {
  /** @returns GET 响应，正文仍须由 ObjectStorageService 完整复核。 */
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  /** @returns PUT 响应；对象完整性仍由后续 GET 回读证明。 */
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  /** @returns DELETE 响应；调用前业务层必须确认对象生命周期。 */
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
}

/** 可替换的预签名边界；只允许固定 PUT/GET 命令，不暴露通用 S3 操作。 */
export interface S3StoragePresigner {
  /** @returns 绑定 PUT 命令和期限的短期 URL。 */
  signPut(command: PutObjectCommand, expiresIn: number): Promise<string>;
  /** @returns 绑定 GET 命令和期限的短期 URL。 */
  signGet(command: GetObjectCommand, expiresIn: number): Promise<string>;
}

/** 将稳定内部对象端口映射到固定 bucket 的 S3/MinIO 命令。 */
export class S3ObjectStorageClient implements ObjectStorageClientPort {
  /**
   * @param bucket 私有 bucket 名称，由环境契约固定，调用方不能覆盖。
   * @param client 受控 S3 命令客户端，负责 GET 与 DELETE。
   * @param presigner 受控短期预签名器，负责 PUT 与 GET 授权。
   */
  constructor(
    private readonly bucket: string,
    private readonly client: S3StorageCommandClient,
    private readonly presigner: S3StoragePresigner,
  ) {}

  /**
   * 为服务端生成的 key 创建短期 PUT 授权，并把声明证据写入签名命令。
   * @param input ObjectStorageService 已规范化的 key、媒体类型、长度和 SHA-256。
   * @param ttlSeconds 环境限制的签名有效秒数。
   * @returns 短期 URL 及上传方必须携带的签名 header；不含 bucket 凭据。
   */
  async authorizeUpload(
    input: NormalizedObjectStorageUploadRequest,
    ttlSeconds: number,
  ): Promise<
    Pick<ObjectStorageUploadAuthorization, "requiredHeaders" | "url">
  > {
    // IfNoneMatch 防止同一 key 被无条件覆盖；声明摘要进入必须签名的元数据 header。
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.objectKey,
      ContentType: input.mediaType,
      ContentLength: input.byteLength,
      IfNoneMatch: "*",
      Metadata: { "dnf-sha256": input.sha256 },
    });
    return {
      url: await this.presigner.signPut(command, ttlSeconds),
      requiredHeaders: {
        "content-type": input.mediaType,
        "if-none-match": "*",
        "x-amz-meta-dnf-sha256": input.sha256,
      },
    };
  }

  /**
   * @param objectKey 业务层已授权且通过相对 key schema 的对象引用。
   * @param ttlSeconds 环境限制的签名有效秒数。
   * @returns 固定私有 bucket 的短期 GET URL；不改变对象 ACL。
   */
  authorizeDownload(objectKey: string, ttlSeconds: number): Promise<string> {
    return this.presigner.signGet(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      ttlSeconds,
    );
  }

  /** 将服务端字节以不可覆盖方式写入固定私有 bucket；不把 PUT 响应当作完整性证据。 */
  async write(
    input: NormalizedObjectStorageUploadRequest,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        Body: bytes,
        ContentType: input.mediaType,
        ContentLength: input.byteLength,
        IfNoneMatch: "*",
        Metadata: { "dnf-sha256": input.sha256 },
      }),
    );
  }

  /**
   * @param objectKey 已校验的固定对象引用。
   * @returns 规范化异步字节流及可选 Provider 长度/媒体类型。
   * @throws ObjectStorageError Provider 未返回正文或正文不是可读字节流时抛出读取失败。
   */
  async read(objectKey: string): Promise<ObjectStorageReadResult> {
    const output = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
    if (output.Body === undefined) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_READ_FAILED",
        "对象存储响应缺少正文。",
      );
    }
    const result: ObjectStorageReadResult = {
      body: normalizeBody(output.Body),
    };
    if (output.ContentLength !== undefined) {
      result.contentLength = output.ContentLength;
    }
    if (output.ContentType !== undefined) {
      result.contentType = output.ContentType;
    }
    return result;
  }

  /**
   * @param objectKey 上层已确认不再被可信 Artifact 引用的对象 key。
   * @returns S3 删除命令完成后 resolve；不删除数据库元数据。
   */
  async delete(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
  }
}

/**
 * 根据已验证环境配置创建生产 S3/MinIO 客户端，不触发默认凭据发现链。
 * @param config ObjectStorageModule 从 ConfigService 组装的固定 endpoint、bucket 与显式凭据。
 * @returns 只暴露稳定内部操作的 ObjectStorageClientPort。
 */
export function createS3ObjectStorageClient(
  config: S3ObjectStorageClientConfig,
): ObjectStorageClientPort {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return new S3ObjectStorageClient(
    config.bucket,
    new AwsS3CommandClient(client),
    new AwsS3Presigner(client),
  );
}

/** 将窄化命令端口委托给 AWS SDK 客户端，隔离 SDK 重载类型。 */
class AwsS3CommandClient implements S3StorageCommandClient {
  /** @param client 使用显式凭据构造的进程内 S3Client。 */
  constructor(private readonly client: S3Client) {}

  /** @returns AWS SDK GET 响应。 */
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  /** @returns AWS SDK PUT 响应。 */
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  /** @returns AWS SDK DELETE 响应。 */
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
  /**
   * @param command 仅允许 GET 或 DELETE 的固定 bucket 命令。
   * @returns SDK 对应响应；原始异常留在内部边界，由上层统一脱敏映射。
   */
  send(
    command: GetObjectCommand | PutObjectCommand | DeleteObjectCommand,
  ): Promise<
    GetObjectCommandOutput | PutObjectCommandOutput | DeleteObjectCommandOutput
  > {
    return this.client.send(command);
  }
}

/** 将固定 S3 命令映射到 AWS 预签名 API，并锁定必须签名的上传 header。 */
class AwsS3Presigner implements S3StoragePresigner {
  /** @param client 与命令执行共享显式配置的 S3Client。 */
  constructor(private readonly client: S3Client) {}

  /**
   * @param command 已绑定 bucket、key、长度、媒体类型和哈希元数据的 PUT 命令。
   * @param expiresIn 签名有效秒数。
   * @returns 要求 content-type、If-None-Match 与摘要元数据参与签名的 PUT URL。
   */
  signPut(command: PutObjectCommand, expiresIn: number): Promise<string> {
    return getSignedUrl(this.client, command, {
      expiresIn,
      signableHeaders: new Set(["content-type"]),
      unhoistableHeaders: new Set(["x-amz-meta-dnf-sha256"]),
    });
  }

  /** @returns 固定 GET 命令的短期 URL；不会改变 bucket 或对象公开策略。 */
  signGet(command: GetObjectCommand, expiresIn: number): Promise<string> {
    return getSignedUrl(this.client, command, { expiresIn });
  }
}

/**
 * 将 SDK 的 unknown 响应正文逐块规范化为 Uint8Array。
 * @param body GetObject 响应正文；可能是 Node 流或测试异步迭代器。
 * @returns 可由 Service 流式复核的字节块序列。
 * @throws ObjectStorageError 正文不可异步迭代或出现非字符串/字节块时 fail-closed。
 */
async function* normalizeBody(body: unknown): AsyncIterable<Uint8Array> {
  if (!isAsyncIterable(body)) {
    throw new ObjectStorageError(
      "OBJECT_STORAGE_READ_FAILED",
      "对象存储响应正文不是可读取字节流。",
    );
  }
  for await (const chunk of body) {
    if (chunk instanceof Uint8Array) {
      yield chunk;
    } else if (typeof chunk === "string") {
      yield Buffer.from(chunk);
    } else {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_READ_FAILED",
        "对象存储响应正文包含非字节块。",
      );
    }
  }
}

/**
 * @param value 尚未信任的 SDK Body。
 * @returns 非 null 对象且实现 Symbol.asyncIterator 时为 true。
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { [Symbol.asyncIterator]?: unknown };
  return typeof candidate[Symbol.asyncIterator] === "function";
}
