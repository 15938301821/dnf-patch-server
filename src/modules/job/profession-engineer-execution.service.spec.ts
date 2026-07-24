/**
 * @fileoverview 验证 Engineer structured 模型、canonical JSON Artifact 与幂等恢复编排；不连接真实
 * 数据库、OpenAI 或对象存储，也不证明 Aseprite、NPK、客户端兼容或部署。
 * @module modules/job/profession-engineer-execution-service-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：Vitest 以 Repository/OpenAI/ObjectStorage 窄端口 stub 调用真实内部 Service。测试保护
 * Engineer stage/role、pre-egress guard、canonical JSON 和恢复零二次出站；真实事务与 S3 由各层测试证明。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ObjectStorageEvidence,
  ObjectStoragePort,
  ObjectStorageVerifiedBytes,
} from "../../common/storage/object-storage.client.js";
import type { ModelCallView } from "../openai/openai.contracts.js";
import { ProfessionEngineerExecutionService } from "./profession-engineer-execution.service.js";
import {
  createProfessionEngineerStylePlan,
  encodeProfessionEngineerStylePlan,
  type ProfessionEngineerModelDecision,
} from "./profession-engineer-plan.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import type { FrozenProfessionSkillExecutionContext } from "./profession-execution-context.js";

const jobId = "00000000-0000-4000-8000-000000000000";
const executionId = "11111111-1111-4111-8111-111111111111";
const modelCallId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const skillId = "55555555-5555-4555-8555-555555555555";
const encodedPlan = encodeProfessionEngineerStylePlan(
  createProfessionEngineerStylePlan(modelDecision()),
);
type ExecutionRepositoryPort = ConstructorParameters<
  typeof ProfessionEngineerExecutionService
>[0];
type FixedEngineerModelPort = ConstructorParameters<
  typeof ProfessionEngineerExecutionService
>[1];

describe("ProfessionEngineerExecutionService", () => {
  const reserve =
    vi.fn<ExecutionRepositoryPort["reserveProfessionSkillModelExecution"]>();
  const bind =
    vi.fn<ExecutionRepositoryPort["bindProfessionModelCallBeforeEgress"]>();
  const prepare =
    vi.fn<ExecutionRepositoryPort["prepareProfessionModelOutputPersistence"]>();
  const finalize =
    vi.fn<ExecutionRepositoryPort["finalizeProfessionModelOutput"]>();
  const fail = vi.fn<ExecutionRepositoryPort["failProfessionModelExecution"]>();
  const executions = {
    reserveProfessionSkillModelExecution: reserve,
    bindProfessionModelCallBeforeEgress: bind,
    prepareProfessionModelOutputPersistence: prepare,
    finalizeProfessionModelOutput: finalize,
    failProfessionModelExecution: fail,
  };
  const structured = vi.fn<FixedEngineerModelPort["structured"]>();
  const write = vi.fn<ObjectStoragePort["write"]>();
  const readVerifiedBytes = vi.fn<ObjectStoragePort["readVerifiedBytes"]>();
  const storage: ObjectStoragePort = {
    authorizeUpload: vi.fn(),
    authorizeDownload: vi.fn(),
    write,
    verify: vi.fn(),
    readVerifiedBytes,
    delete: vi.fn(),
  };
  let service: ProfessionEngineerExecutionService;

  beforeEach(() => {
    vi.resetAllMocks();
    bind.mockResolvedValue("accepted");
    prepare.mockResolvedValue("accepted");
    finalize.mockResolvedValue("accepted");
    fail.mockResolvedValue(true);
    write.mockResolvedValue(storageEvidence());
    readVerifiedBytes.mockResolvedValue(storedPlan());
    structured.mockImplementation(async (request, beforeEgress) => {
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
      return {
        value: request.schema.parse(modelDecision()),
        record: { ...record, status: "passed" },
      };
    });
    service = new ProfessionEngineerExecutionService(
      executions,
      { structured },
      storage,
      { maxRunBytes: 64 * 1024, sessionTtlSeconds: 300 },
    );
  });

  it("persists one canonical Engineer JSON plan without ImageAttempt", async () => {
    reserve.mockResolvedValue({
      status: "execute",
      executionId,
      context: frozenContext(),
    });

    const result = await service.executeSkill(jobId, leaseInput());

    expect(reserve).toHaveBeenCalledWith(
      jobId,
      leaseInput(),
      "engineer-plan-v1",
    );
    expect(structured).toHaveBeenCalledOnce();
    const request = structured.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      runId,
      role: "engineer",
      schemaName: "profession_engineer_pixel_style_decision_v1",
    });
    expect(bind).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "engineer-plan-v1",
      modelCallId,
    );
    expect(prepare).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "engineer-plan-v1",
      {
        modelCallId,
        outputSha256: encodedPlan.sha256,
        outputByteLength: encodedPlan.byteLength,
      },
      64 * 1024,
    );
    expect(write).toHaveBeenCalledWith({
      objectKey: `artifacts/profession-${executionId}-engineer-plan.json`,
      mediaType: "application/json",
      bytes: encodedPlan.bytes,
      sha256: encodedPlan.sha256,
    });
    const output = finalize.mock.calls[0]?.[2];
    expect(output).toMatchObject({
      stage: "engineer-plan-v1",
      mediaType: "application/json",
      modelCallId,
    });
    expect(output).not.toHaveProperty("imageAttemptId");
    expect(result).toMatchObject({
      status: "passed",
      executionId,
      modelCallId,
      byteLength: encodedPlan.byteLength,
      sha256: encodedPlan.sha256,
      plan: encodedPlan.plan,
    });
  });

  it("recovers an existing passed plan without model egress or object write", async () => {
    reserve.mockResolvedValue({
      status: "passed",
      stage: "engineer-plan-v1",
      executionId,
      modelCallId,
      outputArtifactId: artifactId,
      outputSha256: encodedPlan.sha256,
      outputByteLength: encodedPlan.byteLength,
    });

    await expect(service.executeSkill(jobId, leaseInput())).resolves.toEqual({
      status: "passed",
      executionId,
      modelCallId,
      outputArtifactId: artifactId,
      byteLength: encodedPlan.byteLength,
      sha256: encodedPlan.sha256,
      plan: encodedPlan.plan,
    });
    expect(readVerifiedBytes).toHaveBeenCalledOnce();
    expect(structured).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("recovers persistence-pending using stored bytes without a second model call", async () => {
    reserve.mockResolvedValue({
      status: "persistence-pending",
      executionId,
      modelCallId,
      outputSha256: encodedPlan.sha256,
      outputByteLength: encodedPlan.byteLength,
      context: frozenContext(),
    });

    await expect(
      service.executeSkill(jobId, leaseInput()),
    ).resolves.toMatchObject({ status: "passed", plan: encodedPlan.plan });
    expect(readVerifiedBytes).toHaveBeenCalledOnce();
    expect(structured).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("returns in-progress without model or storage side effects", async () => {
    reserve.mockResolvedValue({ status: "in-progress", executionId });

    await expect(service.executeSkill(jobId, leaseInput())).resolves.toEqual({
      status: "in-progress",
      executionId,
    });
    expect(structured).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(readVerifiedBytes).not.toHaveBeenCalled();
  });
});

function modelDecision(): ProfessionEngineerModelDecision {
  return {
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
  };
}

function leaseInput(): RequestProfessionSkillExecutionInput {
  return {
    workerId: "66666666-6666-4666-8666-666666666666",
    leaseId: "77777777-7777-4777-8777-777777777777",
    attempt: 2,
    skillId,
  };
}

function modelRecord(): ModelCallView {
  return {
    id: modelCallId,
    runId,
    role: "engineer",
    model: "sprite-model",
    endpointIdentity: "models.example.test/v1",
    modelConfigurationVersion: 1,
    requestSha256: "A".repeat(64),
    responseSha256: encodedPlan.sha256,
    status: "running",
    modelEgressAuthorized: true,
    modelEgressPerformed: false,
    createdAtUtc: "2026-07-24T00:00:00.000Z",
  };
}

function storageEvidence(): ObjectStorageEvidence {
  return {
    objectKey: `artifacts/profession-${executionId}-engineer-plan.json`,
    mediaType: "application/json",
    byteLength: encodedPlan.byteLength,
    sha256: encodedPlan.sha256,
  };
}

function storedPlan(): ObjectStorageVerifiedBytes {
  return { ...storageEvidence(), bytes: encodedPlan.bytes };
}

function frozenContext(): FrozenProfessionSkillExecutionContext {
  return {
    runId,
    profileId: "profile-v2",
    professionId: "88888888-8888-4888-8888-888888888888",
    styleId: "99999999-9999-4999-8999-999999999999",
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
        sourceRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceInventoryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sourceFrameManifestArtifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sourceEntries: [
          {
            sourceInventoryEntryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            sourceMetadataSha256: "D".repeat(64),
          },
        ],
      },
    },
  };
}
