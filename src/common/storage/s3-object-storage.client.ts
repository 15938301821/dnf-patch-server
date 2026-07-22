/**
 * @fileoverview 将内部对象存储客户端契约适配到 S3/MinIO；不管理 bucket、用户或业务归属。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type DeleteObjectCommandOutput,
  type GetObjectCommandOutput,
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

export interface S3ObjectStorageClientConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface S3StorageCommandClient {
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
}

export interface S3StoragePresigner {
  signPut(command: PutObjectCommand, expiresIn: number): Promise<string>;
  signGet(command: GetObjectCommand, expiresIn: number): Promise<string>;
}

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

  /** 为服务端生成的 key 创建短期 PUT 授权，并把声明证据写入签名命令。 */
  async authorizeUpload(
    input: NormalizedObjectStorageUploadRequest,
    ttlSeconds: number,
  ): Promise<
    Pick<ObjectStorageUploadAuthorization, "requiredHeaders" | "url">
  > {
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

  /** 为已通过业务授权的对象 key 创建短期 GET 授权。 */
  authorizeDownload(objectKey: string, ttlSeconds: number): Promise<string> {
    return this.presigner.signGet(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      ttlSeconds,
    );
  }

  /** 读取对象正文并返回异步字节流，供服务层重新计算长度和 SHA-256。 */
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

  /** 删除对象 key；上层必须先完成业务归属和生命周期判断。 */
  async delete(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
  }
}

/** 根据已验证环境配置创建生产 S3/MinIO 客户端，不触发默认凭据发现链。 */
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

class AwsS3CommandClient implements S3StorageCommandClient {
  constructor(private readonly client: S3Client) {}

  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
  send(
    command: GetObjectCommand | DeleteObjectCommand,
  ): Promise<GetObjectCommandOutput | DeleteObjectCommandOutput> {
    return this.client.send(command);
  }
}

class AwsS3Presigner implements S3StoragePresigner {
  constructor(private readonly client: S3Client) {}

  signPut(command: PutObjectCommand, expiresIn: number): Promise<string> {
    return getSignedUrl(this.client, command, { expiresIn });
  }

  signGet(command: GetObjectCommand, expiresIn: number): Promise<string> {
    return getSignedUrl(this.client, command, { expiresIn });
  }
}

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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { [Symbol.asyncIterator]?: unknown };
  return typeof candidate[Symbol.asyncIterator] === "function";
}
