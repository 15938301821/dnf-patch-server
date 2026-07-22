/**
 * @fileoverview 验证对象存储端口的禁用门禁、短期授权和流式完整性复核；不连接真实 S3。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ObjectStorageClientPort,
  ObjectStorageOptions,
} from "./object-storage.client.js";
import { ObjectStorageService } from "./object-storage.service.js";

const enabledOptions: ObjectStorageOptions = {
  enabled: true,
  maxObjectBytes: 64,
  signedUrlTtlSeconds: 300,
};

interface ObjectStorageClientFixture {
  authorizeUpload: ReturnType<typeof vi.fn>;
  client: ObjectStorageClientPort;
}

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

function clientStub(
  overrides: Partial<ObjectStorageClientPort> = {},
): ObjectStorageClientFixture {
  const authorizeUpload = vi.fn().mockResolvedValue({
    url: "http://127.0.0.1:9000/upload",
    requiredHeaders: { "content-type": "application/octet-stream" },
  });
  const client: ObjectStorageClientPort = {
    authorizeUpload,
    authorizeDownload: vi
      .fn()
      .mockResolvedValue("http://127.0.0.1:9000/download"),
    read: vi.fn().mockResolvedValue({
      body: byteStream(Buffer.from("artifact")),
      contentLength: 8,
      contentType: "application/octet-stream",
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { authorizeUpload, client };
}

describe("ObjectStorageService", () => {
  it("fails closed without contacting S3 when storage is disabled", async () => {
    const { authorizeUpload, client } = clientStub();
    const service = new ObjectStorageService(
      { ...enabledOptions, enabled: false },
      client,
    );

    await expect(
      service.authorizeUpload({
        objectKey: "runs/run-id/artifact.bin",
        mediaType: "application/octet-stream",
        byteLength: 8,
        sha256: "C".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_DISABLED" });
    expect(authorizeUpload).not.toHaveBeenCalled();
  });

  it("binds upload authorization to the declared object evidence", async () => {
    const { authorizeUpload, client } = clientStub();
    const service = new ObjectStorageService(enabledOptions, client);
    const input = {
      objectKey: "runs/run-id/artifact.bin",
      mediaType: "application/octet-stream",
      byteLength: 8,
      sha256: "A".repeat(64),
    };

    const authorization = await service.authorizeUpload(input);

    expect(authorizeUpload).toHaveBeenCalledWith(
      { ...input, sha256: input.sha256.toUpperCase() },
      300,
    );
    expect(authorization.expiresAtUtc).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u,
    );
  });

  it("recomputes length and SHA-256 from the complete object stream", async () => {
    const { client } = clientStub({
      read: vi.fn().mockResolvedValue({
        body: byteStream(Buffer.from("arti"), Buffer.from("fact")),
        contentLength: 8,
        contentType: "application/octet-stream",
      }),
    });
    const service = new ObjectStorageService(enabledOptions, client);

    await expect(
      service.verify({
        objectKey: "runs/run-id/artifact.bin",
        expectedMediaType: "application/octet-stream",
        expectedByteLength: 8,
        expectedSha256:
          "C7C5C1D70C5DEC4416AB6158AFD0B223EF40C29B1DC1F97ED9428B94D4CADB1C",
      }),
    ).resolves.toEqual({
      objectKey: "runs/run-id/artifact.bin",
      mediaType: "application/octet-stream",
      byteLength: 8,
      sha256:
        "C7C5C1D70C5DEC4416AB6158AFD0B223EF40C29B1DC1F97ED9428B94D4CADB1C",
    });
  });

  it.each([
    {
      name: "declared length drift",
      expectedByteLength: 7,
      expectedSha256:
        "C7C5C1D70C5DEC4416AB6158AFD0B223EF40C29B1DC1F97ED9428B94D4CADB1C",
      code: "OBJECT_STORAGE_LENGTH_MISMATCH",
    },
    {
      name: "declared SHA-256 drift",
      expectedByteLength: 8,
      expectedSha256: "B".repeat(64),
      code: "OBJECT_STORAGE_SHA256_MISMATCH",
    },
  ])("rejects $name", async ({ expectedByteLength, expectedSha256, code }) => {
    const { client } = clientStub();
    const service = new ObjectStorageService(enabledOptions, client);

    await expect(
      service.verify({
        objectKey: "runs/run-id/artifact.bin",
        expectedMediaType: "application/octet-stream",
        expectedByteLength,
        expectedSha256,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("stops verification when streamed bytes exceed the configured limit", async () => {
    const service = new ObjectStorageService(
      { ...enabledOptions, maxObjectBytes: 7 },
      clientStub().client,
    );

    await expect(
      service.verify({
        objectKey: "runs/run-id/artifact.bin",
        expectedMediaType: "application/octet-stream",
        expectedByteLength: 8,
        expectedSha256:
          "C7C5C1D70C5DEC4416AB6158AFD0B223EF40C29B1DC1F97ED9428B94D4CADB1C",
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_OBJECT_TOO_LARGE" });
  });
});
