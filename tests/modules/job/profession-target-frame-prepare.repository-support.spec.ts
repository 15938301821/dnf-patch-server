/**
 * @fileoverview 验证 V6 target manifest 的数据库行投影、LINK 拓扑顺序和完整幂等判定；
 * 测试不连接 MySQL，不证明真实自外键、事务锁或并发语义。
 */
import { describe, expect, it } from "vitest";
import {
  createProfessionTargetFrameRows,
  resolvePreparedProfessionTargetFrames,
  type ProfessionTargetFrameRowContext,
} from "../../../src/modules/job/profession-target-frame-prepare.repository-support.js";
import type { ProfessionTargetFrameManifest } from "../../../src/modules/job/profession-target-frame-manifest.js";

const context: ProfessionTargetFrameRowContext = {
  runId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  workerId: "33333333-3333-4333-8333-333333333333",
  leaseId: "44444444-4444-4444-8444-444444444444",
  attempt: 2,
  skillId: "55555555-5555-4555-8555-555555555555",
  manifestArtifactId: "66666666-6666-4666-8666-666666666666",
  manifestUploadId: "77777777-7777-4777-8777-777777777777",
  manifestSha256: "A".repeat(64),
  sourceRunId: "88888888-8888-4888-8888-888888888888",
  sourceFrameManifestArtifactId: "99999999-9999-4999-8999-999999999999",
  sourceFrameManifestSha256: "B".repeat(64),
  sourceSha256: "C".repeat(64),
  createdAt: new Date("2026-07-30T00:00:00.000Z"),
};

describe("profession target frame prepare repository support", () => {
  it("保留清单 ordinal，同时把前向 LINK 排在目标帧之后插入", () => {
    const rows = createProfessionTargetFrameRows(manifest(), context);

    expect(rows.map((row) => row.frameIndex)).toEqual([1, 2, 0]);
    expect(rows.map((row) => row.frameOrdinal).sort((a, b) => a - b)).toEqual([
      0, 1, 2,
    ]);
    expect(
      rows
        .filter((row) => row.generationOrdinal !== null)
        .map((row) => row.generationOrdinal),
    ).toEqual([0]);
  });

  it("完整同一 manifest 行集返回幂等 prepared 回执", () => {
    const rows = createProfessionTargetFrameRows(manifest(), context).sort(
      (left, right) => left.frameOrdinal - right.frameOrdinal,
    );

    expect(
      resolvePreparedProfessionTargetFrames(rows, {
        ...context,
        frameCount: 3,
        targetFrameCount: 1,
        targetPixelCount: 12,
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "prepared",
      skillId: context.skillId,
      manifestArtifactId: context.manifestArtifactId,
      frameCount: 3,
      targetFrameCount: 1,
      targetPixelCount: 12,
    });
  });

  it("部分行或换 manifest 不能冒充幂等成功", () => {
    const rows = createProfessionTargetFrameRows(manifest(), context).sort(
      (left, right) => left.frameOrdinal - right.frameOrdinal,
    );
    const expected = {
      ...context,
      frameCount: 3,
      targetFrameCount: 1,
      targetPixelCount: 12,
    };

    expect(
      resolvePreparedProfessionTargetFrames(rows.slice(0, 2), expected),
    ).toBeUndefined();
    expect(
      resolvePreparedProfessionTargetFrames(rows, {
        ...expected,
        manifestArtifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toBeUndefined();
  });
});

function manifest(): ProfessionTargetFrameManifest {
  const identity = {
    compressMode: "ZLIB",
    hidden: false as const,
    width: 4,
    height: 3,
    canvasWidth: 6,
    canvasHeight: 5,
    x: 1,
    y: 1,
  };
  return {
    schemaVersion: 1,
    kind: "profession-target-frame-manifest-v1",
    sourceSha256: context.sourceSha256,
    sourceFrameManifestSha256: context.sourceFrameManifestSha256,
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
            type: "LINK",
            compressMode: "NONE",
            targetPolicy: "reuse-link-target",
            linkTargetIndex: 2,
            sourceDecodedBgraSha256: null,
            sourceAlphaSha256: null,
          },
          {
            ...identity,
            frameIndex: 1,
            type: "ARGB_8888",
            targetPolicy: "generate-same-size",
            linkTargetIndex: null,
            sourceDecodedBgraSha256: "D".repeat(64),
            sourceAlphaSha256: "E".repeat(64),
          },
          {
            ...identity,
            frameIndex: 2,
            type: "LINK",
            compressMode: "NONE",
            targetPolicy: "reuse-link-target",
            linkTargetIndex: 1,
            sourceDecodedBgraSha256: null,
            sourceAlphaSha256: null,
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
