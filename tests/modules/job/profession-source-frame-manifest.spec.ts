/**
 * @fileoverview 验证 Server 对历史 source-frame-manifest V1 的正文、来源和逐帧结构复读；
 * 测试不访问数据库、对象存储、官方 NPK 或固定 Scanner。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseProfessionSourceFrameManifestBytes,
  ProfessionSourceFrameManifestError,
  type ProfessionSourceFrameManifest,
} from "../../../src/modules/job/profession-source-frame-manifest.js";

const sourceSha256 = "A".repeat(64);
const toolSha256 = "B".repeat(64);
const sourceByteLength = 123;

describe("parseProfessionSourceFrameManifestBytes", () => {
  it("接受与历史 Worker JSON.stringify 字节一致的官方逐帧清单", () => {
    const manifest = validManifest();
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");

    expect(parse(bytes)).toEqual(manifest);
  });

  it("拒绝语义相同但不符合历史唯一编码的 JSON", () => {
    const bytes = Buffer.from(JSON.stringify(validManifest(), null, 2), "utf8");

    expect(() => parse(bytes)).toThrow(ProfessionSourceFrameManifestError);
  });

  it("拒绝与官方源或 Artifact 摘要不一致的正文", () => {
    const bytes = Buffer.from(JSON.stringify(validManifest()), "utf8");

    expect(() =>
      parseProfessionSourceFrameManifestBytes({
        bytes,
        expectedSha256: "F".repeat(64),
        expectedSourceSha256: sourceSha256,
        expectedSourceByteLength: sourceByteLength,
        expectedToolSha256: toolSha256,
      }),
    ).toThrow(ProfessionSourceFrameManifestError);
    expect(() =>
      parseProfessionSourceFrameManifestBytes({
        bytes,
        expectedSha256: sha256(bytes),
        expectedSourceSha256: "E".repeat(64),
        expectedSourceByteLength: sourceByteLength,
        expectedToolSha256: toolSha256,
      }),
    ).toThrow(ProfessionSourceFrameManifestError);
  });

  it("拒绝 Frame/Hidden/LINK 聚合计数漂移", () => {
    const manifest = {
      ...validManifest(),
      entries: [...validManifest().entries],
    };
    const entry = manifest.entries[0];
    if (!entry) throw new Error("TEST_ENTRY_REQUIRED");
    entry.hiddenCount = 2;
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");

    expect(() => parse(bytes)).toThrow(ProfessionSourceFrameManifestError);
  });

  it("拒绝与条目身份不一致的 metadataSha256", () => {
    const manifest = validManifest();
    const entry = manifest.entries[0];
    if (!entry) throw new Error("TEST_ENTRY_REQUIRED");
    entry.metadataSha256 = "C".repeat(64);
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");

    expect(() => parse(bytes)).toThrow(ProfessionSourceFrameManifestError);
  });

  it("拒绝目标都在范围内但不能终止的 LINK 环", () => {
    const manifest = validManifest();
    const entry = manifest.entries[0];
    if (!entry) throw new Error("TEST_ENTRY_REQUIRED");
    entry.frames = [linkedFrame(0, 1), linkedFrame(1, 0)];
    entry.frameCount = 2;
    entry.linkCount = 2;
    entry.hiddenCount = 0;
    entry.metadataSha256 = metadataSha256(entry);
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");

    expect(() => parse(bytes)).toThrow(ProfessionSourceFrameManifestError);
  });
});

function parse(bytes: Uint8Array): ProfessionSourceFrameManifest {
  return parseProfessionSourceFrameManifestBytes({
    bytes,
    expectedSha256: sha256(bytes),
    expectedSourceSha256: sourceSha256,
    expectedSourceByteLength: sourceByteLength,
    expectedToolSha256: toolSha256,
  });
}

function validManifest(): ProfessionSourceFrameManifest {
  const entry = {
    internalPath: "sprite/effect/a.img",
    imgVersion: 5,
    frameCount: 3,
    linkCount: 1,
    hiddenCount: 1,
    metadataSha256: "",
    frames: [frame(0, false), frame(1, true), linkedFrame(2, 0)],
  };
  entry.metadataSha256 = metadataSha256(entry);
  return {
    schemaVersion: 1,
    kind: "source-frame-manifest",
    source: {
      label: "source.npk",
      byteLength: sourceByteLength,
      sha256: sourceSha256,
    },
    tool: { sha256: toolSha256 },
    safety: {
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
    entries: [entry],
  };
}

function frame(
  index: number,
  hidden: boolean,
): ProfessionSourceFrameManifest["entries"][number]["frames"][number] {
  return {
    index,
    type: "ARGB_8888",
    compressMode: "ZLIB",
    hidden,
    linkTargetIndex: null,
    width: 4,
    height: 3,
    canvasWidth: 6,
    canvasHeight: 5,
    x: 1,
    y: 1,
    decodedBgraSha256: index === 0 ? "D".repeat(64) : "E".repeat(64),
  };
}

function linkedFrame(
  index: number,
  linkTargetIndex: number,
): ProfessionSourceFrameManifest["entries"][number]["frames"][number] {
  return {
    index,
    type: "LINK",
    compressMode: "NONE",
    hidden: false,
    linkTargetIndex,
    width: 4,
    height: 3,
    canvasWidth: 6,
    canvasHeight: 5,
    x: 1,
    y: 1,
    decodedBgraSha256: null,
  };
}

function metadataSha256(input: {
  internalPath: string;
  imgVersion: number;
  frameCount: number;
  linkCount: number;
  hiddenCount: number;
}): string {
  return sha256(
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        internalPath: input.internalPath,
        imgVersion: input.imgVersion,
        frameCount: input.frameCount,
        linkCount: input.linkCount,
        hiddenCount: input.hiddenCount,
      }),
      "utf8",
    ),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}
