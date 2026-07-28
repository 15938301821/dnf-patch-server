/**
 * @fileoverview 验证任务技能三类预览查询只接受唯一的当前 attempt passed PNG 投影；使用 Drizzle
 * 查询 stub，不连接真实 MySQL、对象存储或模型 Provider。
 * @module modules/job/patch-task-reference-image-repository-support-spec
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan /memories/session/plan.md - 制作任务详情与模型吞吐监控
 *
 * 测试证明 Repository 对零行和多行结果失败关闭，并保持固定 PNG ViewModel；SQL 中的用户、Run、
 * skill、attempt 与 stage 联接仍需隔离 MySQL 验证，stub 不能证明数据库执行计划或外键语义。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../common/db/database.service.js";
import {
  findPatchTaskReferenceImage,
  findPatchTaskSkillPreview,
} from "./patch-task-reference-image.repository-support.js";

const runId = "11111111-1111-4111-8111-111111111111";
const skillId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "33333333-3333-4333-8333-333333333333";
const jobId = "55555555-5555-4555-8555-555555555555";
const workerId = "66666666-6666-4666-8666-666666666666";
const leaseId = "77777777-7777-4777-8777-777777777777";
const validationArtifactId = "88888888-8888-4888-8888-888888888888";
const sourceArtifactId = "99999999-9999-4999-8999-999999999999";
const resultArtifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const image = {
  artifactId: "44444444-4444-4444-8444-444444444444",
  skillId,
  artifactName: "reference.png",
  mediaType: "image/png",
  byteLength: 512,
  sha256: "A".repeat(64),
};

describe("findPatchTaskReferenceImage", () => {
  it("returns the unique fixed PNG projection", async () => {
    await expect(
      findPatchTaskReferenceImage(
        databaseStub([image]),
        runId,
        skillId,
        ownerUserId,
      ),
    ).resolves.toEqual(image);
  });

  it("fails closed when no current evidence matches", async () => {
    await expect(
      findPatchTaskReferenceImage(
        databaseStub([]),
        runId,
        skillId,
        ownerUserId,
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when duplicate passed evidence would make the role ambiguous", async () => {
    await expect(
      findPatchTaskReferenceImage(
        databaseStub([image, { ...image, artifactId: crypto.randomUUID() }]),
        runId,
        skillId,
        ownerUserId,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("findPatchTaskSkillPreview", () => {
  it("returns the fixed source PNG without exposing the decoded pixel digest", async () => {
    const validation = validationProvenance();
    const source = sourcePreviewProvenance();

    await expect(
      findPatchTaskSkillPreview(
        sequentialDatabaseStub([
          [productionContext(validation)],
          [previewRow(sourceArtifactId, "source-frame", source)],
        ]),
        runId,
        skillId,
        "source-frame",
        ownerUserId,
      ),
    ).resolves.toEqual({
      artifactId: sourceArtifactId,
      skillId,
      role: "source-frame",
      artifactName: "profession-source-frame-preview.png",
      mediaType: "image/png",
      byteLength: 256,
      sha256: "5".repeat(64),
      frame: publicFrame(),
    });
  });

  it("returns the Aseprite result only when it binds the same source frame", async () => {
    const validation = validationProvenance();
    const source = sourcePreviewProvenance();
    const result = resultPreviewProvenance();

    await expect(
      findPatchTaskSkillPreview(
        sequentialDatabaseStub([
          [productionContext(validation)],
          [previewRow(sourceArtifactId, "source-frame", source)],
          [previewRow(resultArtifactId, "aseprite-result", result)],
        ]),
        runId,
        skillId,
        "aseprite-result",
        ownerUserId,
      ),
    ).resolves.toMatchObject({
      artifactId: resultArtifactId,
      role: "aseprite-result",
      frame: publicFrame(),
    });
  });

  it("keeps a historical task usable when the new source preview is absent", async () => {
    const validation = validationProvenance();

    await expect(
      findPatchTaskSkillPreview(
        sequentialDatabaseStub([[productionContext(validation)], []]),
        runId,
        skillId,
        "source-frame",
        ownerUserId,
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the result preview drifts to another frame", async () => {
    const validation = validationProvenance();
    const source = sourcePreviewProvenance();
    const result = resultPreviewProvenance({
      frame: { ...comparisonFrame(), frameIndex: 4 },
    });

    await expect(
      findPatchTaskSkillPreview(
        sequentialDatabaseStub([
          [productionContext(validation)],
          [previewRow(sourceArtifactId, "source-frame", source)],
          [previewRow(resultArtifactId, "aseprite-result", result)],
        ]),
        runId,
        skillId,
        "aseprite-result",
        ownerUserId,
      ),
    ).resolves.toBeUndefined();
  });
});

function databaseStub(rows: unknown[]): DatabaseService {
  const query = {
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return {
    database: { select: vi.fn(() => ({ from: vi.fn(() => query) })) },
  } as unknown as DatabaseService;
}

function sequentialDatabaseStub(selectRows: unknown[][]): DatabaseService {
  let index = 0;
  return {
    database: {
      select: vi.fn(() => {
        const rows = selectRows[index] ?? [];
        index += 1;
        const query = {
          innerJoin: vi.fn(() => query),
          where: vi.fn(() => query),
          limit: vi.fn().mockResolvedValue(rows),
        };
        return { from: vi.fn(() => query) };
      }),
    },
  } as unknown as DatabaseService;
}

function productionContext(
  validation: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jobId,
    workerId,
    leaseId,
    attempt: 2,
    validationArtifactId,
    validationSha256: "4".repeat(64),
    validationProvenance: validation,
    validationUploadProvenance: validation,
  };
}

function previewRow(
  artifactId: string,
  role: "source-frame" | "aseprite-result",
  provenance: Record<string, unknown>,
): Record<string, unknown> {
  const source = role === "source-frame";
  const artifactName = source
    ? "profession-source-frame-preview.png"
    : "profession-aseprite-result-preview.png";
  const sha256 = (source ? "5" : "6").repeat(64);
  return {
    artifactId,
    artifactName,
    artifactMediaType: "image/png",
    artifactByteLength: 256,
    artifactSha256: sha256,
    artifactProvenance: provenance,
    sessionLogicalName: artifactName,
    sessionMediaType: "image/png",
    sessionByteLength: 256,
    sessionSha256: sha256,
    sessionProvenance: provenance,
  };
}

function validationProvenance(): Record<string, unknown> {
  return {
    ...baseProvenance(),
    kind: "profession-aseprite-validation-v1",
    asepriteProjects: {
      artifactId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sha256: "3".repeat(64),
    },
  };
}

function sourcePreviewProvenance(): Record<string, unknown> {
  return {
    ...baseProvenance(),
    kind: "profession-source-frame-preview-v1",
    frame: comparisonFrame(),
    asepriteValidation: {
      artifactId: validationArtifactId,
      sha256: "4".repeat(64),
    },
  };
}

function resultPreviewProvenance(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...baseProvenance(),
    kind: "profession-aseprite-result-preview-v1",
    frame: comparisonFrame(),
    asepriteValidation: {
      artifactId: validationArtifactId,
      sha256: "4".repeat(64),
    },
    sourcePreview: {
      artifactId: sourceArtifactId,
      sha256: "5".repeat(64),
    },
    ...overrides,
  };
}

function baseProvenance(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    jobId,
    attempt: 2,
    skillId,
    source: {
      runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      inventoryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sourceSha256: "A".repeat(64),
      frameManifestArtifactId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      frameManifestSha256: "B".repeat(64),
      frameManifestToolSha256: "C".repeat(64),
    },
    engineerPlan: {
      artifactId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      sha256: "D".repeat(64),
    },
    referenceImage: {
      imageAttemptId: "10101010-1010-4010-8010-101010101010",
      artifactId: "11111111-1111-4111-8111-111111111112",
      sha256: "E".repeat(64),
    },
    aseprite: {
      profileId: "aseprite-cli",
      binarySha256: "1".repeat(64),
      adapterSha256: "2".repeat(64),
    },
    safety: {
      referenceImageUsedForRuntimePixels: false,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
  };
}

function comparisonFrame(): Record<string, unknown> {
  return {
    ...publicFrame(),
    decodedBgraSha256: "7".repeat(64),
  };
}

function publicFrame(): Record<string, unknown> {
  return {
    entryIndex: 0,
    frameIndex: 3,
    internalPath: "sprite/effect/a.img",
    width: 16,
    height: 12,
    canvasWidth: 32,
    canvasHeight: 24,
    x: 2,
    y: -1,
  };
}
