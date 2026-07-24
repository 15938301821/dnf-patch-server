/**
 * @fileoverview 验证 S3/MinIO 适配器命令映射；不连接真实 MinIO 或外部网络。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：Vitest 以 FakeCommandClient/FakePresigner 替代 AWS SDK 网络边界，调用真实
 * S3ObjectStorageClient；其中一个场景只构造真实 SDK 客户端以检查签名 URL 参数，不发送请求。
 * 输入均为本机占位 endpoint 和非秘密测试凭据，输出为命令/URL/字节流。安全边界：证明命令
 * 映射和 signed headers，不证明真实 MinIO 凭据、bucket 权限、PUT/finalize 或网络兼容性。
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type DeleteObjectCommandOutput,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  createS3ObjectStorageClient,
  S3ObjectStorageClient,
  type S3StorageCommandClient,
  type S3StoragePresigner,
} from "./s3-object-storage.client.js";

/** @returns 内存异步字节流；不模拟真实 SDK 流的背压或失败。 */
function byteStream(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    /** @returns 顺序读取给定 chunks 的异步迭代器。 */
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const iterator = chunks[Symbol.iterator]();
      return {
        next: (): Promise<IteratorResult<Uint8Array>> =>
          Promise.resolve(iterator.next()),
      };
    },
  };
}

/** 记录 GET/DELETE 命令并返回固定响应的 AWS SDK fake，不连接网络。 */
class FakeCommandClient implements S3StorageCommandClient {
  /** 按调用顺序保存命令，供断言固定 bucket 与 key。 */
  readonly commands: Array<
    GetObjectCommand | PutObjectCommand | DeleteObjectCommand
  > = [];

  /** @returns 固定 GET 响应与内存正文。 */
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  /** @returns 固定 PUT 成功响应。 */
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  /** @returns 固定 DELETE 成功响应。 */
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
  /** @returns 按命令类型返回对应 fake 响应，并记录命令。 */
  send(
    command: GetObjectCommand | PutObjectCommand | DeleteObjectCommand,
  ): Promise<
    GetObjectCommandOutput | PutObjectCommandOutput | DeleteObjectCommandOutput
  > {
    this.commands.push(command);
    if (command instanceof GetObjectCommand) {
      return Promise.resolve({
        $metadata: {},
        Body: byteStream(Buffer.from("artifact")),
        ContentLength: 8,
        ContentType: "application/octet-stream",
      });
    }
    if (command instanceof PutObjectCommand) {
      return Promise.resolve({ $metadata: {} });
    }
    return Promise.resolve({ $metadata: {} });
  }
}

/** 记录预签名命令和 TTL 的 fake，不生成真实 AWS 签名。 */
class FakePresigner implements S3StoragePresigner {
  /** 收到的 GET 命令。 */
  readonly getCommands: GetObjectCommand[] = [];
  /** 收到的 PUT 命令。 */
  readonly putCommands: PutObjectCommand[] = [];
  /** 每次签名收到的有效期秒数。 */
  readonly ttlSeconds: number[] = [];

  /** @returns 固定本机占位上传 URL，并记录 PUT 命令和 TTL。 */
  signPut(command: PutObjectCommand, expiresIn: number): Promise<string> {
    this.putCommands.push(command);
    this.ttlSeconds.push(expiresIn);
    return Promise.resolve("http://127.0.0.1:9000/upload");
  }

  /** @returns 固定本机占位下载 URL，并记录 GET 命令和 TTL。 */
  signGet(command: GetObjectCommand, expiresIn: number): Promise<string> {
    this.getCommands.push(command);
    this.ttlSeconds.push(expiresIn);
    return Promise.resolve("http://127.0.0.1:9000/download");
  }
}

describe("S3ObjectStorageClient", () => {
  // PUT 必须固定 bucket/key，并将不可覆盖、媒体类型、长度和摘要全部绑定到命令。
  it("creates signed PUT commands with bucket, key, length, media type and SHA metadata", async () => {
    const commandClient = new FakeCommandClient();
    const presigner = new FakePresigner();
    const client = new S3ObjectStorageClient(
      "dnf-patch-artifacts",
      commandClient,
      presigner,
    );

    const result = await client.authorizeUpload(
      {
        objectKey: "runs/run-id/artifact.bin",
        mediaType: "application/octet-stream",
        byteLength: 8,
        sha256: "A".repeat(64),
      },
      300,
    );

    expect(result).toEqual({
      url: "http://127.0.0.1:9000/upload",
      requiredHeaders: {
        "content-type": "application/octet-stream",
        "if-none-match": "*",
        "x-amz-meta-dnf-sha256": "A".repeat(64),
      },
    });
    expect(presigner.ttlSeconds).toEqual([300]);
    expect(presigner.putCommands).toHaveLength(1);
    expect(presigner.putCommands[0]?.input).toMatchObject({
      Bucket: "dnf-patch-artifacts",
      Key: "runs/run-id/artifact.bin",
      ContentType: "application/octet-stream",
      ContentLength: 8,
      IfNoneMatch: "*",
      Metadata: { "dnf-sha256": "A".repeat(64) },
    });
  });

  // GET URL 只可指向构造时固定的私有 bucket，调用方不能在请求中选择 bucket。
  it("creates signed GET commands for the fixed private bucket", async () => {
    const commandClient = new FakeCommandClient();
    const presigner = new FakePresigner();
    const client = new S3ObjectStorageClient(
      "dnf-patch-artifacts",
      commandClient,
      presigner,
    );

    await expect(
      client.authorizeDownload("runs/run-id/artifact.bin", 120),
    ).resolves.toBe("http://127.0.0.1:9000/download");
    expect(presigner.ttlSeconds).toEqual([120]);
    expect(presigner.getCommands[0]?.input).toMatchObject({
      Bucket: "dnf-patch-artifacts",
      Key: "runs/run-id/artifact.bin",
    });
  });

  // 此场景只本地生成签名 URL；测试占位凭据不会发送，摘要必须留在签名 header 而非 query。
  it("keeps required upload metadata in signed headers", async () => {
    const client = createS3ObjectStorageClient({
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "dnf-patch-artifacts",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key-with-at-least-32-characters",
      forcePathStyle: true,
    });

    const authorization = await client.authorizeUpload(
      {
        objectKey: "artifacts/test-id",
        mediaType: "application/json",
        byteLength: 8,
        sha256: "A".repeat(64),
      },
      300,
    );
    const url = new URL(authorization.url);
    const signedHeaders =
      url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];

    expect(url.searchParams.has("x-amz-meta-dnf-sha256")).toBe(false);
    expect(signedHeaders).toEqual(
      expect.arrayContaining([
        "content-type",
        "if-none-match",
        "x-amz-meta-dnf-sha256",
      ]),
    );
  });

  // Provider Body 必须映射为字节流，长度/类型仍由上层与实际字节交叉复核。
  it("maps GET results to byte streams without trusting the caller", async () => {
    const commandClient = new FakeCommandClient();
    const client = new S3ObjectStorageClient(
      "dnf-patch-artifacts",
      commandClient,
      new FakePresigner(),
    );

    const result = await client.read("runs/run-id/artifact.bin");
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.body) chunks.push(chunk);

    expect(Buffer.concat(chunks).toString("utf8")).toBe("artifact");
    expect(result.contentLength).toBe(8);
    expect(result.contentType).toBe("application/octet-stream");
    expect(commandClient.commands[0]?.input).toMatchObject({
      Bucket: "dnf-patch-artifacts",
      Key: "runs/run-id/artifact.bin",
    });
  });

  it("writes server bytes with immutable evidence-bound PUT commands", async () => {
    const commandClient = new FakeCommandClient();
    const client = new S3ObjectStorageClient(
      "dnf-patch-artifacts",
      commandClient,
      new FakePresigner(),
    );
    const bytes = Buffer.from("artifact");

    await client.write(
      {
        objectKey: "artifacts/model-output",
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        sha256: "A".repeat(64),
      },
      bytes,
    );

    expect(commandClient.commands[0]).toBeInstanceOf(PutObjectCommand);
    expect(commandClient.commands[0]?.input).toMatchObject({
      Bucket: "dnf-patch-artifacts",
      Key: "artifacts/model-output",
      Body: bytes,
      ContentType: "image/png",
      ContentLength: bytes.byteLength,
      IfNoneMatch: "*",
      Metadata: { "dnf-sha256": "A".repeat(64) },
    });
  });

  // 清理只能发送固定 bucket 的 DeleteObject；测试不证明数据库引用已安全解除。
  it("deletes only from the fixed private bucket", async () => {
    const commandClient = new FakeCommandClient();
    const client = new S3ObjectStorageClient(
      "dnf-patch-artifacts",
      commandClient,
      new FakePresigner(),
    );

    await client.delete("runs/run-id/artifact.bin");

    expect(commandClient.commands[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(commandClient.commands[0]?.input).toMatchObject({
      Bucket: "dnf-patch-artifacts",
      Key: "runs/run-id/artifact.bin",
    });
  });
});
