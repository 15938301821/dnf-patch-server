/**
 * @fileoverview 验证 Profession 模型执行的出站前绑定与最终三表证据写入事务；不连接真实 MySQL、
 * 不调用模型或对象存储，也不证明数据库驱动锁竞争。
 * @module modules/job/profession-execution-repository-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：Vitest 以按查询顺序返回行的 Drizzle stub 调用真实 Repository 方法。测试保护错误 Run 的
 * ModelCall 不能取得出站权，以及 finalize 的 Artifact/ImageAttempt/execution 状态必须处在同一 transaction。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../common/db/database.service.js";
import { sha256JcsV1, sha256Json } from "../../common/utils/canonical.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import {
  professionEngineerPlanStage,
  professionReferenceImageStage,
} from "./profession-model-execution.js";
import { ProfessionModelExecutionRepository } from "./profession-model-execution.repository.js";
import {
  createStyleSkillPromptComposition,
  type StyleSkillProductionJobPayloadV2,
} from "./style-skill-production.contracts.js";

const executionId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const modelCallId = "44444444-4444-4444-8444-444444444444";
const skillId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-07-24T00:00:00.000Z");

interface TransitionHarness {
  repository: ProfessionModelExecutionRepository;
  transaction: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  inserted: Record<string, unknown>[];
  updated: Record<string, unknown>[];
}

describe("ProfessionModelExecutionRepository transitions", () => {
  it("refuses Artist reservation before the same-attempt Engineer plan passes", async () => {
    const harness = transitionHarness([[leasedJob()], [{ value: now }], []]);

    await expect(
      harness.repository.reserveProfessionSkillModelExecution(
        jobId,
        leaseInput(),
        professionReferenceImageStage,
      ),
    ).resolves.toEqual({ status: "prerequisite-not-passed" });
    expect(harness.insert).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("rejects a ModelCall from another Run before egress", async () => {
    const harness = transitionHarness([
      [{ jobId }],
      [leasedJob()],
      [execution()],
      [{ value: now }],
      [
        {
          runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "running",
        },
      ],
    ]);

    await expect(
      harness.repository.bindProfessionModelCallBeforeEgress(
        executionId,
        leaseInput(),
        professionReferenceImageStage,
        modelCallId,
      ),
    ).resolves.toBe("rejected");
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("binds the running same-Run ModelCall before egress", async () => {
    const harness = transitionHarness([
      [{ jobId }],
      [leasedJob()],
      [execution()],
      [{ value: now }],
      [{ runId, role: "artist", status: "running" }],
    ]);

    await expect(
      harness.repository.bindProfessionModelCallBeforeEgress(
        executionId,
        leaseInput(),
        professionReferenceImageStage,
        modelCallId,
      ),
    ).resolves.toBe("accepted");
    expect(harness.update).toHaveBeenCalledOnce();
  });

  it("counts active Artifact upload sessions before reserving model output", async () => {
    const harness = transitionHarness([
      [{ jobId }],
      [leasedJob()],
      [execution({ modelCallId })],
      [{ value: now }],
      [{ runId, role: "artist", status: "passed" }],
      [{ id: runId }],
      [{ value: "0" }],
      [{ value: "900" }],
      [{ value: "0" }],
    ]);

    await expect(
      harness.repository.prepareProfessionModelOutputPersistence(
        executionId,
        leaseInput(),
        professionReferenceImageStage,
        {
          modelCallId,
          outputSha256: "A".repeat(64),
          outputByteLength: 128,
        },
        1_000,
      ),
    ).resolves.toBe("run-quota-exceeded");
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("atomically creates Artifact, ImageAttempt and passed execution evidence", async () => {
    const harness = transitionHarness([
      [{ jobId }],
      [leasedJob()],
      [
        execution({
          status: "persisting",
          modelCallId,
          outputSha256: "A".repeat(64),
          outputByteLength: 128,
        }),
      ],
      [{ value: now }],
    ]);
    const output = {
      stage: professionReferenceImageStage,
      modelCallId,
      outputSha256: "A".repeat(64),
      outputByteLength: 128,
      artifactId: "66666666-6666-4666-8666-666666666666",
      imageAttemptId: "77777777-7777-4777-8777-777777777777",
      storageKey: `artifacts/profession-${executionId}.png`,
      mediaType: "image/png" as const,
      logicalName: `reference-${skillId}.png`,
      inputSnapshotSha256: "B".repeat(64),
      generationConfigSha256: "C".repeat(64),
      adapterIdentity: "openai-image/reference-image-v1",
    };

    await expect(
      harness.repository.finalizeProfessionModelOutput(
        executionId,
        leaseInput(),
        output,
      ),
    ).resolves.toBe("accepted");
    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.insert).toHaveBeenCalledTimes(2);
    expect(harness.inserted[0]).toMatchObject({
      id: output.artifactId,
      runId,
      storageKey: output.storageKey,
      provenance: { jobId, attempt: 2, skillId, modelCallId },
    });
    expect(harness.inserted[1]).toMatchObject({
      id: output.imageAttemptId,
      runId,
      modelCallId,
      outputArtifactId: output.artifactId,
      status: "generated",
      directRuntimeUseAllowed: false,
    });
    expect(harness.updated).toContainEqual(
      expect.objectContaining({
        status: "passed",
        imageAttemptId: output.imageAttemptId,
        outputArtifactId: output.artifactId,
        finishedAt: now,
      }),
    );
  });

  it("finalizes an Engineer plan as JSON Artifact without ImageAttempt", async () => {
    const harness = transitionHarness([
      [{ jobId }],
      [leasedJob()],
      [
        execution({
          stage: professionEngineerPlanStage,
          status: "persisting",
          modelCallId,
          outputSha256: "A".repeat(64),
          outputByteLength: 128,
        }),
      ],
      [{ value: now }],
    ]);
    const output = {
      stage: professionEngineerPlanStage,
      modelCallId,
      outputSha256: "A".repeat(64),
      outputByteLength: 128,
      artifactId: "66666666-6666-4666-8666-666666666666",
      storageKey: `artifacts/profession-${executionId}-engineer-plan.json`,
      mediaType: "application/json" as const,
      logicalName: `engineer-plan-${skillId}.json`,
    };

    await expect(
      harness.repository.finalizeProfessionModelOutput(
        executionId,
        leaseInput(),
        output,
      ),
    ).resolves.toBe("accepted");
    expect(harness.insert).toHaveBeenCalledOnce();
    expect(harness.inserted[0]).toMatchObject({
      mediaType: "application/json",
      provenance: { kind: professionEngineerPlanStage },
    });
    expect(harness.updated).toContainEqual(
      expect.objectContaining({
        status: "passed",
        outputArtifactId: output.artifactId,
      }),
    );
    expect(harness.updated.at(-1)).not.toHaveProperty("imageAttemptId");
  });
});

function transitionHarness(selectRows: unknown[][]): TransitionHarness {
  let selectIndex = 0;
  const select = vi.fn(() => ({
    from: vi.fn(() => {
      const rows = selectRows[selectIndex] ?? [];
      selectIndex += 1;
      return {
        where: vi.fn(() => {
          const whereResult = {
            limit: vi.fn(() => ({
              for: vi.fn().mockResolvedValue(rows),
              then: (
                resolve: (value: unknown[]) => unknown,
              ): Promise<unknown> => Promise.resolve(rows).then(resolve),
            })),
            then: (resolve: (value: unknown[]) => unknown): Promise<unknown> =>
              Promise.resolve(rows).then(resolve),
          };
          return whereResult;
        }),
        limit: vi.fn().mockResolvedValue(rows),
      };
    }),
  }));
  const inserted: Record<string, unknown>[] = [];
  const insert = vi.fn(() => ({
    values: vi.fn((value: Record<string, unknown>) => {
      inserted.push(value);
      return Promise.resolve();
    }),
  }));
  const updated: Record<string, unknown>[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((value: Record<string, unknown>) => {
      updated.push(value);
      return {
        where: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
      };
    }),
  }));
  const transaction = vi.fn(
    (
      callback: (transaction: {
        select: typeof select;
        insert: typeof insert;
        update: typeof update;
      }) => unknown,
    ) => Promise.resolve(callback({ select, insert, update })),
  );
  return {
    repository: new ProfessionModelExecutionRepository({
      database: { transaction },
    } as unknown as DatabaseService),
    transaction,
    insert,
    update,
    inserted,
    updated,
  };
}

function leaseInput(): RequestProfessionSkillExecutionInput {
  return {
    workerId: "88888888-8888-4888-8888-888888888888",
    leaseId: "99999999-9999-4999-8999-999999999999",
    attempt: 2,
    skillId,
  };
}

function leasedJob(): Record<string, unknown> {
  const payload = validPayload();
  return {
    id: jobId,
    runId,
    kind: "profession",
    status: "leased",
    payload,
    payloadSha256: sha256Json(payload),
    leaseOwnerId: leaseInput().workerId,
    leaseId: leaseInput().leaseId,
    leaseExpiresAt: new Date("2026-07-24T00:01:00.000Z"),
    attemptCount: 2,
  };
}

function execution(
  override: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: executionId,
    runId,
    jobId,
    workerId: leaseInput().workerId,
    leaseId: leaseInput().leaseId,
    attempt: 2,
    skillId,
    stage: "reference-image-v1",
    promptSha256: "D".repeat(64),
    modelCallId: null,
    imageAttemptId: null,
    outputArtifactId: null,
    outputSha256: null,
    outputByteLength: null,
    errorCode: null,
    status: "egressing",
    ...override,
  };
}

function validPayload(): StyleSkillProductionJobPayloadV2 {
  const themeDefinition = {
    schemaVersion: 1 as const,
    goal: "统一暗蓝剑气主题",
    baseStyle: "深钴蓝剑气",
    colorAnchors: [{ name: "主色", value: "#123456" }],
    materialRules: "保留清晰剑气边缘",
    particleRules: "粒子跟随原动画节奏",
    layeringRules: "不改变源帧层级语义",
    constraints: "保持源几何与锚点",
    acceptanceCriteria: "逐帧轮廓可辨识",
    exclusions: "不新增角色本体效果",
  };
  const professionPrompt = {
    schemaVersion: 1 as const,
    stableSemantics: "保留技能身份",
    commonPrompt: "保持角色与武器轮廓",
    sourceConstraints: "只处理核验帧",
    stageAcceptance: "逐帧通过来源约束",
  };
  const skillThemePrompt = {
    skillId,
    themePrompt: "暗蓝月牙剑气",
    changes: "替换剑气材质与粒子颜色",
    acceptanceCriteria: "动作时间轴与原技能一致",
    exclusions: "不修改命中范围",
  };
  const professionPromptSha256 = sha256JcsV1(professionPrompt);
  const skill = {
    skillId,
    professionPrompt,
    professionPromptSha256,
    skillThemePrompt,
    promptSha256: sha256JcsV1(
      createStyleSkillPromptComposition(themeDefinition, {
        professionPrompt,
        professionPromptSha256,
        skillThemePrompt,
      }),
    ),
    sourceEvidence: {
      sourceRunId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sourceInventoryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sourceFrameManifestArtifactId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      sourceEntries: [
        {
          sourceInventoryEntryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          sourceMetadataSha256: "D".repeat(64),
        },
      ],
    },
  };
  const promptPackage = {
    schemaVersion: 2 as const,
    themeDefinition,
    skills: [skill],
  };
  return {
    schemaVersion: 1,
    profileId: "profile-v2",
    parameters: {
      workflow: "style-skill-production-v2",
      professionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      styleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      selectedSkillIds: [skillId],
      promptPackage,
      promptPackageSha256: sha256JcsV1(promptPackage),
      toolProfiles: ["aseprite-cli"],
      deploymentAuthorized: false,
    },
  };
}
