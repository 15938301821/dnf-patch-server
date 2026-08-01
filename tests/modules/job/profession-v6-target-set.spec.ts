/**
 * @fileoverview 验证Server V6 target-set复算与逐帧身份唯一性；不连接MySQL或对象存储。
 * @module modules/job/profession-v6-target-set-spec
 * @author AI生成
 * @created 2026-08-01
 * @relatedPlan N/A - 用户直接要求实现Profession V6
 *
 * Mock边界：测试直接构造数据库行会提供的字段，没有证明事务锁顺序或Artifact正文哈希。
 */
import { describe, expect, it } from "vitest";
import {
  createProfessionV6TargetSetSha256,
  type ProfessionV6TargetSetFrameEvidence,
} from "../../../src/modules/job/profession-v6-target-set.js";

const skillId = "11111111-1111-4111-8111-111111111111";
const first: ProfessionV6TargetSetFrameEvidence = {
  entryIndex: 0,
  frameIndex: 1,
  width: 64,
  height: 32,
  artifactId: "22222222-2222-4222-8222-222222222222",
  modelCallId: "33333333-3333-4333-8333-333333333333",
  imageAttemptId: "44444444-4444-4444-8444-444444444444",
  byteLength: 1_024,
  sha256: "A".repeat(64),
  sourceAlphaSha256: "B".repeat(64),
};
const second: ProfessionV6TargetSetFrameEvidence = {
  ...first,
  frameIndex: 2,
  artifactId: "55555555-5555-4555-8555-555555555555",
  modelCallId: "66666666-6666-4666-8666-666666666666",
  imageAttemptId: "77777777-7777-4777-8777-777777777777",
  sha256: "C".repeat(64),
};

describe("createProfessionV6TargetSetSha256", () => {
  it("creates a deterministic uppercase digest whose frame order is significant", () => {
    const digest = createProfessionV6TargetSetSha256(skillId, [first, second]);
    expect(digest).toMatch(/^[A-F0-9]{64}$/u);
    expect(createProfessionV6TargetSetSha256(skillId, [first, second])).toBe(
      digest,
    );
    expect(
      createProfessionV6TargetSetSha256(skillId, [second, first]),
    ).not.toBe(digest);
  });

  it.each([
    [
      "coordinate",
      { entryIndex: first.entryIndex, frameIndex: first.frameIndex },
    ],
    ["Artifact", { artifactId: first.artifactId }],
    ["ModelCall", { modelCallId: first.modelCallId }],
    ["ImageAttempt", { imageAttemptId: first.imageAttemptId }],
  ])("rejects duplicated %s identity", (_label, duplicate) => {
    expect(() =>
      createProfessionV6TargetSetSha256(skillId, [
        first,
        { ...second, ...duplicate },
      ]),
    ).toThrow("PROFESSION_V6_TARGET_SET_DUPLICATED");
  });
});
