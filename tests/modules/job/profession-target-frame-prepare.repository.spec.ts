/**
 * @fileoverview 验证 V6 target-frame prepare Repository 的合同早拒绝、完整幂等、部分行冲突和
 * 首次单批插入；不连接真实 MySQL 或对象存储，也不证明行锁竞争、限制性外键和事务回滚语义。
 * @module modules/job/profession-target-frame-prepare-repository-spec
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：Vitest 以按查询顺序返回证据的最小 Drizzle transaction stub 调用真实 Repository；
 * fixture 使用真实 V2/V3 payload 构造器、规范摘要和逐帧行投影。stub 替代数据库驱动，因此本测试只
 * 证明查询编排与内存门禁，真实自外键、死锁和并发幂等仍需 `npm run test:mysql` 证明。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../../src/common/db/database.service.js";
import {
  sha256JcsV1,
  sha256Json,
} from "../../../src/common/utils/canonical.js";
import type {
  PrepareProfessionTargetFramesInput,
  ProfessionTargetFramePreparationView,
} from "../../../src/modules/job/profession-target-frame-prepare.contracts.js";
import {
  ProfessionTargetFramePrepareRepository,
  type ProfessionTargetFramePreparationRead,
} from "../../../src/modules/job/profession-target-frame-prepare.repository.js";
import { createProfessionTargetFrameRows } from "../../../src/modules/job/profession-target-frame-prepare.repository-support.js";
import type { ProfessionTargetFrameManifest } from "../../../src/modules/job/profession-target-frame-manifest.js";
import { createStyleSkillProductionJobPayload } from "../../../src/modules/job/style-skill-production.contracts.js";
import type { StyleBuildContext } from "../../../src/modules/profession/profession.contracts.js";

const jobId = "00000000-0000-4000-8000-000000000000";
const runId = "11111111-1111-4111-8111-111111111111";
const workerId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const professionId = "44444444-4444-4444-8444-444444444444";
const styleId = "55555555-5555-4555-8555-555555555555";
const skillId = "66666666-6666-4666-8666-666666666666";
const sourceRunId = "77777777-7777-4777-8777-777777777777";
const sourceInventoryId = "88888888-8888-4888-8888-888888888888";
const sourceManifestArtifactId = "99999999-9999-4999-8999-999999999999";
const manifestArtifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const manifestUploadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sourceSha256 = "A".repeat(64);
const sourceManifestSha256 = "B".repeat(64);
const manifestSha256 = "C".repeat(64);
const sourceToolSha256 = "D".repeat(64);
const now = new Date("2026-07-30T00:00:00.000Z");
interface RepositoryHarness {
  repository: ProfessionTargetFramePrepareRepository;
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  insertedValues: unknown[];
}

interface RepositoryFixture {
  input: PrepareProfessionTargetFramesInput;
  manifest: ProfessionTargetFrameManifest;
  read: ProfessionTargetFramePreparationRead;
  existingRows: ReturnType<typeof createProfessionTargetFrameRows>;
  preparation: ProfessionTargetFramePreparationView;
  job: Record<string, unknown>;
  production: Record<string, unknown>;
  target: Record<string, unknown>;
  source: Record<string, unknown>;
}

interface QueryChain {
  from(...arguments_: unknown[]): QueryChain;
  innerJoin(...arguments_: unknown[]): QueryChain;
  where(...arguments_: unknown[]): QueryChain;
  limit(...arguments_: unknown[]): QueryChain;
  orderBy(...arguments_: unknown[]): QueryChain;
  for(mode: string): Promise<unknown[]>;
  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?:
      | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

describe("ProfessionTargetFramePrepareRepository", () => {
  it("V2 合同在 Artifact 查询前拒绝", async () => {
    // 可解析的历史 V2 仍不具备逐帧生产能力；拒绝后不得接触上传会话或写逐帧表。
    const fixture = validFixture(1);
    const harness = repositoryHarness([[fixture.job], [{ value: now }]]);

    await expect(
      harness.repository.inspect(jobId, fixture.input),
    ).resolves.toEqual({ status: "job-contract-mismatch" });
    expect(harness.select).toHaveBeenCalledTimes(2);
    expect(harness.insert).not.toHaveBeenCalled();
  });

  it("完整已有行幂等返回且不插入", async () => {
    const fixture = validFixture(2);
    const harness = repositoryHarness(
      lockedEvidenceRows(fixture, fixture.existingRows),
    );

    await expect(
      harness.repository.inspect(jobId, fixture.input),
    ).resolves.toEqual({
      status: "prepared",
      preparation: fixture.preparation,
    });
    expect(harness.select).toHaveBeenCalledTimes(6);
    expect(harness.insert).not.toHaveBeenCalled();
  });

  it("接受当前租约已上报 generating 的生产行", async () => {
    const fixture = validFixture(2);
    fixture.production = {
      ...fixture.production,
      status: "generating",
      jobId,
      workerId,
      leaseId,
      attempt: fixture.input.attempt,
    };
    const harness = repositoryHarness(
      lockedEvidenceRows(fixture, fixture.existingRows),
    );

    await expect(
      harness.repository.inspect(jobId, fixture.input),
    ).resolves.toEqual({
      status: "prepared",
      preparation: fixture.preparation,
    });
  });

  it("拒绝旧 attempt 留下的 generating 生产行", async () => {
    const fixture = validFixture(2);
    fixture.production = {
      ...fixture.production,
      status: "generating",
      jobId,
      workerId,
      leaseId,
      attempt: fixture.input.attempt - 1,
    };
    const harness = repositoryHarness([
      [fixture.job],
      [{ value: now }],
      [fixture.production],
    ]);

    await expect(
      harness.repository.inspect(jobId, fixture.input),
    ).resolves.toEqual({ status: "skill-production-evidence-mismatch" });
  });

  it("部分已有行不能冒充幂等成功", async () => {
    // 同一 manifest 只剩一部分行时必须冲突，不能重读对象后补齐而掩盖历史事务异常。
    const fixture = validFixture(2);
    const harness = repositoryHarness(
      lockedEvidenceRows(fixture, fixture.existingRows.slice(0, 1)),
    );

    await expect(
      harness.repository.inspect(jobId, fixture.input),
    ).resolves.toEqual({ status: "preparation-conflict" });
    expect(harness.insert).not.toHaveBeenCalled();
  });

  it("首次 commit 重新复核证据后只执行一次全量批插入", async () => {
    const fixture = validFixture(2);
    const harness = repositoryHarness([
      ...lockedEvidenceRows(fixture, []),
      [{ value: now }],
    ]);

    await expect(
      harness.repository.commit(
        jobId,
        fixture.input,
        fixture.manifest,
        fixture.read,
      ),
    ).resolves.toEqual({
      status: "prepared",
      preparation: fixture.preparation,
    });
    expect(harness.insert).toHaveBeenCalledOnce();
    expect(harness.insertedValues).toHaveLength(1);
    expect(harness.insertedValues[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ frameOrdinal: 0, skillId }),
        expect.objectContaining({ frameOrdinal: 1, skillId }),
      ]),
    );
  });
});

function repositoryHarness(selectRows: unknown[][]): RepositoryHarness {
  let selectIndex = 0;
  const select = vi.fn(() => queryChain(selectRows[selectIndex++] ?? []));
  const insertedValues: unknown[] = [];
  const insert = vi.fn(() => ({
    values: vi.fn((values: unknown) => {
      insertedValues.push(values);
      return Promise.resolve();
    }),
  }));
  const transaction = vi.fn((callback: (transaction: unknown) => unknown) =>
    Promise.resolve(callback({ select, insert })),
  );
  return {
    repository: new ProfessionTargetFramePrepareRepository({
      database: { transaction },
    } as unknown as DatabaseService),
    select,
    insert,
    insertedValues,
  };
}

function queryChain(rows: unknown[]): QueryChain {
  const result = Promise.resolve(rows);
  const chain: QueryChain = {
    from: (): QueryChain => chain,
    innerJoin: (): QueryChain => chain,
    where: (): QueryChain => chain,
    limit: (): QueryChain => chain,
    orderBy: (): QueryChain => chain,
    for: (): Promise<unknown[]> => result,
    then: <TResult1 = unknown[], TResult2 = never>(
      onfulfilled?:
        | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): Promise<TResult1 | TResult2> => result.then(onfulfilled, onrejected),
  };
  return chain;
}

function lockedEvidenceRows(
  fixture: ReturnType<typeof validFixture>,
  existingRows: readonly unknown[],
): unknown[][] {
  return [
    [fixture.job],
    [{ value: now }],
    [fixture.production],
    [fixture.target],
    [fixture.source],
    [...existingRows],
  ];
}

function validFixture(contractVersion: 1 | 2): RepositoryFixture {
  const context = buildContext();
  const payload =
    contractVersion === 2
      ? createStyleSkillProductionJobPayload(
          context,
          "aseprite-production-v6",
          2,
        )
      : createStyleSkillProductionJobPayload(
          context,
          "aseprite-production-v1",
          1,
        );
  const payloadSha256 = sha256Json(payload);
  const manifest = targetManifest();
  const input: PrepareProfessionTargetFramesInput = {
    workerId,
    leaseId,
    attempt: 2,
    skillId,
    manifestArtifactId,
    manifestMediaType: "application/json",
    manifestByteLength: 4_096,
    manifestSha256,
  };
  const targetProvenance = {
    schemaVersion: 1 as const,
    kind: "profession-target-frame-manifest-v1" as const,
    jobId,
    runId,
    jobPayloadSha256: payloadSha256,
    attempt: 2,
    skillId,
    sourceRunId,
    sourceInventoryId,
    sourceFrameManifestArtifactId: sourceManifestArtifactId,
    sourceFrameManifestSha256: sourceManifestSha256,
    sourceSha256,
    frameCount: 2,
    targetFrameCount: 1,
    targetPixelCount: 12,
    deploymentAuthorized: false as const,
  };
  const read = {
    target: {
      objectKey: "artifacts/target-manifest.json",
      expectedMediaType: "application/json",
      expectedByteLength: 4_096,
      expectedSha256: manifestSha256,
      maxByteLength: 16 * 1024 * 1024,
    },
    source: {
      objectKey: "artifacts/source-manifest.json",
      expectedMediaType: "application/json",
      expectedByteLength: 8_192,
      expectedSha256: sourceManifestSha256,
      maxByteLength: 64 * 1024 * 1024,
    },
    targetProvenance,
    sourceByteLength: 123_456,
    sourceToolSha256,
    frozenEntries: [{ sourceMetadataSha256: "E".repeat(64) }],
  };
  const existingRows = createProfessionTargetFrameRows(manifest, {
    runId,
    jobId,
    workerId,
    leaseId,
    attempt: 2,
    skillId,
    manifestArtifactId,
    manifestUploadId,
    manifestSha256,
    sourceRunId,
    sourceFrameManifestArtifactId: sourceManifestArtifactId,
    sourceFrameManifestSha256: sourceManifestSha256,
    sourceSha256,
    createdAt: now,
  }).sort((left, right) => left.frameOrdinal - right.frameOrdinal);
  const skill = payload.parameters.promptPackage.skills[0];
  if (!skill) throw new Error("TEST_SKILL_REQUIRED");
  return {
    input,
    manifest,
    read,
    existingRows,
    preparation: {
      schemaVersion: 1 as const,
      status: "prepared" as const,
      skillId,
      manifestArtifactId,
      frameCount: 2,
      targetFrameCount: 1,
      targetPixelCount: 12,
    },
    job: {
      id: jobId,
      runId,
      kind: "profession",
      status: "leased",
      leaseOwnerId: workerId,
      leaseId,
      leaseExpiresAt: new Date("2026-07-30T00:01:00.000Z"),
      attemptCount: 2,
      payload,
      payloadSha256,
    },
    production: {
      professionId,
      styleId,
      sourceRunId,
      sourceFrameManifestArtifactId: sourceManifestArtifactId,
      promptSha256: skill.promptSha256,
      status: "planned",
      finishedAt: null,
    },
    target: {
      uploadId: manifestUploadId,
      objectKey: read.target.objectKey,
      uploadLogicalName: `profession-target-frame-manifest-${skillId}.json`,
      uploadMediaType: "application/json",
      uploadByteLength: input.manifestByteLength,
      uploadSha256: manifestSha256,
      uploadProvenance: targetProvenance,
      finalizedAt: now,
      objectDeletedAt: null,
      artifactLogicalName: `profession-target-frame-manifest-${skillId}.json`,
      artifactStorageKey: read.target.objectKey,
      artifactMediaType: "application/json",
      artifactByteLength: input.manifestByteLength,
      artifactSha256: manifestSha256,
      artifactProvenance: targetProvenance,
    },
    source: {
      runId: sourceRunId,
      inventoryId: sourceInventoryId,
      sourceId: "official-source",
      sourceByteLength: read.sourceByteLength,
      sourceSha256,
      artifactId: sourceManifestArtifactId,
      logicalName: "source-frame-manifest.json",
      storageKey: read.source.objectKey,
      mediaType: "application/json",
      byteLength: read.source.expectedByteLength,
      sha256: sourceManifestSha256,
      provenance: {
        schemaVersion: 1,
        kind: "source-frame-manifest",
        sourceId: "official-source",
        sourceSha256,
        toolSha256: sourceToolSha256,
        jobPayloadSha256: "F".repeat(64),
        deploymentAuthorized: false,
      },
    },
  };
}

function targetManifest(): ProfessionTargetFrameManifest {
  const identity = {
    type: "ARGB_8888",
    compressMode: "ZLIB",
    width: 4,
    height: 3,
    canvasWidth: 6,
    canvasHeight: 5,
    x: 1,
    y: 1,
    linkTargetIndex: null,
  };
  return {
    schemaVersion: 1,
    kind: "profession-target-frame-manifest-v1",
    sourceSha256,
    sourceFrameManifestSha256: sourceManifestSha256,
    targetFrameCount: 1,
    targetPixelCount: 12,
    entries: [
      {
        entryIndex: 0,
        internalPath: "sprite/effect/a.img",
        imgVersion: 5,
        frames: [
          {
            ...identity,
            frameIndex: 0,
            hidden: false,
            targetPolicy: "generate-same-size",
            sourceDecodedBgraSha256: "1".repeat(64),
            sourceAlphaSha256: "2".repeat(64),
          },
          {
            ...identity,
            frameIndex: 1,
            hidden: true,
            targetPolicy: "preserve-hidden-source",
            sourceDecodedBgraSha256: "3".repeat(64),
            sourceAlphaSha256: "4".repeat(64),
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
}

function buildContext(): StyleBuildContext {
  const professionPrompt = {
    schemaVersion: 1 as const,
    stableSemantics: "保留技能身份",
    commonPrompt: "保持源帧轮廓",
    sourceConstraints: "只处理已冻结来源",
    stageAcceptance: "逐帧满足来源约束",
  };
  return {
    profession: {
      id: professionId,
      name: "测试职业",
      slug: "test-profession",
      canonicalName: "测试职业",
      styleCount: 1,
      publishStatus: "private",
      workflowProjectId: "abababab-abab-4bab-8bab-abababababab",
      catalogSnapshotId: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc",
      updatedAt: now.toISOString(),
    },
    style: {
      id: styleId,
      professionId,
      name: "测试风格",
      description: "逐帧 prepare fixture",
      themeDefinition: {
        schemaVersion: 1,
        goal: "生成受来源约束的候选特效",
        baseStyle: "high contrast pixel effect",
        colorAnchors: [{ name: "主色", value: "#123456" }],
        materialRules: "保持清晰边缘",
        particleRules: "粒子遵循源帧节奏",
        layeringRules: "不改变层级语义",
        constraints: "不得新增人物或武器",
        acceptanceCriteria: "轮廓和时间轴可辨识",
        exclusions: "不修改命中范围",
      },
      selectedSkillIds: [skillId],
      skillPrompts: [
        {
          skillId,
          themePrompt: "暗蓝像素剑气",
          changes: "只调整材质和颜色",
          acceptanceCriteria: "保持源动作节奏",
          exclusions: "不增加人物内容",
        },
      ],
      publishStatus: "private",
      updatedAt: now.toISOString(),
    },
    skills: [
      {
        id: skillId,
        professionId,
        displayName: "测试技能",
        promptStatus: "reviewed",
        mappingStatus: "verified",
        executionStatus: "build-ready",
        sourceRunId,
        sourceInventoryId,
        sourceFrameManifestArtifactId: sourceManifestArtifactId,
        sourceEntries: [
          {
            sourceInventoryEntryId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            sourceMetadataSha256: "E".repeat(64),
          },
        ],
        professionPrompt,
        professionPromptSha256: sha256JcsV1(professionPrompt),
      },
    ],
    missingProfessionPromptSkillIds: [],
  };
}
