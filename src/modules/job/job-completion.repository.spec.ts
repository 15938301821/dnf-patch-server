/**
 * @fileoverview 验证 Profession Job 完成事务在 Server 复算摘要与 Worker 提交摘要不一致时零写入；
 * 不连接 MySQL、不调用 Worker、模型、对象存储或 Aseprite。
 * @module modules/job/job-completion-repository-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession Worker 纵向闭环直接需求
 *
 * 调用关系：Vitest 用按查询顺序返回行的最小 Drizzle transaction stub 调用真实
 * JobRepository.complete。测试证明 Job、Run、production 与 Artifact 均在事务锁内读取后，摘要漂移
 * 会先于 Job/attempt 更新返回；stub 不证明真实 MySQL 锁竞争、外键或事务隔离级别。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../common/db/database.service.js";
import { sha256JcsV1, sha256Json } from "../../common/utils/canonical.js";
import {
  resolveProfessionCompletionEvidence,
  type ProfessionCompletionJobState,
  type ProfessionProductionEvidenceRow,
} from "./profession-completion-evidence.js";
import { JobRepository } from "./job.repository.js";
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
const projectsArtifactId = "77777777-7777-4777-8777-777777777777";
const validationArtifactId = "88888888-8888-4888-8888-888888888888";
const databaseTime = new Date("2026-07-24T00:00:00.000Z");

describe("JobRepository.complete Profession evidence gate", () => {
  it("returns evidence-incomplete without writes when the result digest drifts", async () => {
    const fixture = completionFixture();
    const harness = completionHarness(fixture);
    const completion = resolveProfessionCompletionEvidence(
      fixture.job,
      fixture.productions,
      fixture.artifacts,
    );
    if (
      completion.status !== "accepted" ||
      completion.progress.resultSha256 === undefined
    ) {
      throw new Error("TEST_COMPLETE_PROFESSION_EVIDENCE_REQUIRED");
    }
    const wrongDigest =
      completion.progress.resultSha256 === "0".repeat(64)
        ? "1".repeat(64)
        : "0".repeat(64);

    await expect(
      harness.repository.complete(jobId, {
        workerId,
        leaseId,
        status: "passed",
        resultSha256: wrongDigest,
      }),
    ).resolves.toEqual({ status: "profession-evidence-incomplete" });

    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.forUpdate).toHaveBeenCalledTimes(4);
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.updated).toEqual([]);
  });

  it("blocks the unfinished package while completing verified skill production", async () => {
    const fixture = completionFixture();
    const completion = resolveProfessionCompletionEvidence(
      fixture.job,
      fixture.productions,
      fixture.artifacts,
    );
    if (
      completion.status !== "accepted" ||
      completion.progress.resultSha256 === undefined
    ) {
      throw new Error("TEST_COMPLETE_PROFESSION_EVIDENCE_REQUIRED");
    }
    const harness = acceptedCompletionHarness(fixture);

    await expect(
      harness.repository.complete(jobId, {
        workerId,
        leaseId,
        status: "passed",
        resultSha256: completion.progress.resultSha256,
      }),
    ).resolves.toMatchObject({ status: "accepted" });

    expect(harness.updated).toHaveLength(4);
    expect(harness.updated[0]).toMatchObject({ status: "passed" });
    expect(harness.updated[1]).toMatchObject({ status: "passed" });
    expect(harness.updated[2]).toMatchObject({
      status: "blocked",
      finishedAt: databaseTime,
    });
    expect(harness.updated[3]).toMatchObject({ status: "passed" });
    expect(harness.insert).toHaveBeenCalledTimes(2);
  });
});

interface CompletionFixture {
  job: ReturnType<typeof leasedJob>;
  productions: ReturnType<typeof passedProduction>[];
  artifacts: Array<{ id: string; runId: string; sha256: string }>;
}

interface CompletionHarness {
  repository: JobRepository;
  transaction: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  forUpdate: ReturnType<typeof vi.fn>;
  updated: Record<string, unknown>[];
}

interface AcceptedCompletionHarness extends CompletionHarness {
  insert: ReturnType<typeof vi.fn>;
}

/** 构造一个全部单技能证据已 passed 的事务快照，摘要仍由生产纯函数独立计算。 */
function completionFixture(): CompletionFixture {
  const payload = validPayload();
  return {
    job: leasedJob(payload),
    productions: [passedProduction(payload)],
    artifacts: [
      { id: projectsArtifactId, runId, sha256: "3".repeat(64) },
      { id: validationArtifactId, runId, sha256: "4".repeat(64) },
    ],
  };
}

/** 按 complete 的锁定查询顺序提供 Job、数据库时间、Run、production 与 Artifact。 */
function completionHarness(fixture: CompletionFixture): CompletionHarness {
  const rows = [
    [fixture.job],
    [{ value: databaseTime }],
    [{ id: runId }],
    fixture.productions,
    fixture.artifacts,
  ];
  let selectIndex = 0;
  const forUpdate = vi.fn();
  const select = vi.fn(() => {
    const selectedRows = rows[selectIndex] ?? [];
    selectIndex += 1;
    return {
      from: vi.fn(() => queryBuilder(selectedRows, forUpdate)),
    };
  });
  const updated: Record<string, unknown>[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((value: Record<string, unknown>) => ({
      where: vi.fn(() => {
        updated.push(value);
        return Promise.resolve([{ affectedRows: 1 }]);
      }),
    })),
  }));
  const transaction = vi.fn(
    (
      callback: (transaction: {
        select: typeof select;
        update: typeof update;
      }) => unknown,
    ) => Promise.resolve(callback({ select, update })),
  );
  const connection = {
    database: { transaction },
  } as unknown as DatabaseService;
  return {
    repository: new JobRepository(connection),
    transaction,
    update,
    forUpdate,
    updated,
  };
}

/** 提供 accepted 路径后续的 Job 聚合与事件查询，并记录四个状态更新和两个事件插入。 */
function acceptedCompletionHarness(
  fixture: CompletionFixture,
): AcceptedCompletionHarness {
  const rows = [
    [fixture.job],
    [{ value: databaseTime }],
    [{ id: runId }],
    fixture.productions,
    fixture.artifacts,
    [{ id: jobId, status: "passed" }],
    [{ sequence: null }],
  ];
  let selectIndex = 0;
  const forUpdate = vi.fn();
  const select = vi.fn(() => {
    const selectedRows = rows[selectIndex] ?? [];
    selectIndex += 1;
    return {
      from: vi.fn(() => queryBuilder(selectedRows, forUpdate)),
    };
  });
  const updated: Record<string, unknown>[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((value: Record<string, unknown>) => ({
      where: vi.fn(() => {
        updated.push(value);
        return Promise.resolve([{ affectedRows: 1 }]);
      }),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn().mockResolvedValue(undefined),
  }));
  const transaction = vi.fn(
    (
      callback: (transaction: {
        select: typeof select;
        update: typeof update;
        insert: typeof insert;
      }) => unknown,
    ) => Promise.resolve(callback({ select, update, insert })),
  );
  const connection = {
    database: { transaction },
  } as unknown as DatabaseService;
  return {
    repository: new JobRepository(connection),
    transaction,
    update,
    insert,
    forUpdate,
    updated,
  };
}

/** 模拟 Drizzle 的惰性链式查询；then 只用于无 FOR UPDATE 的数据库时间读取。 */
function queryBuilder(
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

function leasedJob(
  payload: StyleSkillProductionJobPayloadV2,
): ProfessionCompletionJobState & Record<string, unknown> {
  return {
    id: jobId,
    runId,
    kind: "profession",
    status: "leased",
    payload,
    payloadSha256: sha256Json(payload),
    leaseOwnerId: workerId,
    leaseId,
    leaseExpiresAt: new Date("2026-07-24T00:01:00.000Z"),
    dispatchReadyAt: databaseTime,
    attemptCount: 2,
    maxAttempts: 3,
    createdAt: databaseTime,
    updatedAt: databaseTime,
  };
}

function passedProduction(
  payload: StyleSkillProductionJobPayloadV2,
): ProfessionProductionEvidenceRow {
  const skill = payload.parameters.promptPackage.skills[0];
  if (!skill) throw new Error("TEST_SKILL_REQUIRED");
  return {
    runId,
    professionId,
    styleId,
    skillId,
    jobId,
    workerId,
    leaseId,
    attempt: 1,
    sourceRunId: skill.sourceEvidence.sourceRunId,
    sourceFrameManifestArtifactId:
      skill.sourceEvidence.sourceFrameManifestArtifactId,
    promptSha256: skill.promptSha256,
    modelCallId: "99999999-9999-4999-8999-999999999999",
    imageAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    asepriteProfileId: "aseprite-cli",
    asepriteBinarySha256: "1".repeat(64),
    asepriteAdapterSha256: "2".repeat(64),
    asepriteArtifactId: projectsArtifactId,
    validationArtifactId,
    status: "passed",
    errorCode: null,
  };
}

function validPayload(): StyleSkillProductionJobPayloadV2 {
  const themeDefinition = {
    schemaVersion: 1 as const,
    goal: "冻结主题",
    baseStyle: "pixel effect",
    colorAnchors: [{ name: "主色", value: "#123456" }],
    materialRules: "保持边缘",
    particleRules: "保持节奏",
    layeringRules: "保持层级",
    constraints: "保持几何",
    acceptanceCriteria: "逐帧可辨",
    exclusions: "不改变角色",
  };
  const professionPrompt = {
    schemaVersion: 1 as const,
    stableSemantics: "保留技能身份",
    commonPrompt: "保持角色与武器轮廓",
    sourceConstraints: "仅用冻结来源",
    stageAcceptance: "逐帧核验",
  };
  const skillThemePrompt = {
    skillId,
    themePrompt: "暗蓝效果",
    changes: "修改材质",
    acceptanceCriteria: "保持时间轴",
    exclusions: "不修改命中范围",
  };
  const professionPromptSha256 = sha256JcsV1(professionPrompt);
  const frozen = {
    skillId,
    professionPrompt,
    professionPromptSha256,
    skillThemePrompt,
    sourceEvidence: {
      sourceRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sourceInventoryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sourceFrameManifestArtifactId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sourceEntries: [
        {
          sourceInventoryEntryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          sourceMetadataSha256: "5".repeat(64),
        },
      ],
    },
  };
  const skill = {
    ...frozen,
    promptSha256: sha256JcsV1(
      createStyleSkillPromptComposition(themeDefinition, frozen),
    ),
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
