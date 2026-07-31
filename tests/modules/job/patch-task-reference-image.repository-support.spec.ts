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
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../../src/common/db/database.service.js";
import {
  findPatchTaskReferenceImage,
  findPatchTaskSkillPreview,
} from "../../../src/modules/job/patch-task-reference-image.repository-support.js";
import {
  createCreativeResultPreviewProvenance,
  createCreativeSourcePreviewProvenance,
  createCreativeValidationProvenance,
  currentStableFrameQualityEvidence,
  historicalStableFrameQualityEvidence,
  historicalStableFrameQualityV3Evidence,
  historicalStableFrameQualityV4Evidence,
  productionPreviewPublicFrame,
} from "./fixtures/patch-task-production-preview.fixture.js";

const runId = "11111111-1111-4111-8111-111111111111";
const skillId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "33333333-3333-4333-8333-333333333333";
const jobId = "55555555-5555-4555-8555-555555555555";
const workerId = "66666666-6666-4666-8666-666666666666";
const leaseId = "77777777-7777-4777-8777-777777777777";
const validationArtifactId = "88888888-8888-4888-8888-888888888888";
const sourceArtifactId = "99999999-9999-4999-8999-999999999999";
const resultArtifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const previewEvidenceIdentity = {
  jobId,
  skillId,
  validationArtifactId,
  sourceArtifactId,
};
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

  it("limits downloads to current and historical fixed Artist stages", async () => {
    let where: SQL | undefined;

    await findPatchTaskReferenceImage(
      databaseStub([image], (condition) => {
        where = condition;
      }),
      runId,
      skillId,
      ownerUserId,
    );

    if (!where) throw new Error("TEST_REFERENCE_IMAGE_WHERE_REQUIRED");
    const query = new MySqlDialect().sqlToQuery(where);
    expect(
      query.params.filter(
        (parameter): parameter is string =>
          typeof parameter === "string" &&
          parameter.startsWith("reference-image-"),
      ),
    ).toEqual([
      "reference-image-v3",
      "reference-image-v2",
      "reference-image-v1",
    ]);
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
  it("returns current V5 source preview with stable-frame Quality V5", async () => {
    const validation = createCreativeValidationProvenance(
      previewEvidenceIdentity,
    );
    const source = createCreativeSourcePreviewProvenance(
      previewEvidenceIdentity,
    );

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
    ).resolves.toMatchObject({
      artifactId: sourceArtifactId,
      role: "source-frame",
      referenceTransferQuality: currentStableFrameQualityEvidence(),
    });
  });

  it("keeps complete historical V4 source preview readable", async () => {
    const generation = "historical-v4" as const;
    const validation = createCreativeValidationProvenance(
      previewEvidenceIdentity,
      generation,
    );
    const source = createCreativeSourcePreviewProvenance(
      previewEvidenceIdentity,
      generation,
    );

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
    ).resolves.toMatchObject({
      artifactId: sourceArtifactId,
      referenceTransferQuality: historicalStableFrameQualityV4Evidence(),
    });
  });

  it("keeps old V4 source preview readable with historical quality V3", async () => {
    const generation = "historical-quality-v3" as const;
    const validation = createCreativeValidationProvenance(
      previewEvidenceIdentity,
      generation,
    );
    const source = createCreativeSourcePreviewProvenance(
      previewEvidenceIdentity,
      generation,
    );

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
    ).resolves.toMatchObject({
      artifactId: sourceArtifactId,
      referenceTransferQuality: historicalStableFrameQualityV3Evidence(),
    });
  });

  it("keeps historical V3 source preview readable with quality V2", async () => {
    const validation = createCreativeValidationProvenance(
      previewEvidenceIdentity,
      "historical-v3",
    );
    const source = createCreativeSourcePreviewProvenance(
      previewEvidenceIdentity,
      "historical-v3",
    );

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
      frame: productionPreviewPublicFrame(),
      referenceTransferQuality: historicalStableFrameQualityEvidence(),
    });
  });

  it("returns current V5 result only when it binds the same V5 source frame", async () => {
    const validation = createCreativeValidationProvenance(
      previewEvidenceIdentity,
    );
    const source = createCreativeSourcePreviewProvenance(
      previewEvidenceIdentity,
    );
    const result = createCreativeResultPreviewProvenance(
      previewEvidenceIdentity,
    );

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
      frame: productionPreviewPublicFrame(),
      referenceTransferQuality: currentStableFrameQualityEvidence(),
    });
  });

  it("keeps historical V3 result readable when it binds the same V3 source", async () => {
    const validation = createCreativeValidationProvenance(
      previewEvidenceIdentity,
      "historical-v3",
    );
    const source = createCreativeSourcePreviewProvenance(
      previewEvidenceIdentity,
      "historical-v3",
    );
    const result = createCreativeResultPreviewProvenance(
      previewEvidenceIdentity,
      { generation: "historical-v3" },
    );

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
      referenceTransferQuality: historicalStableFrameQualityEvidence(),
    });
  });

  it("keeps a historical task usable when the new source preview is absent", async () => {
    const validation = createCreativeValidationProvenance(
      previewEvidenceIdentity,
      "historical-v3",
    );

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
    const validation = createCreativeValidationProvenance(
      previewEvidenceIdentity,
    );
    const source = createCreativeSourcePreviewProvenance(
      previewEvidenceIdentity,
    );
    const result = createCreativeResultPreviewProvenance(
      previewEvidenceIdentity,
      { frameOverrides: { frameIndex: 4 } },
    );

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

  it("rejects a historical V3 source under current V5 validation", async () => {
    const validation = createCreativeValidationProvenance(
      previewEvidenceIdentity,
    );
    const historicalSource = createCreativeSourcePreviewProvenance(
      previewEvidenceIdentity,
      "historical-v3",
    );

    await expect(
      findPatchTaskSkillPreview(
        sequentialDatabaseStub([
          [productionContext(validation)],
          [previewRow(sourceArtifactId, "source-frame", historicalSource)],
        ]),
        runId,
        skillId,
        "source-frame",
        ownerUserId,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a historical V3 result after matching V4 validation and source", async () => {
    const validation = createCreativeValidationProvenance(
      previewEvidenceIdentity,
    );
    const source = createCreativeSourcePreviewProvenance(
      previewEvidenceIdentity,
    );
    const historicalResult = createCreativeResultPreviewProvenance(
      previewEvidenceIdentity,
      { generation: "historical-v3" },
    );

    await expect(
      findPatchTaskSkillPreview(
        sequentialDatabaseStub([
          [productionContext(validation)],
          [previewRow(sourceArtifactId, "source-frame", source)],
          [previewRow(resultArtifactId, "aseprite-result", historicalResult)],
        ]),
        runId,
        skillId,
        "aseprite-result",
        ownerUserId,
      ),
    ).resolves.toBeUndefined();
  });
});

function databaseStub(
  rows: unknown[],
  onWhere?: (condition: SQL) => void,
): DatabaseService {
  const query = {
    innerJoin: vi.fn(() => query),
    where: vi.fn((condition: SQL) => {
      onWhere?.(condition);
      return query;
    }),
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
