/** @fileoverview 使用窄端口 mock 验证 Artist 模型出站、对象持久化和幂等恢复顺序。
 */
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ObjectStorageEvidence,
  ObjectStoragePort,
} from "../../../src/common/storage/object-storage.client.js";
import { sha256JcsV1 } from "../../../src/common/utils/canonical.js";
import type { ModelCallView } from "../../../src/modules/openai/openai.contracts.js";
import { createProfessionEngineerStylePlan } from "../../../src/modules/job/profession-engineer-plan.js";
import type { RequestProfessionSkillExecutionInput } from "../../../src/modules/job/profession-execution.contracts.js";
import type { FrozenProfessionSkillExecutionContext } from "../../../src/modules/job/profession-execution-context.js";
import { ProfessionExecutionService } from "../../../src/modules/job/profession-execution.service.js";
import {
  createFlatOpaquePng,
  createTransparentReferencePng,
} from "./fixtures/profession-reference-image.fixture.js";

const jobId = "00000000-0000-4000-8000-000000000000";
const executionId = "11111111-1111-4111-8111-111111111111";
const modelCallId = "22222222-2222-4222-8222-222222222222";
const imageAttemptId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const skillId = "66666666-6666-4666-8666-666666666666";
const engineerExecutionId = "12121212-1212-4212-8212-121212121212";
const engineerModelCallId = "13131313-1313-4313-8313-131313131313";
const engineerArtifactId = "14141414-1414-4414-8414-141414141414";
const engineerSha256 = "E".repeat(64);
const png = await createTransparentReferencePng();
const flatOpaquePng = await createFlatOpaquePng();
const pngSha256 = createHash("sha256").update(png).digest("hex").toUpperCase();
type ExecutionRepositoryPort = ConstructorParameters<
  typeof ProfessionExecutionService
>[0];
type EngineerExecutionPort = ConstructorParameters<
  typeof ProfessionExecutionService
>[1];
type FixedImageModelPort = ConstructorParameters<
  typeof ProfessionExecutionService
>[2];

describe("ProfessionExecutionService", () => {
  const reserveProfessionSkillModelExecution =
    vi.fn<ExecutionRepositoryPort["reserveProfessionSkillModelExecution"]>();
  const bindProfessionModelCallBeforeEgress =
    vi.fn<ExecutionRepositoryPort["bindProfessionModelCallBeforeEgress"]>();
  const prepareProfessionModelOutputPersistence =
    vi.fn<ExecutionRepositoryPort["prepareProfessionModelOutputPersistence"]>();
  const finalizeProfessionModelOutput =
    vi.fn<ExecutionRepositoryPort["finalizeProfessionModelOutput"]>();
  const failProfessionModelExecution =
    vi.fn<ExecutionRepositoryPort["failProfessionModelExecution"]>();
  const executions = {
    reserveProfessionSkillModelExecution,
    bindProfessionModelCallBeforeEgress,
    prepareProfessionModelOutputPersistence,
    finalizeProfessionModelOutput,
    failProfessionModelExecution,
  };
  const engineerExecute = vi.fn<EngineerExecutionPort["executeSkill"]>();
  const engineer = { executeSkill: engineerExecute };
  const modelImage = vi.fn<FixedImageModelPort["image"]>();
  const models = { image: modelImage };
  const storageWrite = vi.fn<ObjectStoragePort["write"]>();
  const storageVerify = vi.fn<ObjectStoragePort["verify"]>();
  const storageRead = vi.fn<ObjectStoragePort["readVerifiedBytes"]>();
  const storage: ObjectStoragePort = {
    authorizeUpload: vi.fn(),
    authorizeDownload: vi.fn(),
    write: storageWrite,
    readVerifiedBytes: storageRead,
    verify: storageVerify,
    delete: vi.fn(),
  };
  let service: ProfessionExecutionService;

  beforeEach(() => {
    vi.resetAllMocks();
    bindProfessionModelCallBeforeEgress.mockResolvedValue("accepted");
    prepareProfessionModelOutputPersistence.mockResolvedValue("accepted");
    finalizeProfessionModelOutput.mockResolvedValue("accepted");
    failProfessionModelExecution.mockResolvedValue(true);
    engineerExecute.mockResolvedValue(engineerPassed());
    storageWrite.mockResolvedValue(storageEvidence());
    storageVerify.mockResolvedValue(storageEvidence());
    storageRead.mockResolvedValue({
      objectKey: sourceVisualInput().objectKey,
      mediaType: "image/png",
      byteLength: png.byteLength,
      sha256: pngSha256,
      bytes: png,
    });
    modelImage.mockImplementation(async (_request, beforeEgress) => {
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
      return { bytes: png, record: { ...record, status: "passed" } };
    });
    service = new ProfessionExecutionService(
      executions,
      engineer,
      models,
      storage,
      {
        maxRunBytes: 1024,
        sessionTtlSeconds: 300,
      },
    );
  });

  it("executes one fixed model call and returns only persisted evidence", async () => {
    reserveProfessionSkillModelExecution.mockResolvedValue({
      status: "execute",
      executionId,
      context: frozenContext(),
      sourceVisualInput: sourceVisualInput(),
    });
    const result = await service.executeSkill(jobId, leaseInput());
    expect(engineerExecute).toHaveBeenCalledWith(
      jobId,
      leaseInput(),
      expect.objectContaining({
        status: "passed",
        executionId,
        modelCallId,
      }),
    );
    const imageRequest = modelImage.mock.calls[0]?.[0];
    if (!imageRequest) throw new Error("TEST_IMAGE_REQUEST_REQUIRED");
    expect(imageRequest.prompt).toContain("official representative frame");
    expect(imageRequest.prompt).toMatch(
      /continuous fine energy bands[\s\S]*Avoid grain[\s\S]*repeated narrow parallel stripes/,
    );
    expect(imageRequest.prompt).toContain("transparent background");
    expect(imageRequest.prompt).toContain("uniform neutral #080808 matte");
    expect(imageRequest.prompt).toContain(
      "will not be copied directly into runtime frames",
    );
    expect(imageRequest.sourceImage).toMatchObject({
      role: "official-source",
      mediaType: "image/png",
      sha256: pngSha256,
    });
    expect(bindProfessionModelCallBeforeEgress).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "reference-image-v3",
      modelCallId,
    );
    expect(prepareProfessionModelOutputPersistence).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "reference-image-v3",
      {
        modelCallId,
        outputSha256: pngSha256,
        outputByteLength: png.byteLength,
      },
      1024,
    );
    expect(storageWrite).toHaveBeenCalledWith({
      objectKey: `artifacts/profession-${executionId}-reference.png`,
      mediaType: "image/png",
      bytes: png,
      sha256: pngSha256,
    });
    const finalizedOutput = finalizeProfessionModelOutput.mock.calls[0]?.[2];
    if (!finalizedOutput) throw new Error("TEST_FINALIZED_OUTPUT_REQUIRED");
    if (finalizedOutput.stage !== "reference-image-v3") {
      throw new Error("TEST_REFERENCE_FINALIZE_REQUIRED");
    }
    expect(finalizedOutput).toMatchObject({
      modelCallId,
      storageKey: `artifacts/profession-${executionId}-reference.png`,
      mediaType: "image/png",
      outputSha256: pngSha256,
      adapterIdentity:
        "openai-image/runtime-rgb-reference-v7-plan-v3-alpha-normalized",
      inputSnapshotSha256: sha256JcsV1({
        schemaVersion: 2,
        sourceEvidence: frozenContext().skill.sourceEvidence,
        sourceVisualInput: leaseInput().sourceVisualInput,
      }),
    });
    expect(finalizedOutput.artifactId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(finalizedOutput.imageAttemptId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result).toEqual({
      status: "passed",
      engineerPlan: {
        executionId: engineerExecutionId,
        modelCallId: engineerModelCallId,
        outputArtifactId: engineerArtifactId,
        mediaType: "application/json",
        byteLength: 512,
        sha256: engineerSha256,
      },
      referenceImage: {
        executionId,
        modelCallId,
        imageAttemptId: finalizedOutput.imageAttemptId,
        outputArtifactId: finalizedOutput.artifactId,
        mediaType: "image/png",
        byteLength: png.byteLength,
        sha256: pngSha256,
      },
    });
    expect(result).not.toHaveProperty("bytes");
    expect(result).not.toHaveProperty("objectKey");
    expect(result).not.toHaveProperty("prompt");
  });
  it("returns an existing passed execution without model or storage I/O", async () => {
    reserveProfessionSkillModelExecution.mockResolvedValue({
      status: "passed",
      stage: "reference-image-v3",
      executionId,
      modelCallId,
      imageAttemptId,
      outputArtifactId: artifactId,
      outputSha256: pngSha256,
      outputByteLength: png.byteLength,
    });
    await expect(service.executeSkill(jobId, leaseInput())).resolves.toEqual({
      status: "passed",
      engineerPlan: {
        executionId: engineerExecutionId,
        modelCallId: engineerModelCallId,
        outputArtifactId: engineerArtifactId,
        mediaType: "application/json",
        byteLength: 512,
        sha256: engineerSha256,
      },
      referenceImage: {
        executionId,
        modelCallId,
        imageAttemptId,
        outputArtifactId: artifactId,
        mediaType: "image/png",
        byteLength: png.byteLength,
        sha256: pngSha256,
      },
    });
    expect(modelImage).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(storageVerify).not.toHaveBeenCalled();
  });
  it("returns in-progress without repeating an uncertain model egress", async () => {
    reserveProfessionSkillModelExecution.mockResolvedValue({
      status: "in-progress",
      executionId,
    });
    await expect(service.executeSkill(jobId, leaseInput())).resolves.toEqual({
      status: "in-progress",
      executionId,
    });
    expect(modelImage).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
  });
  it("never calls Engineer while Artist is in-progress", async () => {
    reserveProfessionSkillModelExecution.mockResolvedValue({
      status: "in-progress",
      executionId,
    });
    await expect(service.executeSkill(jobId, leaseInput())).resolves.toEqual({
      status: "in-progress",
      executionId,
    });
    expect(engineerExecute).not.toHaveBeenCalled();
    expect(modelImage).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
  });
  it("recovers a persistence-pending execution using only object verification", async () => {
    reserveProfessionSkillModelExecution.mockResolvedValue({
      status: "persistence-pending",
      executionId,
      modelCallId,
      outputSha256: pngSha256,
      outputByteLength: png.byteLength,
      context: frozenContext(),
    });
    const result = await service.executeSkill(jobId, leaseInput());
    expect(modelImage).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(storageVerify).toHaveBeenCalledWith({
      objectKey: `artifacts/profession-${executionId}-reference.png`,
      expectedMediaType: "image/png",
      expectedByteLength: png.byteLength,
      expectedSha256: pngSha256,
    });
    expect(result.status).toBe("passed");
  });
  it("fails the execution when the model does not return a passed image", async () => {
    reserveProfessionSkillModelExecution.mockResolvedValue({
      status: "execute",
      executionId,
      context: frozenContext(),
      sourceVisualInput: sourceVisualInput(),
    });
    modelImage.mockResolvedValue({
      record: {
        ...modelRecord(),
        status: "failed",
        errorCode: "MODEL_PROVIDER_REQUEST_FAILED",
      },
    });
    await expect(
      service.executeSkill(jobId, leaseInput()),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(failProfessionModelExecution).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "reference-image-v3",
      "MODEL_PROVIDER_REQUEST_FAILED",
      false,
      modelCallId,
    );
    expect(storageWrite).not.toHaveBeenCalled();
  });
  it.each([
    {
      label: "non-PNG bytes",
      bytes: Buffer.from("not-png"),
      code: "PROFESSION_MODEL_OUTPUT_NOT_PNG",
    },
    {
      label: "an opaque flat canvas",
      bytes: flatOpaquePng,
      code: "PROFESSION_MODEL_OUTPUT_TRANSPARENCY_INVALID",
    },
  ])("rejects $label before Artifact persistence", async ({ bytes, code }) => {
    reserveProfessionSkillModelExecution.mockResolvedValue({
      status: "execute",
      executionId,
      context: frozenContext(),
      sourceVisualInput: sourceVisualInput(),
    });
    modelImage.mockResolvedValue({
      bytes,
      record: { ...modelRecord(), status: "passed" },
    });
    const failure = service.executeSkill(jobId, leaseInput());
    await expect(failure).rejects.toBeInstanceOf(ConflictException);
    await expect(failure).rejects.toMatchObject({ response: { code } });
    expect(failProfessionModelExecution).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "reference-image-v3",
      code,
      false,
      modelCallId,
    );
    expect(prepareProfessionModelOutputPersistence).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(finalizeProfessionModelOutput).not.toHaveBeenCalled();
  });
});

function leaseInput(): RequestProfessionSkillExecutionInput {
  return {
    workerId: "77777777-7777-4777-8777-777777777777",
    leaseId: "88888888-8888-4888-8888-888888888888",
    attempt: 2,
    skillId,
    sourceVisualInput: {
      artifactId: "abababab-abab-4bab-8bab-abababababab",
      mediaType: "image/png",
      byteLength: png.byteLength,
      sha256: pngSha256,
      frameMapSha256: "D".repeat(64),
    },
  };
}

function sourceVisualInput(): {
  artifactId: string;
  objectKey: string;
  mediaType: "image/png";
  byteLength: number;
  sha256: string;
  frameMapSha256: string;
} {
  return {
    artifactId: leaseInput().sourceVisualInput.artifactId,
    objectKey: "artifacts/source-visual.png",
    mediaType: "image/png" as const,
    byteLength: png.byteLength,
    sha256: pngSha256,
    frameMapSha256: leaseInput().sourceVisualInput.frameMapSha256,
  };
}

function modelRecord(): ModelCallView {
  return {
    id: modelCallId,
    runId,
    role: "artist",
    model: "reference-model",
    endpointIdentity: "models.example.test/v1",
    modelConfigurationVersion: 1,
    requestSha256: "A".repeat(64),
    responseSha256: pngSha256,
    status: "running",
    modelEgressAuthorized: true,
    modelEgressPerformed: false,
    createdAtUtc: "2026-07-24T00:00:00.000Z",
  };
}

function storageEvidence(): ObjectStorageEvidence {
  return {
    objectKey: `artifacts/profession-${executionId}-reference.png`,
    mediaType: "image/png",
    byteLength: png.byteLength,
    sha256: pngSha256,
  };
}

function engineerPassed(): Extract<
  Awaited<ReturnType<EngineerExecutionPort["executeSkill"]>>,
  { status: "passed" }
> {
  return {
    status: "passed" as const,
    executionId: engineerExecutionId,
    modelCallId: engineerModelCallId,
    outputArtifactId: engineerArtifactId,
    byteLength: 512,
    sha256: engineerSha256,
    plan: createProfessionEngineerStylePlan({
      schemaVersion: 2,
      referenceBounds: {
        left: 0.03,
        top: 0.02,
        right: 0.97,
        bottom: 0.98,
      },
    }),
  };
}

function frozenContext(): FrozenProfessionSkillExecutionContext {
  return {
    contractVersion: 1,
    runId,
    profileId: "profile-v2",
    professionId: "99999999-9999-4999-8999-999999999999",
    styleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    themeDefinition: {
      schemaVersion: 1,
      goal: "统一暗蓝剑气主题",
      baseStyle: "深钴蓝像素剑气",
      colorAnchors: [{ name: "主色", value: "#123456" }],
      materialRules: "保留清晰边缘",
      particleRules: "粒子遵循源帧节奏",
      layeringRules: "不改变层级语义",
      constraints: "不新增角色本体",
      acceptanceCriteria: "轮廓和时间轴可辨识",
      exclusions: "不修改命中范围",
    },
    skill: {
      skillId,
      professionPrompt: {
        schemaVersion: 1,
        stableSemantics: "保留技能身份",
        commonPrompt: "保持源帧轮廓",
        sourceConstraints: "只处理已核验来源",
        stageAcceptance: "逐帧满足来源约束",
      },
      professionPromptSha256: "B".repeat(64),
      skillThemePrompt: {
        skillId,
        themePrompt: "暗蓝月牙剑气",
        changes: "调整材质与粒子颜色",
        acceptanceCriteria: "保持动作节奏",
        exclusions: "不增加人物内容",
      },
      promptSha256: "C".repeat(64),
      sourceEvidence: {
        sourceRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sourceInventoryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sourceFrameManifestArtifactId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        sourceEntries: [
          {
            sourceInventoryEntryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            sourceMetadataSha256: "D".repeat(64),
          },
        ],
      },
    },
  };
}
