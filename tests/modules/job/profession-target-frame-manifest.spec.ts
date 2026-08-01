/**
 * @fileoverview 验证 Server 只接受来源绑定、预算自洽且采用唯一 JCS 编码的 V6 target manifest。
 * 测试不访问数据库、对象存储或模型 Provider。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stableStringifyJcsV1 } from "../../../src/common/utils/canonical.js";
import {
  assertProfessionTargetFrameManifestMatchesSource,
  parseProfessionTargetFrameManifestBytes,
  ProfessionTargetFrameManifestError,
  type ProfessionTargetFrameManifest,
} from "../../../src/modules/job/profession-target-frame-manifest.js";
import type { ProfessionSourceFrameManifest } from "../../../src/modules/job/profession-source-frame-manifest.js";

const sourceSha256 = "A".repeat(64);
const sourceFrameManifestSha256 = "B".repeat(64);

describe("parseProfessionTargetFrameManifestBytes", () => {
  it("accepts one canonical same-size target bound to official source identities", () => {
    const manifest = validManifest();
    const bytes = Buffer.from(stableStringifyJcsV1(manifest), "utf8");

    expect(parse(bytes)).toEqual(manifest);
  });

  it("rejects semantically valid JSON whose bytes are not the unique JCS encoding", () => {
    const bytes = Buffer.from(JSON.stringify(validManifest(), null, 2), "utf8");

    expect(() => parse(bytes)).toThrow(ProfessionTargetFrameManifestError);
  });

  it("rejects a generated frame marked hidden", () => {
    const manifest = validManifest() as unknown as {
      entries: Array<{ frames: Array<{ hidden: boolean }> }>;
    };
    const frame = manifest.entries[0]?.frames[0];
    if (!frame) throw new Error("TEST_FRAME_REQUIRED");
    frame.hidden = true;
    const bytes = Buffer.from(stableStringifyJcsV1(manifest), "utf8");

    expect(() => parse(bytes)).toThrow(ProfessionTargetFrameManifestError);
  });

  it("rejects aggregate frame and pixel counts that do not match entries", () => {
    const manifest = { ...validManifest(), targetPixelCount: 11 };
    const bytes = Buffer.from(stableStringifyJcsV1(manifest), "utf8");

    expect(() => parse(bytes)).toThrow(ProfessionTargetFrameManifestError);
  });

  it("rejects an Artifact digest or official source identity mismatch", () => {
    const bytes = Buffer.from(stableStringifyJcsV1(validManifest()), "utf8");

    expect(() =>
      parseProfessionTargetFrameManifestBytes({
        bytes,
        expectedSha256: "C".repeat(64),
        expectedSourceSha256: sourceSha256,
        expectedSourceFrameManifestSha256: sourceFrameManifestSha256,
      }),
    ).toThrow(ProfessionTargetFrameManifestError);
    expect(() =>
      parseProfessionTargetFrameManifestBytes({
        bytes,
        expectedSha256: sha256(bytes),
        expectedSourceSha256: "D".repeat(64),
        expectedSourceFrameManifestSha256: sourceFrameManifestSha256,
      }),
    ).toThrow(ProfessionTargetFrameManifestError);
  });

  it("rejects an out-of-entry LINK target", () => {
    const manifest = validManifest();
    manifest.entries[0]?.frames.push({
      frameIndex: 1,
      type: "LINK",
      compressMode: "NONE",
      hidden: false,
      width: 4,
      height: 3,
      canvasWidth: 6,
      canvasHeight: 5,
      x: 1,
      y: 1,
      targetPolicy: "reuse-link-target",
      linkTargetIndex: 2,
      sourceDecodedBgraSha256: null,
      sourceAlphaSha256: null,
    });
    const bytes = Buffer.from(stableStringifyJcsV1(manifest), "utf8");

    expect(() => parse(bytes)).toThrow(ProfessionTargetFrameManifestError);
  });

  it("rejects a LINK cycle even when every target stays inside the entry", () => {
    const manifest = validManifest();
    manifest.entries[0]?.frames.push(linkedFrame(1, 2), linkedFrame(2, 1));
    const bytes = Buffer.from(stableStringifyJcsV1(manifest), "utf8");

    expect(() => parse(bytes)).toThrow(ProfessionTargetFrameManifestError);
  });
});

describe("assertProfessionTargetFrameManifestMatchesSource", () => {
  it("accepts a target whose frozen entry and every source frame field match", () => {
    expect(() => {
      assertProfessionTargetFrameManifestMatchesSource(
        validManifest(),
        sourceManifest(),
        [{ sourceMetadataSha256: "E".repeat(64) }],
      );
    }).not.toThrow();
  });

  it("rejects target geometry or BGRA evidence drift from the source manifest", () => {
    const target = validManifest();
    const frame = target.entries[0]?.frames[0];
    if (!frame) throw new Error("TEST_FRAME_REQUIRED");
    frame.canvasWidth += 1;

    expect(() => {
      assertProfessionTargetFrameManifestMatchesSource(
        target,
        sourceManifest(),
        [{ sourceMetadataSha256: "E".repeat(64) }],
      );
    }).toThrow(ProfessionTargetFrameManifestError);
  });

  it("rejects an entry selected by path instead of the payload-frozen metadata digest", () => {
    expect(() => {
      assertProfessionTargetFrameManifestMatchesSource(
        validManifest(),
        sourceManifest(),
        [{ sourceMetadataSha256: "F".repeat(64) }],
      );
    }).toThrow(ProfessionTargetFrameManifestError);
  });
});

function linkedFrame(
  frameIndex: number,
  linkTargetIndex: number,
): ProfessionTargetFrameManifest["entries"][number]["frames"][number] {
  return {
    frameIndex,
    type: "LINK",
    compressMode: "NONE",
    hidden: false,
    width: 4,
    height: 3,
    canvasWidth: 6,
    canvasHeight: 5,
    x: 1,
    y: 1,
    targetPolicy: "reuse-link-target",
    linkTargetIndex,
    sourceDecodedBgraSha256: null,
    sourceAlphaSha256: null,
  };
}

function parse(bytes: Uint8Array): ProfessionTargetFrameManifest {
  return parseProfessionTargetFrameManifestBytes({
    bytes,
    expectedSha256: sha256(bytes),
    expectedSourceSha256: sourceSha256,
    expectedSourceFrameManifestSha256: sourceFrameManifestSha256,
  });
}

function validManifest(): ProfessionTargetFrameManifest {
  return {
    schemaVersion: 1,
    kind: "profession-target-frame-manifest-v1",
    sourceSha256,
    sourceFrameManifestSha256,
    targetFrameCount: 1,
    targetPixelCount: 12,
    entries: [
      {
        entryIndex: 0,
        internalPath: "sprite/character/swordman/effect/test.img",
        imgVersion: 5,
        frames: [
          {
            frameIndex: 0,
            type: "ARGB_8888",
            compressMode: "ZLIB",
            hidden: false,
            width: 4,
            height: 3,
            canvasWidth: 6,
            canvasHeight: 5,
            x: 1,
            y: 1,
            targetPolicy: "generate-same-size",
            linkTargetIndex: null,
            sourceDecodedBgraSha256: "C".repeat(64),
            sourceAlphaSha256: "D".repeat(64),
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

function sourceManifest(): ProfessionSourceFrameManifest {
  return {
    schemaVersion: 1,
    kind: "source-frame-manifest",
    source: {
      label: "source.npk",
      byteLength: 123,
      sha256: sourceSha256,
    },
    tool: { sha256: "F".repeat(64) },
    safety: {
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
    entries: [
      {
        internalPath: "sprite/character/swordman/effect/test.img",
        imgVersion: 5,
        frameCount: 1,
        linkCount: 0,
        hiddenCount: 0,
        metadataSha256: "E".repeat(64),
        frames: [
          {
            index: 0,
            type: "ARGB_8888",
            compressMode: "ZLIB",
            hidden: false,
            linkTargetIndex: null,
            width: 4,
            height: 3,
            canvasWidth: 6,
            canvasHeight: 5,
            x: 1,
            y: 1,
            decodedBgraSha256: "C".repeat(64),
          },
        ],
      },
    ],
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}
