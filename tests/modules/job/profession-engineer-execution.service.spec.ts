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
import { createHash } from "node:crypto";
import type {
  ObjectStorageEvidence,
  ObjectStoragePort,
  ObjectStorageVerifiedBytes,
} from "../../../src/common/storage/object-storage.client.js";
import type { ModelCallView } from "../../../src/modules/openai/openai.contracts.js";
import { ProfessionEngineerExecutionService } from "../../../src/modules/job/profession-engineer-execution.service.js";
import {
  createProfessionEngineerStylePlan,
  encodeProfessionEngineerStylePlan,
  type ProfessionEngineerModelDecision,
  type ProfessionEngineerModelWireDecision,
} from "../../../src/modules/job/profession-engineer-plan.js";
import type { RequestProfessionSkillExecutionInput } from "../../../src/modules/job/profession-execution.contracts.js";
import type { FrozenProfessionSkillExecutionContext } from "../../../src/modules/job/profession-execution-context.js";

const jobId = "00000000-0000-4000-8000-000000000000";
const executionId = "11111111-1111-4111-8111-111111111111";
const modelCallId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const skillId = "55555555-5555-4555-8555-555555555555";
const sourcePng = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("source"),
]);
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
    readVerifiedBytes.mockImplementation((input) => {
      if (input.objectKey.endsWith("-engineer-plan.json")) {
        return Promise.resolve(storedPlan());
      }
      const bytes = input.objectKey.endsWith("-reference.png")
        ? sourcePng
        : sourcePng;
      return Promise.resolve({
        objectKey: input.objectKey,
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
        bytes,
      });
    });
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
      sourceVisualInput: sourceVisualInput(),
    });

    const result = await service.executeSkill(
      jobId,
      leaseInput(),
      referencePassed(),
    );

    expect(reserve).toHaveBeenCalledWith(
      jobId,
      leaseInput(),
      "engineer-plan-v3",
    );
    expect(structured).toHaveBeenCalledOnce();
    const request = structured.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      runId,
      role: "engineer",
      schemaName: "profession_engineer_reference_mapping_v2",
    });
    expect(request?.instructions).toContain(
      "normalized left, top, right, and bottom coordinates",
    );
    expect(request?.instructions).toContain(
      "generated-reference image is the primary runtime RGB source",
    );
    expect(request?.imageInputs?.map((image) => image.role)).toEqual([
      "official-source",
      "generated-reference",
    ]);
    expect(bind).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "engineer-plan-v3",
      modelCallId,
    );
    expect(prepare).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "engineer-plan-v3",
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
      stage: "engineer-plan-v3",
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
      stage: "engineer-plan-v3",
      executionId,
      modelCallId,
      outputArtifactId: artifactId,
      outputSha256: encodedPlan.sha256,
      outputByteLength: encodedPlan.byteLength,
    });

    await expect(
      service.executeSkill(jobId, leaseInput(), referencePassed()),
    ).resolves.toEqual({
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
      service.executeSkill(jobId, leaseInput(), referencePassed()),
    ).resolves.toMatchObject({ status: "passed", plan: encodedPlan.plan });
    expect(readVerifiedBytes).toHaveBeenCalledOnce();
    expect(structured).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("returns in-progress without model or storage side effects", async () => {
    reserve.mockResolvedValue({ status: "in-progress", executionId });

    await expect(
      service.executeSkill(jobId, leaseInput(), referencePassed()),
    ).resolves.toEqual({
      status: "in-progress",
      executionId,
    });
    expect(structured).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(readVerifiedBytes).not.toHaveBeenCalled();
  });

  it("fails closed when a wire-compatible model response violates domain constraints", async () => {
    reserve.mockResolvedValue({
      status: "execute",
      executionId,
      context: frozenContext(),
      sourceVisualInput: sourceVisualInput(),
    });
    structured.mockImplementation(async (request, beforeEgress) => {
      if (!beforeEgress) throw new Error("TEST_BEFORE_EGRESS_REQUIRED");
      const record = modelRecord();
      await beforeEgress(record);
      const invalidDecision: ProfessionEngineerModelWireDecision = {
        ...modelDecision(),
        referenceBounds: {
          ...modelDecision().referenceBounds,
          right: modelDecision().referenceBounds.left + 0.1,
        },
      };
      return {
        value: request.schema.parse(invalidDecision),
        record: { ...record, status: "passed" },
      };
    });

    await expect(
      service.executeSkill(jobId, leaseInput(), referencePassed()),
    ).rejects.toMatchObject({
      response: { code: "PROFESSION_ENGINEER_PLAN_INVALID" },
    });
    expect(fail).toHaveBeenCalledWith(
      executionId,
      leaseInput(),
      "engineer-plan-v3",
      "PROFESSION_ENGINEER_PLAN_INVALID",
      false,
      modelCallId,
    );
    expect(write).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});

function modelDecision(): ProfessionEngineerModelDecision {
  return {
    schemaVersion: 2,
    referenceBounds: {
      left: 0.03,
      top: 0.02,
      right: 0.97,
      bottom: 0.98,
    },
  };
}

function leaseInput(): RequestProfessionSkillExecutionInput {
  return {
    workerId: "66666666-6666-4666-8666-666666666666",
    leaseId: "77777777-7777-4777-8777-777777777777",
    attempt: 2,
    skillId,
    sourceVisualInput: {
      artifactId: "abababab-abab-4bab-8bab-abababababab",
      mediaType: "image/png",
      byteLength: sourcePng.byteLength,
      sha256: sha256(sourcePng),
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
    byteLength: sourcePng.byteLength,
    sha256: sha256(sourcePng),
    frameMapSha256: leaseInput().sourceVisualInput.frameMapSha256,
  };
}

function referencePassed(): {
  status: "passed";
  executionId: string;
  modelCallId: string;
  imageAttemptId: string;
  outputArtifactId: string;
  byteLength: number;
  sha256: string;
} {
  return {
    status: "passed" as const,
    executionId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
    modelCallId: "dededede-dede-4ede-8ede-dededededede",
    imageAttemptId: "efefefef-efef-4fef-8fef-efefefefefef",
    outputArtifactId: "fafafafa-fafa-4afa-8afa-fafafafafafa",
    byteLength: sourcePng.byteLength,
    sha256: sha256(sourcePng),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
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
