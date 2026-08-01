/**
 * @fileoverview 验证 V6 target-frame prepare 的双对象事务外复读、逐帧绑定、幂等和稳定失败映射；
 * 不连接真实 MySQL、对象存储或 Worker，也不证明数据库锁竞争和自外键运行语义。
 * @module modules/job/profession-target-frame-prepare-service-spec
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：Vitest 以 Repository/ObjectStoragePort stub 调用真实 Service；fixture 生成真实历史 source
 * JSON.stringify 字节和 target JCS 字节。测试证明对象读取只发生在 read-required 分支、正文失败时零提交，
 * 但真实事务、S3 流和 MySQL 外键仍需各自集成测试证明。
 */
import { createHash } from "node:crypto";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectStoragePort } from "../../../src/common/storage/object-storage.client.js";
import { stableStringifyJcsV1 } from "../../../src/common/utils/canonical.js";
import type {
  PrepareProfessionTargetFramesInput,
  ProfessionTargetFrameManifestProvenance,
  ProfessionTargetFramePreparationView,
} from "../../../src/modules/job/profession-target-frame-prepare.contracts.js";
import type {
  InspectProfessionTargetFramesResult,
  ProfessionTargetFramePreparationRead,
} from "../../../src/modules/job/profession-target-frame-prepare.repository.js";
import { ProfessionTargetFramePrepareService } from "../../../src/modules/job/profession-target-frame-prepare.service.js";
import type { ProfessionSourceFrameManifest } from "../../../src/modules/job/profession-source-frame-manifest.js";
import type { ProfessionTargetFrameManifest } from "../../../src/modules/job/profession-target-frame-manifest.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";
const leaseId = "44444444-4444-4444-8444-444444444444";
const skillId = "55555555-5555-4555-8555-555555555555";
const manifestArtifactId = "66666666-6666-4666-8666-666666666666";
const sourceRunId = "77777777-7777-4777-8777-777777777777";
const sourceInventoryId = "88888888-8888-4888-8888-888888888888";
const sourceManifestArtifactId = "99999999-9999-4999-8999-999999999999";
const sourceSha256 = "A".repeat(64);
const sourceToolSha256 = "B".repeat(64);
const decodedBgraSha256 = "C".repeat(64);
const sourceAlphaSha256 = "D".repeat(64);

type PrepareRepositoryPort = ConstructorParameters<
  typeof ProfessionTargetFramePrepareService
>[0];

describe("ProfessionTargetFramePrepareService", () => {
  const inspect = vi.fn<PrepareRepositoryPort["inspect"]>();
  const commit = vi.fn<PrepareRepositoryPort["commit"]>();
  const readVerifiedBytes = vi.fn<ObjectStoragePort["readVerifiedBytes"]>();
  const storage: ObjectStoragePort = {
    authorizeUpload: vi.fn(),
    authorizeDownload: vi.fn(),
    write: vi.fn(),
    verify: vi.fn(),
    readVerifiedBytes,
    delete: vi.fn(),
  };
  let service: ProfessionTargetFramePrepareService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new ProfessionTargetFramePrepareService(
      { inspect, commit },
      storage,
    );
  });

  it("完整已有行幂等返回且不再次读取对象或提交", async () => {
    // 已有完整行集由 Repository 在短事务内证明，重复读取私有对象只会扩大失败面和 I/O。
    const fixture = validFixture();
    inspect.mockResolvedValue({
      status: "prepared",
      preparation: fixture.preparation,
    });

    await expect(service.prepare(jobId, fixture.input)).resolves.toEqual(
      fixture.preparation,
    );
    expect(readVerifiedBytes).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("在事务外复读并绑定两份合法清单后只提交一次", async () => {
    const fixture = validFixture();
    inspect.mockResolvedValue({
      status: "read-required",
      read: fixture.read,
    } satisfies InspectProfessionTargetFramesResult);
    readVerifiedBytes.mockImplementation((request) => {
      const bytes =
        request.objectKey === fixture.read.target.objectKey
          ? fixture.targetBytes
          : fixture.sourceBytes;
      return Promise.resolve({
        objectKey: request.objectKey,
        mediaType: request.expectedMediaType,
        byteLength: bytes.byteLength,
        sha256: request.expectedSha256,
        bytes,
      });
    });
    commit.mockResolvedValue({
      status: "prepared",
      preparation: fixture.preparation,
    });

    await expect(service.prepare(jobId, fixture.input)).resolves.toEqual(
      fixture.preparation,
    );
    expect(readVerifiedBytes).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(
      jobId,
      fixture.input,
      fixture.targetManifest,
      fixture.read,
    );
  });

  it("target 正文与官方帧几何不一致时拒绝且不提交", async () => {
    // Artifact 摘要本身不能证明 Worker 派生内容正确；逐帧 source 绑定失败后数据库必须保持零写入。
    const fixture = validFixture({ targetCanvasWidth: 7 });
    inspect.mockResolvedValue({
      status: "read-required",
      read: fixture.read,
    });
    readVerifiedBytes.mockImplementation((request) => {
      const bytes =
        request.objectKey === fixture.read.target.objectKey
          ? fixture.targetBytes
          : fixture.sourceBytes;
      return Promise.resolve({
        objectKey: request.objectKey,
        mediaType: request.expectedMediaType,
        byteLength: bytes.byteLength,
        sha256: request.expectedSha256,
        bytes,
      });
    });

    await expect(service.prepare(jobId, fixture.input)).rejects.toMatchObject({
      response: { code: "PROFESSION_TARGET_FRAME_MANIFEST_INVALID" },
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("对象存储不可用时返回稳定 503 且不提交", async () => {
    const fixture = validFixture();
    inspect.mockResolvedValue({
      status: "read-required",
      read: fixture.read,
    });
    readVerifiedBytes.mockRejectedValue(new Error("provider detail"));

    try {
      await service.prepare(jobId, fixture.input);
      throw new Error("TEST_EXPECTED_EXCEPTION");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(
        (error as ServiceUnavailableException).getResponse(),
      ).toMatchObject({ code: "PROFESSION_TARGET_FRAME_STORAGE_UNAVAILABLE" });
    }
    expect(commit).not.toHaveBeenCalled();
  });

  it("Repository 证据冲突映射为稳定错误且不读取对象", async () => {
    const fixture = validFixture();
    inspect.mockResolvedValue({ status: "preparation-conflict" });

    try {
      await service.prepare(jobId, fixture.input);
      throw new Error("TEST_EXPECTED_EXCEPTION");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: "PROFESSION_TARGET_FRAME_PREPARATION_CONFLICT",
      });
    }
    expect(readVerifiedBytes).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

function validFixture(options?: { targetCanvasWidth?: number }): {
  input: PrepareProfessionTargetFramesInput;
  preparation: ProfessionTargetFramePreparationView;
  read: ProfessionTargetFramePreparationRead;
  sourceBytes: Uint8Array;
  targetBytes: Uint8Array;
  targetManifest: ProfessionTargetFrameManifest;
} {
  const sourceManifest = sourceFrameManifest();
  const sourceBytes = Buffer.from(JSON.stringify(sourceManifest), "utf8");
  const sourceFrameManifestSha256 = sha256(sourceBytes);
  const targetManifest: ProfessionTargetFrameManifest = {
    schemaVersion: 1,
    kind: "profession-target-frame-manifest-v1",
    sourceSha256,
    sourceFrameManifestSha256,
    targetFrameCount: 1,
    targetPixelCount: 12,
    entries: [
      {
        entryIndex: 0,
        internalPath: sourceManifest.entries[0]?.internalPath ?? "",
        imgVersion: 5,
        frames: [
          {
            frameIndex: 0,
            type: "ARGB_8888",
            compressMode: "ZLIB",
            hidden: false,
            width: 4,
            height: 3,
            canvasWidth: options?.targetCanvasWidth ?? 6,
            canvasHeight: 5,
            x: 1,
            y: 1,
            targetPolicy: "generate-same-size",
            linkTargetIndex: null,
            sourceDecodedBgraSha256: decodedBgraSha256,
            sourceAlphaSha256,
          },
        ],
      },
    ],
    safety: {
      sourceGeometryAuthoritative: true,
      sourceAlphaAuthoritative: true,
      targetDimensionsEqualSource: true,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
  };
  const targetBytes = Buffer.from(stableStringifyJcsV1(targetManifest), "utf8");
  const targetSha256 = sha256(targetBytes);
  const input: PrepareProfessionTargetFramesInput = {
    workerId,
    leaseId,
    attempt: 2,
    skillId,
    manifestArtifactId,
    manifestMediaType: "application/json",
    manifestByteLength: targetBytes.byteLength,
    manifestSha256: targetSha256,
  };
  const provenance: ProfessionTargetFrameManifestProvenance = {
    schemaVersion: 1,
    kind: "profession-target-frame-manifest-v1",
    jobId,
    runId,
    jobPayloadSha256: "E".repeat(64),
    attempt: 2,
    skillId,
    sourceRunId,
    sourceInventoryId,
    sourceFrameManifestArtifactId: sourceManifestArtifactId,
    sourceFrameManifestSha256,
    sourceSha256,
    frameCount: 1,
    targetFrameCount: 1,
    targetPixelCount: 12,
    deploymentAuthorized: false,
  };
  return {
    input,
    preparation: {
      schemaVersion: 1,
      status: "prepared",
      skillId,
      manifestArtifactId,
      frameCount: 1,
      targetFrameCount: 1,
      targetPixelCount: 12,
    },
    read: {
      target: {
        objectKey: "artifacts/target-manifest.json",
        expectedMediaType: "application/json",
        expectedByteLength: targetBytes.byteLength,
        expectedSha256: targetSha256,
        maxByteLength: 16 * 1024 * 1024,
      },
      source: {
        objectKey: "artifacts/source-manifest.json",
        expectedMediaType: "application/json",
        expectedByteLength: sourceBytes.byteLength,
        expectedSha256: sourceFrameManifestSha256,
        maxByteLength: 64 * 1024 * 1024,
      },
      targetProvenance: provenance,
      sourceByteLength: 123,
      sourceToolSha256,
      frozenEntries: [
        {
          sourceMetadataSha256: sourceManifest.entries[0]?.metadataSha256 ?? "",
        },
      ],
    },
    sourceBytes,
    targetBytes,
    targetManifest,
  };
}

function sourceFrameManifest(): ProfessionSourceFrameManifest {
  const entry = {
    internalPath: "sprite/effect/a.img",
    imgVersion: 5,
    frameCount: 1,
    linkCount: 0,
    hiddenCount: 0,
    metadataSha256: "",
    frames: [
      {
        index: 0,
        type: "ARGB_8888",
        compressMode: "ZLIB",
        hidden: false,
        linkTargetIndex: null,
        width: 4,
        height: 3,
        canvasWidth: 6,
        canvasHeight: 5,
        x: 1,
        y: 1,
        decodedBgraSha256,
      },
    ],
  };
  entry.metadataSha256 = sha256(
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        internalPath: entry.internalPath,
        imgVersion: entry.imgVersion,
        frameCount: entry.frameCount,
        linkCount: entry.linkCount,
        hiddenCount: entry.hiddenCount,
      }),
      "utf8",
    ),
  );
  return {
    schemaVersion: 1,
    kind: "source-frame-manifest",
    source: { label: "source.npk", byteLength: 123, sha256: sourceSha256 },
    tool: { sha256: sourceToolSha256 },
    safety: {
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
    entries: [entry],
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}
