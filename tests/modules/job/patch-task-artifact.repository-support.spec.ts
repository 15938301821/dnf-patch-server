/**
 * @fileoverview 验证浏览器任务产物查询只返回同一 passed Run 的三个唯一 Package V3 Artifact；
 * 使用 Drizzle 查询 stub，不连接真实 MySQL 或对象存储，也不证明短期 URL 可下载。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - 完整实机验收发现浏览器缺少三项 Package Artifact
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../../src/common/db/database.service.js";
import { findPatchTaskArtifacts } from "../../../src/modules/job/patch-task-artifact.repository-support.js";

const runId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";
const artifactIds = {
  candidate: "33333333-3333-4333-8333-333333333333",
  manifest: "44444444-4444-4444-8444-444444444444",
  validation: "55555555-5555-4555-8555-555555555555",
};
const hashes = {
  candidate: "A".repeat(64),
  manifest: "B".repeat(64),
  validation: "C".repeat(64),
};

describe("findPatchTaskArtifacts", () => {
  it("returns candidate, manifest and validation in stable order when all terminal evidence matches", async () => {
    const connection = databaseStub([evidence()], artifactRows());

    await expect(
      findPatchTaskArtifacts(connection, runId, ownerUserId),
    ).resolves.toEqual([
      expect.objectContaining({
        role: "candidate",
        artifactId: artifactIds.candidate,
        sha256: hashes.candidate,
      }),
      expect.objectContaining({
        role: "manifest",
        artifactId: artifactIds.manifest,
        sha256: hashes.manifest,
      }),
      expect.objectContaining({
        role: "validation",
        artifactId: artifactIds.validation,
        sha256: hashes.validation,
      }),
    ]);
  });

  it("fails closed when two output roles reuse one Artifact", async () => {
    const aliased = evidence();
    aliased.validationArtifactId = artifactIds.candidate;

    await expect(
      findPatchTaskArtifacts(
        databaseStub([aliased], artifactRows()),
        runId,
        ownerUserId,
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when finalized metadata no longer matches attempt SHA evidence", async () => {
    const rows = artifactRows();
    const validation = rows.find(
      (row) => row.artifactId === artifactIds.validation,
    );
    if (!validation) throw new Error("TEST_VALIDATION_ARTIFACT_REQUIRED");
    validation.sha256 = "D".repeat(64);

    await expect(
      findPatchTaskArtifacts(
        databaseStub([evidence()], rows),
        runId,
        ownerUserId,
      ),
    ).resolves.toBeUndefined();
  });
});

function evidence(): Record<string, string | null> {
  return {
    aggregatePackageArtifactId: artifactIds.candidate,
    aggregateManifestSha256: hashes.manifest,
    packageArtifactId: artifactIds.candidate,
    packageSha256: hashes.candidate,
    manifestArtifactId: artifactIds.manifest,
    manifestSha256: hashes.manifest,
    validationArtifactId: artifactIds.validation,
    validationSha256: hashes.validation,
  };
}

function artifactRows(): Array<{
  artifactId: string;
  artifactName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}> {
  return [
    {
      artifactId: artifactIds.validation,
      artifactName: "validation.json",
      mediaType: "application/json",
      byteLength: 300,
      sha256: hashes.validation,
    },
    {
      artifactId: artifactIds.candidate,
      artifactName: "candidate.npk",
      mediaType: "application/octet-stream",
      byteLength: 200,
      sha256: hashes.candidate,
    },
    {
      artifactId: artifactIds.manifest,
      artifactName: "manifest.json",
      mediaType: "application/json",
      byteLength: 100,
      sha256: hashes.manifest,
    },
  ];
}

function databaseStub(
  evidenceRows: Record<string, string | null>[],
  artifactsRows: ReturnType<typeof artifactRows>,
): DatabaseService {
  let selection = 0;
  const select = vi.fn(() => {
    const rows = selection === 0 ? evidenceRows : artifactsRows;
    selection += 1;
    const query = {
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn(() => Promise.resolve(rows)),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ): Promise<unknown> => Promise.resolve(rows).then(resolve, reject),
    };
    return { from: vi.fn(() => query) };
  });
  return { database: { select } } as unknown as DatabaseService;
}
