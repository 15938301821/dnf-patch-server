/**
 * @fileoverview 验证单技能固定参考图编排的模型出站、对象持久化和幂等恢复顺序；不连接真实数据库、
 * 模型端点或对象存储，也不证明 Aseprite/NPK/客户端兼容或部署。
 * @module modules/job/profession-execution-service-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：Vitest 以 Repository/OpenAI/ObjectStorage 窄端口 stub 调用真实 Service。测试保护重复请求
 * 不能二次出站、persisting 只能回读恢复、输出 DTO 不含 Prompt/key/字节；事务和真实 I/O 另由各层测试证明。
 */
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ObjectStorageEvidence,
  ObjectStoragePort,
} from "../../common/storage/object-storage.client.js";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import type { ModelCallView } from "../openai/openai.contracts.js";
import { createProfessionEngineerStylePlan } from "./profession-engineer-plan.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import type { FrozenProfessionSkillExecutionContext } from "./profession-execution-context.js";
import { ProfessionExecutionService } from "./profession-execution.service.js";

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
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("test-png-body"),
]);
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
  const storage: ObjectStoragePort = {
    authorizeUpload: vi.fn(),
    authorizeDownload: vi.fn(),
    write: storageWrite,
    readVerifiedBytes: vi.fn(),
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
    });
    const result = await service.executeSkill(jobId, leaseInput());

    expect(engineerExecute).toHaveBeenCalledWith(jobId, leaseInput());
    const imageRequest = modelImage.mock.calls[0]?.[0];
    if (!imageRequest) throw new Error("TEST_IMAGE_REQUEST_REQUIRED");
    expect(imageRequest.prompt).toContain(engineerArtifactId);
    expect(imageRequest.prompt).toContain(engineerSha256);
    expect(imageRequest.prompt).toContain("dnf-aseprite-pixel-style-plan-v1");
    expect(bindProfessionModelCallBeforeEgress).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "reference-image-v1",
      modelCallId,
    );
    expect(prepareProfessionModelOutputPersistence).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "reference-image-v1",
      {
        modelCallId,
        outputSha256: pngSha256,
        outputByteLength: png.byteLength,
      },
      1024,
    );
    expect(storageWrite).toHaveBeenCalledWith({
      objectKey: `artifacts/profession-${executionId}.png`,
      mediaType: "image/png",
      bytes: png,
      sha256: pngSha256,
    });
    const finalizedOutput = finalizeProfessionModelOutput.mock.calls[0]?.[2];
    if (!finalizedOutput) throw new Error("TEST_FINALIZED_OUTPUT_REQUIRED");
    if (finalizedOutput.stage !== "reference-image-v1") {
      throw new Error("TEST_REFERENCE_FINALIZE_REQUIRED");
    }
    expect(finalizedOutput).toMatchObject({
      modelCallId,
      storageKey: `artifacts/profession-${executionId}.png`,
      mediaType: "image/png",
      outputSha256: pngSha256,
      inputSnapshotSha256: sha256JcsV1({
        schemaVersion: 1,
        sourceEvidence: frozenContext().skill.sourceEvidence,
        engineerPlan: {
          executionId: engineerExecutionId,
          modelCallId: engineerModelCallId,
          outputArtifactId: engineerArtifactId,
          byteLength: 512,
          sha256: engineerSha256,
        },
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
      stage: "reference-image-v1",
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

  it("never reserves Artist while Engineer is in-progress", async () => {
    engineerExecute.mockResolvedValue({
      status: "in-progress",
      executionId: engineerExecutionId,
    });

    await expect(service.executeSkill(jobId, leaseInput())).resolves.toEqual({
      status: "in-progress",
      executionId: engineerExecutionId,
    });
    expect(reserveProfessionSkillModelExecution).not.toHaveBeenCalled();
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
      objectKey: `artifacts/profession-${executionId}.png`,
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
      "reference-image-v1",
      "MODEL_PROVIDER_REQUEST_FAILED",
      false,
      modelCallId,
    );
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it("rejects non-PNG bytes and never writes them as an Artifact", async () => {
    reserveProfessionSkillModelExecution.mockResolvedValue({
      status: "execute",
      executionId,
      context: frozenContext(),
    });
    modelImage.mockResolvedValue({
      bytes: Buffer.from("not-png"),
      record: { ...modelRecord(), status: "passed" },
    });

    await expect(
      service.executeSkill(jobId, leaseInput()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(failProfessionModelExecution).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "reference-image-v1",
      "PROFESSION_MODEL_OUTPUT_NOT_PNG",
      false,
      modelCallId,
    );
    expect(storageWrite).not.toHaveBeenCalled();
  });
});

function leaseInput(): RequestProfessionSkillExecutionInput {
  return {
    workerId: "77777777-7777-4777-8777-777777777777",
    leaseId: "88888888-8888-4888-8888-888888888888",
    attempt: 2,
    skillId,
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
    objectKey: `artifacts/profession-${executionId}.png`,
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
      schemaVersion: 1,
      palette: {
        shadow: [10, 22, 51],
        midtone: [26, 143, 255],
        rim: [0, 212, 255],
        core: [255, 255, 255],
      },
      parameters: {
        sourceColorMix: 0.2,
        coreThreshold: 0.72,
        coreIntensity: 0.9,
        rimThreshold: 0.18,
        rimIntensity: 0.8,
        phaseAmount: 0.35,
        crackDensity: 0.04,
        crackIntensity: 0.55,
      },
      optionalOperations: ["rim-light", "blade-core"],
    }),
  };
}

function frozenContext(): FrozenProfessionSkillExecutionContext {
  return {
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
