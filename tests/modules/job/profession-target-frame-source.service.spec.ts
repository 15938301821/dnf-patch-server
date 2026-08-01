/**
 * @fileoverview 验证官方逐帧 PNG 在事务外复读、像素校验和 commit 之间的顺序；
 * 使用 Repository/ObjectStorage stub，不证明真实 MySQL 行锁或 S3 字节流。
 * @module modules/job/profession-target-frame-source-service-spec
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - V6 逐帧模型输入冻结
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectStoragePort } from "../../../src/common/storage/object-storage.client.js";
import type { RegisterProfessionTargetFrameSourceInput } from "../../../src/modules/job/profession-target-frame-prepare.contracts.js";
import type { ProfessionTargetFrameSourceRead } from "../../../src/modules/job/profession-target-frame-source.repository.js";
import { ProfessionTargetFrameSourceService } from "../../../src/modules/job/profession-target-frame-source.service.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input: RegisterProfessionTargetFrameSourceInput = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  attempt: 2,
  skillId: "44444444-4444-4444-8444-444444444444",
  entryIndex: 0,
  frameIndex: 1,
  sourceArtifactId: "55555555-5555-4555-8555-555555555555",
  sourceMediaType: "image/png",
  sourceByteLength: 1,
  sourceSha256: "A".repeat(64),
};
type SourceRepositoryPort = ConstructorParameters<
  typeof ProfessionTargetFrameSourceService
>[0];

describe("ProfessionTargetFrameSourceService", () => {
  const inspect = vi.fn<SourceRepositoryPort["inspect"]>();
  const commit = vi.fn<SourceRepositoryPort["commit"]>();
  const readVerifiedBytes = vi.fn<ObjectStoragePort["readVerifiedBytes"]>();
  const storage = {
    authorizeUpload: vi.fn(),
    authorizeDownload: vi.fn(),
    write: vi.fn(),
    verify: vi.fn(),
    readVerifiedBytes,
    delete: vi.fn(),
  } satisfies ObjectStoragePort;
  let service: ProfessionTargetFrameSourceService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new ProfessionTargetFrameSourceService(
      { inspect, commit },
      storage,
    );
  });

  it("PNG 尺寸和 Alpha 复读通过后只提交一次", async () => {
    const fixture = await validFixture();
    inspect.mockResolvedValue({ status: "read-required", read: fixture.read });
    readVerifiedBytes.mockResolvedValue(fixture.stored);
    commit.mockResolvedValue({ status: "registered", source: fixture.view });

    await expect(service.register(jobId, fixture.input)).resolves.toEqual(
      fixture.view,
    );
    expect(commit).toHaveBeenCalledWith(jobId, fixture.input, fixture.read);
  });

  it("Alpha 漂移时拒绝且不提交 target 行", async () => {
    const fixture = await validFixture({ expectedAlphaSha256: "F".repeat(64) });
    inspect.mockResolvedValue({ status: "read-required", read: fixture.read });
    readVerifiedBytes.mockResolvedValue(fixture.stored);

    await expect(service.register(jobId, fixture.input)).rejects.toMatchObject({
      response: { code: "PROFESSION_TARGET_FRAME_SOURCE_IMAGE_INVALID" },
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("对象读取失败时返回稳定 503 且不提交", async () => {
    const fixture = await validFixture();
    inspect.mockResolvedValue({ status: "read-required", read: fixture.read });
    readVerifiedBytes.mockRejectedValue(new Error("storage detail"));

    await expect(service.register(jobId, fixture.input)).rejects.toMatchObject({
      response: { code: "PROFESSION_TARGET_FRAME_STORAGE_UNAVAILABLE" },
    });
    expect(commit).not.toHaveBeenCalled();
  });
});

async function validFixture(options?: {
  expectedAlphaSha256?: string;
}): Promise<{
  input: RegisterProfessionTargetFrameSourceInput;
  read: ProfessionTargetFrameSourceRead;
  stored: Awaited<ReturnType<ObjectStoragePort["readVerifiedBytes"]>>;
  view: Awaited<ReturnType<ProfessionTargetFrameSourceService["register"]>>;
}> {
  const alpha = Buffer.from([0, 64, 128, 255]);
  const rgba = Buffer.from([
    10,
    20,
    30,
    alpha[0] ?? 0,
    10,
    20,
    30,
    alpha[1] ?? 0,
    10,
    20,
    30,
    alpha[2] ?? 0,
    10,
    20,
    30,
    alpha[3] ?? 0,
  ]);
  const bytes = await sharp(rgba, {
    raw: { width: 2, height: 2, channels: 4 },
  })
    .png()
    .toBuffer();
  const sourceSha256 = sha256(bytes);
  const fixtureInput = {
    ...input,
    sourceByteLength: bytes.byteLength,
    sourceSha256,
  };
  const read: ProfessionTargetFrameSourceRead = {
    targetId: "66666666-6666-4666-8666-666666666666",
    artifactId: fixtureInput.sourceArtifactId,
    uploadId: "77777777-7777-4777-8777-777777777777",
    read: {
      objectKey: "artifacts/source-frame.png",
      expectedMediaType: "image/png",
      expectedByteLength: bytes.byteLength,
      expectedSha256: sourceSha256,
      maxByteLength: 64 * 1024 * 1024,
    },
    provenance: {
      schemaVersion: 1,
      kind: "profession-target-frame-source-v1",
      jobId,
      runId: "88888888-8888-4888-8888-888888888888",
      jobPayloadSha256: "B".repeat(64),
      attempt: fixtureInput.attempt,
      skillId: fixtureInput.skillId,
      entryIndex: fixtureInput.entryIndex,
      frameIndex: fixtureInput.frameIndex,
      width: 2,
      height: 2,
      sourceDecodedBgraSha256: "C".repeat(64),
      sourceAlphaSha256: options?.expectedAlphaSha256 ?? sha256(alpha),
      targetPolicy: "generate-same-size",
      deploymentAuthorized: false,
    },
    expected: {
      width: 2,
      height: 2,
      sourceAlphaSha256: options?.expectedAlphaSha256 ?? sha256(alpha),
    },
  };
  return {
    input: fixtureInput,
    read,
    stored: {
      objectKey: read.read.objectKey,
      mediaType: "image/png",
      byteLength: bytes.byteLength,
      sha256: sourceSha256,
      bytes,
    },
    view: {
      schemaVersion: 1,
      status: "registered",
      skillId: fixtureInput.skillId,
      entryIndex: fixtureInput.entryIndex,
      frameIndex: fixtureInput.frameIndex,
      sourceArtifactId: fixtureInput.sourceArtifactId,
      sourceByteLength: fixtureInput.sourceByteLength,
      sourceSha256,
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}
