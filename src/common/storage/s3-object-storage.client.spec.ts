/**
 * @fileoverview 验证 S3/MinIO 适配器命令映射；不连接真实 MinIO 或外部网络。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type DeleteObjectCommandOutput,
  type GetObjectCommandOutput,
  type PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  S3ObjectStorageClient,
  type S3StorageCommandClient,
  type S3StoragePresigner,
} from "./s3-object-storage.client.js";

function byteStream(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const iterator = chunks[Symbol.iterator]();
      return {
        next: (): Promise<IteratorResult<Uint8Array>> =>
          Promise.resolve(iterator.next()),
      };
    },
  };
}

class FakeCommandClient implements S3StorageCommandClient {
  readonly commands: Array<GetObjectCommand | DeleteObjectCommand> = [];

  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
  send(
    command: GetObjectCommand | DeleteObjectCommand,
  ): Promise<GetObjectCommandOutput | DeleteObjectCommandOutput> {
    this.commands.push(command);
    if (command instanceof GetObjectCommand) {
      return Promise.resolve({
        $metadata: {},
        Body: byteStream(Buffer.from("artifact")),
        ContentLength: 8,
        ContentType: "application/octet-stream",
      });
    }
    return Promise.resolve({ $metadata: {} });
  }
}

class FakePresigner implements S3StoragePresigner {
  readonly getCommands: GetObjectCommand[] = [];
  readonly putCommands: PutObjectCommand[] = [];
  readonly ttlSeconds: number[] = [];

  signPut(command: PutObjectCommand, expiresIn: number): Promise<string> {
    this.putCommands.push(command);
    this.ttlSeconds.push(expiresIn);
    return Promise.resolve("http://127.0.0.1:9000/upload");
  }

  signGet(command: GetObjectCommand, expiresIn: number): Promise<string> {
    this.getCommands.push(command);
    this.ttlSeconds.push(expiresIn);
    return Promise.resolve("http://127.0.0.1:9000/download");
  }
}

describe("S3ObjectStorageClient", () => {
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
