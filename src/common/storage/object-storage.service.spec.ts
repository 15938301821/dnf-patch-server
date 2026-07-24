/**
 * @fileoverview 验证对象存储端口的禁用门禁、短期授权和流式完整性复核；不连接真实 S3。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：Vitest 以 ObjectStorageClientPort stub 调用真实 ObjectStorageService；stub 替代
 * S3/MinIO 网络和预签名器，byteStream 替代 SDK 响应流。输入是内存对象声明，输出为授权、证据
 * 或稳定错误。安全边界：覆盖禁用门禁、声明绑定、完整流哈希和容量中止；不证明真实签名可上传、
 * bucket 策略、Provider Content-Length、网络中断恢复或 Artifact 数据库 transaction。
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ObjectStorageClientPort,
  ObjectStorageOptions,
} from "./object-storage.client.js";
import { ObjectStorageService } from "./object-storage.service.js";

/** 测试专用启用配置，64 字节上限用于低成本触发容量分支。 */
const enabledOptions: ObjectStorageOptions = {
  enabled: true,
  maxObjectBytes: 64,
  signedUrlTtlSeconds: 300,
};

/** 测试 fixture 同时暴露端口和上传 spy，便于证明禁用路径零网络调用。 */
interface ObjectStorageClientFixture {
  /** 替代 Provider 预签名调用的 Vitest spy。 */
  authorizeUpload: ReturnType<typeof vi.fn>;
  /** 替代服务端 S3 PUT 的 Vitest spy。 */
  write: ReturnType<typeof vi.fn>;
  /** 注入 ObjectStorageService 的完整内存端口。 */
  client: ObjectStorageClientPort;
}

/**
 * @param chunks 模拟 SDK 按顺序返回的字节块。
 * @returns 仅驻留内存的异步字节流；不模拟网络背压、断流或重试。
 */
function byteStream(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    /** @returns 顺序消费测试 chunks 的异步迭代器。 */
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const iterator = chunks[Symbol.iterator]();
      return {
        next: (): Promise<IteratorResult<Uint8Array>> =>
          Promise.resolve(iterator.next()),
      };
    },
  };
}

/**
 * @param overrides 当前场景需要替换的内部客户端方法。
 * @returns 带默认成功行为的端口 stub 与上传 spy；不连接真实对象存储。
 */
function clientStub(
  overrides: Partial<ObjectStorageClientPort> = {},
): ObjectStorageClientFixture {
  const authorizeUpload = vi.fn().mockResolvedValue({
    url: "http://127.0.0.1:9000/upload",
    requiredHeaders: { "content-type": "application/octet-stream" },
  });
  const write = vi.fn().mockResolvedValue(undefined);
  const client: ObjectStorageClientPort = {
    authorizeUpload,
    authorizeDownload: vi
      .fn()
      .mockResolvedValue("http://127.0.0.1:9000/download"),
    write,
    read: vi.fn().mockResolvedValue({
      body: byteStream(Buffer.from("artifact")),
      contentLength: 8,
      contentType: "application/octet-stream",
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { authorizeUpload, write, client };
}

describe("ObjectStorageService", () => {
  // 禁用时第一层门禁必须在任何预签名/网络调用前拒绝，避免默认凭据链被触发。
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

  // 上传授权必须把规范化摘要、媒体类型、长度和环境 TTL 原样绑定给基础设施层。
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

  // 分块边界不能改变实际长度或 SHA-256，verify 必须消费完整流后才返回证据。
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

  it("returns small verified bytes only after complete evidence matches", async () => {
    const { client } = clientStub({
      read: vi.fn().mockResolvedValue({
        body: byteStream(Buffer.from("arti"), Buffer.from("fact")),
        contentLength: 8,
        contentType: "application/json",
      }),
    });
    const service = new ObjectStorageService(enabledOptions, client);

    await expect(
      service.readVerifiedBytes({
        objectKey: "artifacts/model-plan.json",
        expectedMediaType: "application/json",
        expectedByteLength: 8,
        expectedSha256:
          "C7C5C1D70C5DEC4416AB6158AFD0B223EF40C29B1DC1F97ED9428B94D4CADB1C",
        maxByteLength: 16,
      }),
    ).resolves.toMatchObject({ bytes: Buffer.from("artifact") });
  });

  it("rejects a declared object above the caller read budget before S3", async () => {
    const read = vi.fn();
    const service = new ObjectStorageService(
      enabledOptions,
      clientStub({ read }).client,
    );

    await expect(
      service.readVerifiedBytes({
        objectKey: "artifacts/model-plan.json",
        expectedMediaType: "application/json",
        expectedByteLength: 32,
        expectedSha256: "A".repeat(64),
        maxByteLength: 16,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_OBJECT_TOO_LARGE" });
    expect(read).not.toHaveBeenCalled();
  });

  it("writes server bytes without overwrite and returns verified evidence", async () => {
    const { client, write } = clientStub();
    const service = new ObjectStorageService(enabledOptions, client);
    const bytes = Buffer.from("artifact");
    const sha256 =
      "C7C5C1D70C5DEC4416AB6158AFD0B223EF40C29B1DC1F97ED9428B94D4CADB1C";

    await expect(
      service.write({
        objectKey: "artifacts/model-output",
        mediaType: "application/octet-stream",
        bytes,
        sha256,
      }),
    ).resolves.toEqual({
      objectKey: "artifacts/model-output",
      mediaType: "application/octet-stream",
      byteLength: 8,
      sha256,
    });
    expect(write).toHaveBeenCalledWith(
      {
        objectKey: "artifacts/model-output",
        mediaType: "application/octet-stream",
        byteLength: 8,
        sha256,
      },
      bytes,
    );
  });

  it("recovers a lost PUT response only when the stored bytes verify", async () => {
    const { client } = clientStub({
      write: vi.fn().mockRejectedValue(new Error("response lost")),
    });
    const service = new ObjectStorageService(enabledOptions, client);

    await expect(
      service.write({
        objectKey: "artifacts/model-output",
        mediaType: "application/octet-stream",
        bytes: Buffer.from("artifact"),
        sha256:
          "C7C5C1D70C5DEC4416AB6158AFD0B223EF40C29B1DC1F97ED9428B94D4CADB1C",
      }),
    ).resolves.toMatchObject({ byteLength: 8 });
  });

  it("rejects server byte hash drift before writing", async () => {
    const { client, write } = clientStub();
    const service = new ObjectStorageService(enabledOptions, client);

    await expect(
      service.write({
        objectKey: "artifacts/model-output",
        mediaType: "application/octet-stream",
        bytes: Buffer.from("artifact"),
        sha256: "F".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_SHA256_MISMATCH" });
    expect(write).not.toHaveBeenCalled();
  });

  // 上传方声明的长度或摘要任一漂移，都不得形成可供 Artifact finalize 的证据。
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

  // 实际流超过上限时应立即中止校验，不能因声明长度合法而继续接受对象。
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
