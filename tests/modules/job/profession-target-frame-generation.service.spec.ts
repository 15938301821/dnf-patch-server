/**
 * @fileoverview 使用真实Sharp像素处理和窄端口mock验证V6单帧模型出站、同尺寸/同Alpha正规化、
 * 对象持久化及恢复顺序；不连接真实MySQL、MinIO或外部图片模型。
 *
 * 调用关系：测试直接调用真实Generation Service与正规化器；Repository mock模拟短事务状态，模型
 * mock执行beforeEgress门禁并返回实际PNG，ObjectStorage mock保存真实正规化字节。
 * 安全边界：本测试证明Service不会在in-progress/persisting时重复出站，但真实行锁、外键、Provider
 * 画布遵循度与网络故障仍需MySQL集成测试和R2真实运行证明。
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectStoragePort } from "../../../src/common/storage/object-storage.client.js";
import type { ModelCallView } from "../../../src/modules/openai/openai.contracts.js";
import {
  createImageTargetGeometry,
  selectRequestedImageCanvas,
} from "../../../src/modules/openai/image-target-geometry.js";
import type { FrozenProfessionSkillExecutionContext } from "../../../src/modules/job/profession-execution-context.js";
import type { GenerateProfessionTargetFrameInput } from "../../../src/modules/job/profession-target-frame-generation.contracts.js";
import type { ProfessionTargetFrameGenerationContext } from "../../../src/modules/job/profession-target-frame-generation.js";
import {
  ProfessionTargetFrameGenerationService,
  targetFrameObjectKey,
} from "../../../src/modules/job/profession-target-frame-generation.service.js";

const jobId = "00000000-0000-4000-8000-000000000000";
const runId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const modelCallId = "33333333-3333-4333-8333-333333333333";
const sourceArtifactId = "44444444-4444-4444-8444-444444444444";
const skillId = "55555555-5555-4555-8555-555555555555";
const sourceAlpha = Buffer.from([0, 64, 128, 255]);
const sourcePng = await createSourcePng();
const providerPng = await createProviderPng();
const sourceSha256 = sha256(sourcePng);
const sourceAlphaSha256 = sha256(sourceAlpha);

type GenerationRepositoryPort = ConstructorParameters<
  typeof ProfessionTargetFrameGenerationService
>[0];
type TargetFrameModelPort = ConstructorParameters<
  typeof ProfessionTargetFrameGenerationService
>[1];

describe("ProfessionTargetFrameGenerationService", () => {
  const inspect = vi.fn<GenerationRepositoryPort["inspect"]>();
  const reserve = vi.fn<GenerationRepositoryPort["reserve"]>();
  const bindModelCallBeforeEgress =
    vi.fn<GenerationRepositoryPort["bindModelCallBeforeEgress"]>();
  const preparePersistence =
    vi.fn<GenerationRepositoryPort["preparePersistence"]>();
  const finalize = vi.fn<GenerationRepositoryPort["finalize"]>();
  const block = vi.fn<GenerationRepositoryPort["block"]>();
  const generations = {
    inspect,
    reserve,
    bindModelCallBeforeEgress,
    preparePersistence,
    finalize,
    block,
  };
  const image = vi.fn<TargetFrameModelPort["image"]>();
  const readVerifiedBytes = vi.fn<ObjectStoragePort["readVerifiedBytes"]>();
  const write = vi.fn<ObjectStoragePort["write"]>();
  const verify = vi.fn<ObjectStoragePort["verify"]>();
  const storage = {
    authorizeUpload: vi.fn(),
    authorizeDownload: vi.fn(),
    write,
    verify,
    readVerifiedBytes,
    delete: vi.fn(),
  } satisfies ObjectStoragePort;
  let service: ProfessionTargetFrameGenerationService;

  beforeEach(() => {
    vi.resetAllMocks();
    bindModelCallBeforeEgress.mockResolvedValue("accepted");
    preparePersistence.mockResolvedValue("accepted");
    finalize.mockResolvedValue("accepted");
    block.mockResolvedValue(true);
    readVerifiedBytes.mockResolvedValue({
      objectKey: generationContext().sourceImage.objectKey,
      mediaType: "image/png",
      byteLength: sourcePng.byteLength,
      sha256: sourceSha256,
      bytes: sourcePng,
    });
    write.mockImplementation((request) =>
      Promise.resolve({
        objectKey: request.objectKey,
        mediaType: request.mediaType,
        byteLength: request.bytes.byteLength,
        sha256: sha256(request.bytes),
      }),
    );
    image.mockImplementation(async (request, beforeEgress) => {
      if (!beforeEgress) throw new Error("TEST_BEFORE_EGRESS_REQUIRED");
      const record = modelRecord();
      if ((await beforeEgress(record)) !== "accepted") {
        return {
          record: {
            ...record,
            status: "failed",
            errorCode: "MODEL_EGRESS_GUARD_REJECTED",
          },
        };
      }
      const requested = selectRequestedImageCanvas(request.targetDimensions);
      return {
        bytes: providerPng,
        targetGeometry: createImageTargetGeometry(
          request.targetDimensions,
          requested,
          { width: 4, height: 4 },
        ),
        record: { ...record, status: "passed" },
      };
    });
    service = new ProfessionTargetFrameGenerationService(
      generations,
      { image },
      storage,
      { maxRunBytes: 1024 * 1024, sessionTtlSeconds: 300 },
    );
  });

  it("只出站一次并把Provider画布正规化为官方尺寸与Alpha", async () => {
    const generation = generationContext();
    inspect.mockResolvedValue({ status: "new", generation });
    reserve.mockResolvedValue({ status: "execute", generation });

    const result = await service.generate(jobId, leaseInput());

    expect(image).toHaveBeenCalledOnce();
    expect(readVerifiedBytes).toHaveBeenCalledWith({
      objectKey: generation.sourceImage.objectKey,
      expectedMediaType: generation.sourceImage.expectedMediaType,
      expectedByteLength: generation.sourceImage.expectedByteLength,
      expectedSha256: generation.sourceImage.expectedSha256,
      maxByteLength: generation.sourceImage.maxByteLength,
    });
    expect(image.mock.calls[0]?.[0]).toMatchObject({
      runId,
      role: "artist",
      targetDimensions: { width: 2, height: 2 },
      sourceImage: {
        role: "official-source",
        mediaType: "image/png",
        sha256: sourceSha256,
      },
    });
    expect(image.mock.calls[0]?.[0].prompt).toContain('"frameIndex":7');
    expect(bindModelCallBeforeEgress).toHaveBeenCalledWith(
      jobId,
      targetId,
      leaseInput(),
      modelCallId,
    );
    expect(preparePersistence).toHaveBeenCalledWith(
      jobId,
      targetId,
      leaseInput(),
      expect.objectContaining({
        modelCallId,
        normalizationAlgorithm:
          "centered-exact-aspect-lanczos3-source-alpha-v1",
      }),
      1024 * 1024,
    );
    expect(write).toHaveBeenCalledOnce();
    const writeRequest = write.mock.calls[0]?.[0];
    if (!writeRequest) throw new Error("TEST_TARGET_WRITE_REQUIRED");
    expect(writeRequest.objectKey).toBe(targetFrameObjectKey(targetId));
    const decoded = await sharp(Buffer.from(writeRequest.bytes))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 2, height: 2, channels: 4 });
    expect(extractAlpha(decoded.data)).toEqual(sourceAlpha);

    const finalized = finalize.mock.calls[0]?.[3];
    if (!finalized) throw new Error("TEST_TARGET_FINALIZE_REQUIRED");
    expect(finalized).toMatchObject({
      modelCallId,
      storageKey: targetFrameObjectKey(targetId),
      mediaType: "image/png",
      adapterIdentity:
        "openai-image/profession-target-frame-v1-source-alpha-normalized",
      provenance: {
        kind: "profession-target-frame-output-v1",
        sourceArtifactId,
        sourceAlphaSha256,
        width: 2,
        height: 2,
        safety: {
          sourceGeometryPreserved: true,
          sourceAlphaPreserved: true,
          targetDimensionsEqualSource: true,
          directRuntimeUseAllowed: false,
          deploymentAuthorized: false,
          deploymentPerformed: false,
          fullSkillCoverageProven: false,
          clientCompatibilityProven: false,
        },
      },
    });
    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      skillId,
      entryIndex: 3,
      frameIndex: 7,
      modelCallId,
      targetArtifactId: finalized.artifactId,
      width: 2,
      height: 2,
      sourceAlphaSha256,
    });
    expect(result).not.toHaveProperty("prompt");
    expect(result).not.toHaveProperty("objectKey");
    expect(result).not.toHaveProperty("bytes");
  });

  it("persisting恢复只复读确定性对象且不重复模型", async () => {
    const generation = generationContext();
    const outputSha256 = "E".repeat(64);
    inspect.mockResolvedValue({
      status: "persistence-pending",
      generation,
      modelCallId,
      outputSha256,
      outputByteLength: 321,
    });
    verify.mockResolvedValue({
      objectKey: targetFrameObjectKey(targetId),
      mediaType: "image/png",
      byteLength: 321,
      sha256: outputSha256,
    });

    await expect(service.generate(jobId, leaseInput())).resolves.toMatchObject({
      status: "passed",
      modelCallId,
      sha256: outputSha256,
      byteLength: 321,
    });
    expect(verify).toHaveBeenCalledWith({
      objectKey: targetFrameObjectKey(targetId),
      expectedMediaType: "image/png",
      expectedByteLength: 321,
      expectedSha256: outputSha256,
    });
    expect(readVerifiedBytes).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("in-progress只返回状态且不读取图片或重复出站", async () => {
    inspect.mockResolvedValue({
      schemaVersion: 1,
      status: "in-progress",
      skillId,
      entryIndex: 3,
      frameIndex: 7,
    });

    await expect(service.generate(jobId, leaseInput())).resolves.toEqual({
      schemaVersion: 1,
      status: "in-progress",
      skillId,
      entryIndex: 3,
      frameIndex: 7,
    });
    expect(readVerifiedBytes).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
  });

  it("官方PNG读取失败发生在reserve前并保持可重试", async () => {
    const generation = generationContext();
    inspect.mockResolvedValue({ status: "new", generation });
    readVerifiedBytes.mockRejectedValue(new Error("storage detail"));

    await expect(service.generate(jobId, leaseInput())).rejects.toMatchObject({
      response: { code: "PROFESSION_TARGET_FRAME_SOURCE_UNAVAILABLE" },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    expect(block).not.toHaveBeenCalled();
  });
});

function leaseInput(): GenerateProfessionTargetFrameInput {
  return {
    workerId: "66666666-6666-4666-8666-666666666666",
    leaseId: "77777777-7777-4777-8777-777777777777",
    attempt: 2,
    skillId,
    entryIndex: 3,
    frameIndex: 7,
  };
}

function generationContext(): ProfessionTargetFrameGenerationContext {
  return {
    targetId,
    runId,
    context: frozenContext(),
    sourceImage: {
      artifactId: sourceArtifactId,
      objectKey: "artifacts/source-frame.png",
      expectedMediaType: "image/png",
      expectedByteLength: sourcePng.byteLength,
      expectedSha256: sourceSha256,
      maxByteLength: 64 * 1024 * 1024,
    },
    target: {
      entryIndex: 3,
      frameIndex: 7,
      width: 2,
      height: 2,
      sourceSha256,
      sourceAlphaSha256,
    },
  };
}

function frozenContext(): FrozenProfessionSkillExecutionContext {
  return {
    contractVersion: 2,
    runId,
    profileId: "aseprite-production-v6",
    professionId: "88888888-8888-4888-8888-888888888888",
    styleId: "99999999-9999-4999-8999-999999999999",
    themeDefinition: {
      schemaVersion: 1,
      goal: "维吉尔风格剑气",
      baseStyle: "冷白与深蓝的高对比剑气",
      colorAnchors: [{ name: "主色", value: "#DDEEFF" }],
      materialRules: "清晰刀锋与受控辉光",
      particleRules: "粒子服从当前动作相位",
      layeringRules: "不改变源帧轮廓层级",
      constraints: "不新增人物或武器",
      acceptanceCriteria: "缩小后仍可辨识技能身份",
      exclusions: "不改变命中范围",
    },
    skill: {
      skillId,
      professionPrompt: {
        schemaVersion: 1,
        stableSemantics: "保留幻影剑舞动作与技能身份",
        commonPrompt: "保持源帧轮廓和方向",
        sourceConstraints: "只处理已冻结官方帧",
        stageAcceptance: "逐帧满足来源几何和Alpha",
      },
      professionPromptSha256: "A".repeat(64),
      skillThemePrompt: {
        skillId,
        themePrompt: "维吉尔式冷白深蓝空间剑痕",
        changes: "只改变材质、色彩和粒子边缘",
        acceptanceCriteria: "动作相位与原帧一致",
        exclusions: "不增加人物内容",
      },
      promptSha256: "B".repeat(64),
      sourceEvidence: {
        sourceRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceInventoryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sourceFrameManifestArtifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sourceEntries: [
          {
            sourceInventoryEntryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            sourceMetadataSha256: "C".repeat(64),
          },
        ],
      },
    },
    targetFramePolicy: {
      schemaVersion: 1,
      dimensions: "source-frame-exact",
      alpha: "source-frame-exact",
      hiddenFrames: "preserve-source",
      linkFrames: "reuse-link-target",
      maximumTargetFrameCount: 2_048,
      maximumTargetPixelCount: 134_217_728,
    },
  };
}

function modelRecord(): ModelCallView {
  return {
    id: modelCallId,
    runId,
    role: "artist",
    model: "configured-image-model",
    endpointIdentity: "models.example.test/v1",
    modelConfigurationVersion: 3,
    requestSha256: "D".repeat(64),
    status: "running",
    modelEgressAuthorized: true,
    modelEgressPerformed: false,
    createdAtUtc: "2026-07-31T00:00:00.000Z",
  };
}

async function createSourcePng(): Promise<Buffer> {
  const rgba = Buffer.from([
    10,
    20,
    30,
    sourceAlpha[0] ?? 0,
    20,
    30,
    40,
    sourceAlpha[1] ?? 0,
    30,
    40,
    50,
    sourceAlpha[2] ?? 0,
    40,
    50,
    60,
    sourceAlpha[3] ?? 0,
  ]);
  return sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } })
    .png()
    .toBuffer();
}

async function createProviderPng(): Promise<Buffer> {
  const rgba = Buffer.alloc(4 * 4 * 4);
  for (let offset = 0; offset < rgba.byteLength; offset += 4) {
    rgba[offset] = 220;
    rgba[offset + 1] = 230;
    rgba[offset + 2] = 255;
    rgba[offset + 3] = 255;
  }
  return sharp(rgba, { raw: { width: 4, height: 4, channels: 4 } })
    .png()
    .toBuffer();
}

function extractAlpha(rgba: Uint8Array): Buffer {
  const alpha = Buffer.alloc(rgba.byteLength / 4);
  for (
    let sourceOffset = 3, targetOffset = 0;
    sourceOffset < rgba.byteLength;
    sourceOffset += 4, targetOffset += 1
  ) {
    alpha[targetOffset] = rgba[sourceOffset] ?? 0;
  }
  return alpha;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}
