/**
 * @fileoverview 验证 Profession 技能源 Repository 在当前 Job 行锁内还原精确 Inventory/Artifact/Entry
 * 证据，并在顺序、摘要或 provenance 漂移时 fail-closed；不连接真实 MySQL 或对象存储。
 * @module modules/job/profession-source-context-repository-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：Vitest 以最小 Drizzle transaction stub 调用真实 Repository；fixture 使用真实 Job schema
 * 和哈希算法。测试证明查询编排与内存一致性门禁，不证明真实 MySQL 的锁竞争、外键或索引语义。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../common/db/database.service.js";
import { sha256JcsV1, sha256Json } from "../../common/utils/canonical.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import { ProfessionSourceContextRepository } from "./profession-source-context.repository.js";
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
const sourceRunId = "77777777-7777-4777-8777-777777777777";
const sourceInventoryId = "88888888-8888-4888-8888-888888888888";
const manifestArtifactId = "99999999-9999-4999-8999-999999999999";
const firstEntryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondEntryId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sourceSha256 = "C".repeat(64);
const toolSha256 = "D".repeat(64);
const manifestSha256 = "E".repeat(64);

interface SourceContextRepositoryHarness {
  repository: ProfessionSourceContextRepository;
  transaction: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  forUpdate: ReturnType<typeof vi.fn>;
}

interface SourceRowFixture {
  runId: string;
  inventoryId: string;
  sourceByteLength: number;
  sourceSha256: string;
  manifestArtifactId: string;
  manifestLogicalName: string;
  manifestMediaType: string;
  manifestByteLength: number;
  manifestSha256: string;
  manifestProvenance: {
    schemaVersion: 1;
    kind: "source-frame-manifest";
    sourceSha256: string;
    toolSha256: string;
    jobPayloadSha256: string;
    deploymentAuthorized: false;
  };
}

interface EntryRowFixture {
  id: string;
  internalPath: string;
  imgVersion: number;
  frameCount: number;
  metadataSha256: string;
}

describe("ProfessionSourceContextRepository.resolveSkillSourceContext", () => {
  it("restores the payload-frozen Entry order while holding the Job row lock", async () => {
    // 数据库故意倒序返回；调用方只能收到 Job 中已冻结的顺序，不能依赖查询偶然顺序选择 IMG。
    const harness = repositoryHarness({
      entryRows: validEntryRows().reverse(),
    });

    await expect(
      harness.repository.resolveSkillSourceContext(jobId, request()),
    ).resolves.toEqual({
      status: "accepted",
      context: {
        schemaVersion: 1,
        skillId,
        source: {
          runId: sourceRunId,
          inventoryId: sourceInventoryId,
          byteLength: 956_090,
          sha256: sourceSha256,
        },
        frameManifest: {
          artifactId: manifestArtifactId,
          mediaType: "application/json",
          byteLength: 4_096,
          sha256: manifestSha256,
          toolSha256,
        },
        entries: [
          expect.objectContaining({
            sourceInventoryEntryId: firstEntryId,
            internalPath: "sprite/effect/first.img",
          }),
          expect.objectContaining({
            sourceInventoryEntryId: secondEntryId,
            internalPath: "sprite/effect/second.img",
          }),
        ],
      },
    });
    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.forUpdate).toHaveBeenCalledWith("update");
    expect(harness.select).toHaveBeenCalledTimes(4);
  });

  it("rejects the whole context when one frozen Entry hash drifts", async () => {
    // 任一 Entry 摘要漂移都禁止返回其余合法路径，避免 Worker 用半套来源继续生产。
    const rows = validEntryRows();
    const secondRow = rows[1];
    if (!secondRow) throw new Error("TEST_SECOND_ENTRY_REQUIRED");
    rows[1] = { ...secondRow, metadataSha256: "F".repeat(64) };
    const harness = repositoryHarness({ entryRows: rows });

    await expect(
      harness.repository.resolveSkillSourceContext(jobId, request()),
    ).resolves.toEqual({ status: "source-evidence-mismatch" });
  });

  it("rejects a manifest Artifact whose provenance no longer identifies the frozen source", async () => {
    // Artifact ID 和 Run 一致仍不够；来源摘要或固定角色漂移时不能把任意 JSON 当作逐帧清单。
    const harness = repositoryHarness({
      sourceRow: {
        ...validSourceRow(),
        manifestProvenance: {
          ...validSourceRow().manifestProvenance,
          sourceSha256: "F".repeat(64),
        },
      },
    });

    await expect(
      harness.repository.resolveSkillSourceContext(jobId, request()),
    ).resolves.toEqual({ status: "source-evidence-mismatch" });
    expect(harness.select).toHaveBeenCalledTimes(3);
  });
});

function request(): RequestProfessionSkillExecutionInput {
  return { workerId, leaseId, attempt: 2, skillId };
}

function repositoryHarness(options?: {
  sourceRow?: ReturnType<typeof validSourceRow>;
  entryRows?: ReturnType<typeof validEntryRows>;
}): SourceContextRepositoryHarness {
  const payload = validPayload();
  const persistedJob = {
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
  const forUpdate = vi.fn().mockResolvedValue([persistedJob]);
  const results = [
    [{ value: new Date("2026-07-24T00:00:00.000Z") }],
    [options?.sourceRow ?? validSourceRow()],
    options?.entryRows ?? validEntryRows(),
  ];
  let resultIndex = 0;
  const select = vi.fn(() => {
    if (select.mock.calls.length === 1) {
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: forUpdate })),
          })),
        })),
      };
    }
    const result = results[resultIndex] ?? [];
    resultIndex += 1;
    const terminal = Promise.resolve(result);
    return {
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(result),
          })),
        })),
        where: vi.fn(() => terminal),
        limit: vi.fn().mockResolvedValue(result),
      })),
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
    repository: new ProfessionSourceContextRepository(connection),
    transaction,
    select,
    forUpdate,
  };
}

function validSourceRow(): SourceRowFixture {
  return {
    runId: sourceRunId,
    inventoryId: sourceInventoryId,
    sourceByteLength: 956_090,
    sourceSha256,
    manifestArtifactId,
    manifestLogicalName: "source-frame-manifest.json",
    manifestMediaType: "application/json",
    manifestByteLength: 4_096,
    manifestSha256,
    manifestProvenance: {
      schemaVersion: 1,
      kind: "source-frame-manifest",
      sourceSha256,
      toolSha256,
      jobPayloadSha256: "1".repeat(64),
      deploymentAuthorized: false,
    },
  };
}

function validEntryRows(): EntryRowFixture[] {
  return [
    {
      id: firstEntryId,
      internalPath: "sprite/effect/first.img",
      imgVersion: 5,
      frameCount: 12,
      metadataSha256: "A".repeat(64),
    },
    {
      id: secondEntryId,
      internalPath: "sprite/effect/second.img",
      imgVersion: 5,
      frameCount: 18,
      metadataSha256: "B".repeat(64),
    },
  ];
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
      sourceRunId,
      sourceInventoryId,
      sourceFrameManifestArtifactId: manifestArtifactId,
      sourceEntries: [
        {
          sourceInventoryEntryId: firstEntryId,
          sourceMetadataSha256: "A".repeat(64),
        },
        {
          sourceInventoryEntryId: secondEntryId,
          sourceMetadataSha256: "B".repeat(64),
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
