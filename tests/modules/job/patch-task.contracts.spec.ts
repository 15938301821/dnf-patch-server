/**
 * @fileoverview 验证Worker单技能passed DTO严格区分V5单模型输出与V6逐帧目标集合；
 * 不连接Controller、Service、MySQL或对象存储。
 * @module modules/job/patch-task-contracts-spec
 * @author AI生成
 * @created 2026-08-01
 * @relatedPlan N/A - 用户直接要求实现Profession V6
 *
 * 调用关系：Vitest直接解析HTTP入口使用的Zod schema。输入是内存对象，输出是parse结果。
 * 副作用：无。安全边界：同为passed的两个代际不能互相吞掉未知字段，V6输出与manifest必须互异。
 */
import { describe, expect, it } from "vitest";
import { reportPatchTaskSkillProductionSchema } from "../../../src/modules/job/patch-task.contracts.js";

const lease = {
  workerId: "11111111-1111-4111-8111-111111111111",
  leaseId: "22222222-2222-4222-8222-222222222222",
  attempt: 2,
  skillId: "33333333-3333-4333-8333-333333333333",
};
const output = {
  asepriteBinarySha256: "A".repeat(64),
  asepriteAdapterSha256: "B".repeat(64),
  asepriteArtifactId: "44444444-4444-4444-8444-444444444444",
  validationArtifactId: "55555555-5555-4555-8555-555555555555",
  sourcePreviewArtifactId: "66666666-6666-4666-8666-666666666666",
  resultPreviewArtifactId: "77777777-7777-4777-8777-777777777777",
};
const v6TargetSet = {
  targetFrameManifestArtifactId: "88888888-8888-4888-8888-888888888888",
  targetFrameManifestSha256: "C".repeat(64),
  targetSetSha256: "D".repeat(64),
  targetFrameCount: 211,
};

describe("reportPatchTaskSkillProductionSchema", () => {
  it("accepts explicit V5 and V6 passed reports", () => {
    expect(
      reportPatchTaskSkillProductionSchema.parse({
        ...lease,
        ...output,
        status: "passed",
        productionContractVersion: 5,
      }),
    ).toMatchObject({ productionContractVersion: 5 });
    expect(
      reportPatchTaskSkillProductionSchema.parse({
        ...lease,
        ...output,
        ...v6TargetSet,
        status: "passed",
        productionContractVersion: 6,
      }),
    ).toMatchObject({
      productionContractVersion: 6,
      targetFrameCount: 211,
    });
  });

  it("rejects V5 reports that smuggle V6 target-set fields", () => {
    expect(
      reportPatchTaskSkillProductionSchema.safeParse({
        ...lease,
        ...output,
        ...v6TargetSet,
        status: "passed",
        productionContractVersion: 5,
      }).success,
    ).toBe(false);
  });

  it("rejects incomplete V6 reports and reused manifest Artifacts", () => {
    const incomplete: Record<string, unknown> = { ...v6TargetSet };
    delete incomplete.targetSetSha256;
    expect(
      reportPatchTaskSkillProductionSchema.safeParse({
        ...lease,
        ...output,
        ...incomplete,
        status: "passed",
        productionContractVersion: 6,
      }).success,
    ).toBe(false);
    expect(
      reportPatchTaskSkillProductionSchema.safeParse({
        ...lease,
        ...output,
        ...v6TargetSet,
        status: "passed",
        productionContractVersion: 6,
        targetFrameManifestArtifactId: output.asepriteArtifactId,
      }).success,
    ).toBe(false);
  });
});
