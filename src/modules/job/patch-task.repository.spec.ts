/**
 * @fileoverview 验证 PatchTask Repository 在事务和 Job 行锁内解析 Profession 单技能执行上下文；
 * 不连接 MySQL、不调用模型、不访问对象存储，也不暴露 Worker HTTP 路由。
 * @module modules/job/patch-task-repository-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：Vitest 用最小 Drizzle transaction stub 调用真实 Repository 方法。测试保护数据库时间、
 * FOR UPDATE 和冻结 payload 解析必须处于同一事务；stub 不证明真实 MySQL 锁竞争语义。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../common/db/database.service.js";
import { sha256JcsV1, sha256Json } from "../../common/utils/canonical.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import { professionEngineerPlanStage } from "./profession-model-execution.js";
import { ProfessionModelExecutionRepository } from "./profession-model-execution.repository.js";
import { PatchTaskRepository } from "./patch-task.repository.js";
import {
  createStyleSkillPromptComposition,
  type StyleSkillProductionJobPayloadV2,
} from "./style-skill-production.contracts.js";

const jobId = "00000000-0000-4000-8000-000000000000";
const workerId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const professionId = "44444444-4444-4444-8444-444444444444";
const styleId = "55555555-5555-4555-8555-555555555555";
const skillId = "66666666-6666-4666-8666-666666666666";

interface PatchTaskRepositoryHarness {
  repository: PatchTaskRepository;
  transaction: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  forUpdate: ReturnType<typeof vi.fn>;
}

interface ReservationHarness {
  repository: ProfessionModelExecutionRepository;
  transaction: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  forUpdate: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

describe("PatchTaskRepository.resolveProfessionSkillExecution", () => {
  it("resolves a frozen skill while holding the Job row lock", async () => {
    const payload = validPayload();
    const harness = repositoryHarness(
      job(payload),
      new Date("2026-07-24T00:00:00.000Z"),
    );

    await expect(
      harness.repository.resolveProfessionSkillExecution(jobId, input()),
    ).resolves.toMatchObject({
      status: "accepted",
      context: { runId, professionId, styleId, skill: { skillId } },
    });
    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.forUpdate).toHaveBeenCalledWith("update");
    expect(harness.select).toHaveBeenCalledTimes(2);
  });

  it("rejects a lease expired according to database time", async () => {
    const payload = validPayload();
    const harness = repositoryHarness(
      job(payload),
      new Date("2026-07-24T00:01:00.000Z"),
    );

    await expect(
      harness.repository.resolveProfessionSkillExecution(jobId, input()),
    ).resolves.toEqual({ status: "lease-mismatch" });
    expect(harness.forUpdate).toHaveBeenCalledWith("update");
    expect(harness.select).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing Job without attempting a database time fallback", async () => {
    const harness = repositoryHarness(
      undefined,
      new Date("2026-07-24T00:00:00.000Z"),
    );

    await expect(
      harness.repository.resolveProfessionSkillExecution(jobId, input()),
    ).resolves.toEqual({ status: "lease-mismatch" });
    expect(harness.forUpdate).toHaveBeenCalledWith("update");
    expect(harness.select).toHaveBeenCalledOnce();
  });
});

describe("PatchTaskRepository.resolveProfessionProductionProgress", () => {
  it("returns pending progress in frozen order under the current lease", async () => {
    const payload = validPayload();
    const production = progressProduction(payload);
    const harness = progressRepositoryHarness(
      job(payload),
      new Date("2026-07-24T00:00:00.000Z"),
      [production],
    );

    await expect(
      harness.repository.resolveProfessionProductionProgress(jobId, {
        workerId,
        leaseId,
        attempt: 2,
      }),
    ).resolves.toEqual({
      status: "accepted",
      progress: {
        schemaVersion: 1,
        skills: [{ skillId, status: "pending" }],
      },
    });
    expect(harness.forUpdate).toHaveBeenCalledTimes(2);
    expect(harness.select).toHaveBeenCalledTimes(3);
  });

  it("rejects an expired lease before reading production evidence", async () => {
    const payload = validPayload();
    const harness = progressRepositoryHarness(
      job(payload),
      new Date("2026-07-24T00:01:00.000Z"),
      [progressProduction(payload)],
    );

    await expect(
      harness.repository.resolveProfessionProductionProgress(jobId, {
        workerId,
        leaseId,
        attempt: 2,
      }),
    ).resolves.toEqual({ status: "lease-mismatch" });
    expect(harness.select).toHaveBeenCalledTimes(2);
    expect(harness.forUpdate).toHaveBeenCalledOnce();
  });
});

describe("ProfessionModelExecutionRepository.reserveProfessionSkillModelExecution", () => {
  it("grants the model egress right only once for the same attempt and skill", async () => {
    const payload = validPayload();
    const harness = reservationHarness(
      job(payload),
      new Date("2026-07-24T00:00:00.000Z"),
    );

    const first = await harness.repository.reserveProfessionSkillModelExecution(
      jobId,
      input(),
      professionEngineerPlanStage,
    );
    expect(first).toMatchObject({ status: "execute" });
    if (first.status !== "execute") throw new Error("TEST_EXECUTE_REQUIRED");

    await expect(
      harness.repository.reserveProfessionSkillModelExecution(
        jobId,
        input(),
        professionEngineerPlanStage,
      ),
    ).resolves.toEqual({
      status: "in-progress",
      executionId: first.executionId,
    });
    expect(harness.insert).toHaveBeenCalledOnce();
    expect(harness.update).toHaveBeenCalledOnce();
    expect(harness.transaction).toHaveBeenCalledTimes(2);
    expect(harness.forUpdate).toHaveBeenCalledTimes(4);
  });

  it("rejects an invalid lease before creating an execution record", async () => {
    const payload = validPayload();
    const harness = reservationHarness(
      job(payload),
      new Date("2026-07-24T00:00:00.000Z"),
    );

    await expect(
      harness.repository.reserveProfessionSkillModelExecution(
        jobId,
        {
          ...input(),
          leaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
        professionEngineerPlanStage,
      ),
    ).resolves.toEqual({ status: "lease-mismatch" });
    expect(harness.insert).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.forUpdate).toHaveBeenCalledOnce();
  });
});

function input(): RequestProfessionSkillExecutionInput {
  return { workerId, leaseId, attempt: 2, skillId };
}

function job(
  payload: StyleSkillProductionJobPayloadV2,
): Record<string, unknown> {
  return {
    id: jobId,
    runId,
    kind: "profession",
    status: "leased",
    leaseOwnerId: workerId,
    leaseId,
    leaseExpiresAt: new Date("2026-07-24T00:00:30.000Z"),
    attemptCount: 2,
    payload,
    payloadSha256: sha256Json(payload),
  };
}

function repositoryHarness(
  persistedJob: ReturnType<typeof job> | undefined,
  databaseTime: Date,
): PatchTaskRepositoryHarness {
  const forUpdate = vi
    .fn()
    .mockResolvedValue(persistedJob ? [persistedJob] : []);
  const select = vi
    .fn()
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({ for: forUpdate })),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([{ value: databaseTime }]),
      })),
    });
  const transaction = vi.fn(
    (callback: (transaction: { select: typeof select }) => unknown) =>
      Promise.resolve(callback({ select })),
  );
  const connection = {
    database: { transaction },
  } as unknown as DatabaseService;
  return {
    repository: new PatchTaskRepository(connection),
    transaction,
    select,
    forUpdate,
  };
}

function progressRepositoryHarness(
  persistedJob: ReturnType<typeof job>,
  databaseTime: Date,
  productions: Record<string, unknown>[],
): PatchTaskRepositoryHarness {
  let selectIndex = 0;
  const forUpdate = vi.fn();
  const rows = [[persistedJob], [{ value: databaseTime }], productions, []];
  const select = vi.fn(() => {
    const currentRows = rows[selectIndex] ?? [];
    selectIndex += 1;
    return {
      from: vi.fn(() => progressQueryBuilder(currentRows, forUpdate)),
    };
  });
  const transaction = vi.fn(
    (callback: (transaction: { select: typeof select }) => unknown) =>
      Promise.resolve(callback({ select })),
  );
  const connection = {
    database: { transaction },
  } as unknown as DatabaseService;
  return {
    repository: new PatchTaskRepository(connection),
    transaction,
    select,
    forUpdate,
  };
}

function progressQueryBuilder(
  rows: unknown[],
  forUpdate: (lock: string) => void,
): Record<string, unknown> {
  const query = {
    where: vi.fn(() => query),
    limit: vi.fn(() => query),
    for: vi.fn((lock: string) => {
      forUpdate(lock);
      return Promise.resolve(rows);
    }),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ): Promise<unknown> => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}

function progressProduction(
  payload: StyleSkillProductionJobPayloadV2,
): Record<string, unknown> {
  const skill = payload.parameters.promptPackage.skills[0];
  if (!skill) throw new Error("TEST_SKILL_REQUIRED");
  return {
    runId,
    professionId,
    styleId,
    skillId,
    jobId: null,
    workerId: null,
    leaseId: null,
    attempt: null,
    sourceRunId: skill.sourceEvidence.sourceRunId,
    sourceFrameManifestArtifactId:
      skill.sourceEvidence.sourceFrameManifestArtifactId,
    promptSha256: skill.promptSha256,
    modelCallId: null,
    imageAttemptId: null,
    asepriteProfileId: null,
    asepriteBinarySha256: null,
    asepriteAdapterSha256: null,
    asepriteArtifactId: null,
    validationArtifactId: null,
    status: "planned",
    errorCode: null,
  };
}

function reservationHarness(
  persistedJob: ReturnType<typeof job>,
  databaseTime: Date,
): ReservationHarness {
  let selectIndex = 0;
  let persistedExecution: Record<string, unknown> | undefined;
  const forUpdate = vi.fn();
  const select = vi.fn(() => {
    const current = selectIndex;
    selectIndex += 1;
    if (current % 3 === 1) {
      return {
        from: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ value: databaseTime }]),
        })),
      };
    }
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: (lock: string): Promise<Record<string, unknown>[]> => {
              forUpdate(lock);
              return Promise.resolve(
                current % 3 === 0
                  ? [persistedJob]
                  : persistedExecution
                    ? [persistedExecution]
                    : [],
              );
            },
          })),
        })),
      })),
    };
  });
  const insert = vi.fn(() => ({
    values: vi.fn((value: Record<string, unknown>) => {
      persistedExecution = {
        modelCallId: null,
        imageAttemptId: null,
        outputArtifactId: null,
        outputSha256: null,
        outputByteLength: null,
        errorCode: null,
        ...value,
      };
      return Promise.resolve();
    }),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((value: Record<string, unknown>) => ({
      where: vi.fn(() => {
        persistedExecution = { ...persistedExecution, ...value };
        return Promise.resolve([{ affectedRows: 1 }]);
      }),
    })),
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
  const connection = {
    database: { transaction },
  } as unknown as DatabaseService;
  return {
    repository: new ProfessionModelExecutionRepository(connection),
    transaction,
    select,
    insert,
    update,
    forUpdate,
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
  const promptComposition = createStyleSkillPromptComposition(themeDefinition, {
    professionPrompt,
    professionPromptSha256,
    skillThemePrompt,
  });
  const skill = {
    skillId,
    professionPrompt,
    professionPromptSha256,
    skillThemePrompt,
    promptSha256: sha256JcsV1(promptComposition),
    sourceEvidence: {
      sourceRunId: "77777777-7777-4777-8777-777777777777",
      sourceInventoryId: "88888888-8888-4888-8888-888888888888",
      sourceFrameManifestArtifactId: "99999999-9999-4999-8999-999999999999",
      sourceEntries: [
        {
          sourceInventoryEntryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          sourceMetadataSha256: "A".repeat(64),
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
    profileId: "aseprite-production-v1",
    parameters: {
      workflow: "style-skill-production-v2",
      professionId,
      styleId,
      selectedSkillIds: [skillId],
      promptPackage,
      promptPackageSha256: sha256JcsV1(promptPackage),
      toolProfiles: ["aseprite-cli"],
      deploymentAuthorized: false,
    },
  };
}
